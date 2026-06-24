/* ============================================================
   Reading Quest — app.js
   Local-first reading tracker for Summer 1 (one child).

   Architecture
   ------------
   - Source of truth: an append-only EVENT log in IndexedDB.
     Every metric, streak, point, and badge is DERIVED from events.
     Restore = replace events + recompute. Nothing derived is stored.
   - CONFIG (books, target date, sheet URL) lives in a separate kv store.
   - QUESTIONS load from questions-summer1.json at startup and degrade
     gracefully when the file is absent or empty (v.1 ships empty).

   Three independent signals (never overloaded onto one another):
     pages   -> analytics            (page_log events)
     units   -> progress + unlocks   (unit_complete events)
     15-min  -> streak               (read_day events)
   ============================================================ */
(() => {
"use strict";

/* ---------- tiny helpers ---------- */
const $  = (s, r=document) => r.querySelector(s);
const el = (h) => { const t=document.createElement("template"); t.innerHTML=h.trim(); return t.content.firstElementChild; };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const esc = (s="") => String(s).replace(/[&<>"']/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
const pad = (n) => String(n).padStart(2,"0");
const todayKey = () => dayKey(new Date());
function dayKey(d){ d = (d instanceof Date) ? d : new Date(d); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function parseKey(k){ const [y,m,dd]=k.split("-").map(Number); return new Date(y, m-1, dd); }
function daysBetween(aKey, bKey){ return Math.round((parseKey(bKey) - parseKey(aKey)) / 86400000); }
function prettyDate(k){ return parseKey(k).toLocaleDateString(undefined,{month:"short",day:"numeric"}); }

/* ---------- defaults (editable in Settings) ---------- */
const SCHEMA = 1;
const year = new Date().getFullYear();
function defaultConfig(){
  return {
    schemaVersion: SCHEMA,
    startDate:  `${year}-06-01`,
    targetDate: `${year}-08-15`,
    sheetUrl: "",
    points: { read: 5, unit: 10, book: 50, discussion: 25 },
    books: [
      { id:"hobbit",  title:"The Hobbit",                       author:"J.R.R. Tolkien",        type:"page", pages:300, tone:0 },
      { id:"bronze",  title:"The Bronze Bow",                   author:"Elizabeth George Speare",type:"page", pages:254, tone:1 },
      { id:"lww",     title:"The Lion, the Witch and the Wardrobe", author:"C.S. Lewis",        type:"page", pages:200, tone:2 },
      { id:"aesop",   title:"Aesop's Fables",                   author:"Aesop (complete)",      type:"completion", tone:3,
        units:[ {id:"a1",label:"Fables — set 1"},{id:"a2",label:"Fables — set 2"},{id:"a3",label:"Fables — set 3"},
                {id:"a4",label:"Fables — set 4"},{id:"a5",label:"Fables — set 5"},{id:"a6",label:"Fables — set 6"},
                {id:"a7",label:"Fables — set 7"},{id:"a8",label:"Fables — set 8"} ] },
      { id:"psalms",  title:"Psalms — Selections",              author:"Robert Alter translation", type:"completion", tone:4,
        units:[ {id:"p1",label:"Psalm 1"},{id:"p8",label:"Psalm 8"},{id:"p19",label:"Psalm 19"},{id:"p22",label:"Psalm 22"},
                {id:"p23",label:"Psalm 23"},{id:"p46",label:"Psalm 46"},{id:"p90",label:"Psalm 90"},{id:"p139",label:"Psalm 139"} ] }
    ]
  };
}

/* ---------- IndexedDB ---------- */
let _db;
function openDB(){
  return new Promise((res, rej) => {
    const r = indexedDB.open("readingquest", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if(!db.objectStoreNames.contains("events")) db.createObjectStore("events",{ keyPath:"id" });
      if(!db.objectStoreNames.contains("kv"))     db.createObjectStore("kv");
    };
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  });
}
function tx(store, mode="readonly"){ return _db.transaction(store, mode).objectStore(store); }
const idbAllEvents = () => new Promise((res,rej)=>{ const q=tx("events").getAll(); q.onsuccess=()=>res(q.result||[]); q.onerror=()=>rej(q.error); });
const idbPutEvent  = (e) => new Promise((res,rej)=>{ const q=tx("events","readwrite").put(e); q.onsuccess=()=>res(); q.onerror=()=>rej(q.error); });
const idbDelEvent  = (id)=> new Promise((res,rej)=>{ const q=tx("events","readwrite").delete(id); q.onsuccess=()=>res(); q.onerror=()=>rej(q.error); });
const idbClear     = (s) => new Promise((res,rej)=>{ const q=tx(s,"readwrite").clear(); q.onsuccess=()=>res(); q.onerror=()=>rej(q.error); });
const idbGetKV     = (k) => new Promise((res,rej)=>{ const q=tx("kv").get(k); q.onsuccess=()=>res(q.result); q.onerror=()=>rej(q.error); });
const idbPutKV     = (k,v)=> new Promise((res,rej)=>{ const q=tx("kv","readwrite").put(v,k); q.onsuccess=()=>res(); q.onerror=()=>rej(q.error); });

/* ---------- in-memory state ---------- */
let CONFIG, EVENTS=[], QUESTIONS=null, SCREEN="books";
const book = (id) => CONFIG.books.find(b => b.id === id);

async function persistConfig(){ await idbPutKV("config", CONFIG); }
async function addEvent(ev){
  ev.id = uid(); ev.createdAt = Date.now();
  EVENTS.push(ev);
  await idbPutEvent(ev);
  pushToSheet(ev);
}
async function removeEvent(id){
  EVENTS = EVENTS.filter(e=>e.id!==id);
  await idbDelEvent(id);
}

/* ============================================================
   DERIVATIONS  (everything below is computed from EVENTS+CONFIG)
   ============================================================ */
const pageBooks  = () => CONFIG.books.filter(b=>b.type==="page");
const compBooks  = () => CONFIG.books.filter(b=>b.type==="completion");
// latest explicit status the reader set for a book: "complete", "reopened", or null
function latestStatus(id){
  const st = EVENTS.filter(e=>e.type==="book_status" && e.bookId===id).sort((a,b)=>a.createdAt-b.createdAt);
  if(!st.length) return null;
  return st[st.length-1].complete ? "complete" : "reopened";
}

// latest end page per page-book
function latestPage(id){
  const logs = EVENTS.filter(e=>e.type==="page_log" && e.bookId===id);
  return logs.length ? Math.max(...logs.map(e=>e.endPage)) : 0;
}
function bookProgress(b){
  if(b.type==="page"){
    const done = Math.min(latestPage(b.id), b.pages);
    const status = latestStatus(b.id);
    const auto = b.pages>0 && latestPage(b.id) >= b.pages;
    const complete = status==="reopened" ? false : (auto || status==="complete");
    return { done, total:b.pages, pct: b.pages? done/b.pages : 0, complete, unit:"pp" };
  } else {
    const total = b.units.length;
    const doneIds = new Set(EVENTS.filter(e=>e.type==="unit_complete" && e.bookId===b.id).map(e=>e.unitId));
    const done = [...doneIds].filter(u=>b.units.some(x=>x.id===u)).length;
    const status = latestStatus(b.id);
    const allDone = total>0 && done>=total;
    const complete = status==="reopened" ? false : (allDone || status==="complete");
    return { done, total, pct: total? done/total : 0, complete, unit:"units", doneIds };
  }
}

// daily page deltas across all page-books -> Map(dayKey -> pages)
function dailyPageMap(){
  const map = new Map();
  for(const b of pageBooks()){
    // collapse to one end-page per day (max), then take chronological deltas
    const byDay = new Map();
    EVENTS.filter(e=>e.type==="page_log"&&e.bookId===b.id)
          .forEach(e=>{ byDay.set(e.date, Math.max(byDay.get(e.date)||0, e.endPage)); });
    const days = [...byDay.keys()].sort();
    let prev = 0;
    for(const d of days){
      const end = Math.min(byDay.get(d), b.pages || byDay.get(d));
      const delta = Math.max(0, end - prev);
      map.set(d, (map.get(d)||0) + delta);
      prev = Math.max(prev, end);
    }
  }
  return map;
}

function pageMetrics(){
  const dmap = dailyPageMap();
  const activeDays = [...dmap.keys()].filter(k=>dmap.get(k)>0);
  const totalRead  = [...dmap.values()].reduce((a,b)=>a+b,0);
  const totalPages = pageBooks().reduce((a,b)=>a+(b.pages||0),0);
  const done       = pageBooks().reduce((a,b)=>a+bookProgress(b).done,0);
  const remaining  = Math.max(0, totalPages - done);
  const avg        = activeDays.length ? totalRead/activeDays.length : 0;
  const today      = todayKey();
  const daysToTarget = Math.max(0, daysBetween(today, CONFIG.targetDate));

  const projectedDays = avg>0 ? Math.ceil(remaining/avg) : null;
  const projectedDate = projectedDays!=null ? dayKey(new Date(Date.now()+projectedDays*86400000)) : null;
  const perDayToTarget = remaining===0 ? 0 : (daysToTarget>0 ? Math.ceil(remaining/daysToTarget) : remaining);

  return { dmap, activeDays, totalRead, totalPages, done, remaining, avg,
           projectedDate, perDayToTarget, daysToTarget, pct: totalPages? done/totalPages:0 };
}

function compMetrics(){
  const books = compBooks();
  const total = books.reduce((a,b)=>a+b.units.length,0);
  const done  = books.reduce((a,b)=>a+bookProgress(b).done,0);
  const remaining = Math.max(0,total-done);
  const evs = EVENTS.filter(e=>e.type==="unit_complete");
  const activeDays = new Set(evs.map(e=>e.date)).size;
  const perDay = activeDays ? done/activeDays : 0;
  const projDays = perDay>0 ? Math.ceil(remaining/perDay) : null;
  const projDate = projDays!=null ? dayKey(new Date(Date.now()+projDays*86400000)) : null;
  return { total, done, remaining, perDay, projDate, pct: total? done/total:0 };
}

// streak: consecutive days ending today/yesterday that have a read_day event
function streakInfo(){
  const set = new Set(EVENTS.filter(e=>e.type==="read_day").map(e=>e.date));
  const today = todayKey();
  const includesToday = set.has(today);
  let cursor = includesToday ? today : dayKey(new Date(Date.now()-86400000));
  if(!set.has(cursor)) return { count:0, includesToday:false };
  let count=0;
  while(set.has(cursor)){ count++; cursor = dayKey(new Date(parseKey(cursor).getTime()-86400000)); }
  return { count, includesToday };
}

function totalPoints(){
  const p = CONFIG.points;
  const reads = EVENTS.filter(e=>e.type==="read_day").length;
  const units = EVENTS.filter(e=>e.type==="unit_complete").length;
  const disc  = EVENTS.filter(e=>e.type==="discussion_done").length;
  const booksDone = CONFIG.books.filter(b=>bookProgress(b).complete).length;
  return reads*p.read + units*p.unit + disc*p.discussion + booksDone*p.book;
}

function badges(){
  const s = streakInfo().count;
  const longest = (()=>{ // longest historical run
    const days=[...new Set(EVENTS.filter(e=>e.type==="read_day").map(e=>e.date))].sort();
    let best=0,run=0,prev=null;
    for(const d of days){ run = (prev && daysBetween(prev,d)===1)? run+1 : 1; best=Math.max(best,run); prev=d; }
    return best;
  })();
  const discCount = EVENTS.filter(e=>e.type==="discussion_done").length;
  const list = [
    { id:"first",  name:"First Steps", glyph:"&#10003;", earned: EVENTS.some(e=>e.type==="read_day") },
    { id:"kindled",name:"Kindled",     glyph:"3",        earned: Math.max(s,longest)>=3 },
    { id:"steady", name:"Steadfast",   glyph:"7",        earned: Math.max(s,longest)>=7 },
    { id:"unbroken",name:"Unbroken",   glyph:"14",       earned: Math.max(s,longest)>=14 },
    { id:"disput", name:"Disputant",   glyph:"?",        earned: discCount>=1 },
    { id:"examined",name:"Examined",   glyph:"&#9670;",  earned: discCount>=5 },
  ];
  for(const b of CONFIG.books){
    list.push({ id:"done-"+b.id, name:"Finished "+shortTitle(b), glyph:"&#9733;", earned: bookProgress(b).complete });
  }
  list.push({ id:"all", name:"There & Back Again", glyph:"&#9650;",
              earned: CONFIG.books.every(b=>bookProgress(b).complete) });
  return list;
}
function shortTitle(b){ return b.title.split(/[—–-]/)[0].replace(/^The /,"").trim().split(" ").slice(0,2).join(" "); }

/* ============================================================
   RENDER
   ============================================================ */
function renderHeader(){
  $("#streak-val").textContent = streakInfo().count;
  $("#points-val").textContent = totalPoints();
}

function setScreen(name){
  SCREEN = name;
  document.querySelectorAll(".tab").forEach(t=>t.setAttribute("aria-selected", String(t.dataset.screen===name)));
  render();
}
function render(){
  renderHeader();
  const root = $("#screen"); root.scrollTop = 0;
  root.innerHTML = "";
  ({ books:renderBooks, trends:renderTrends, discuss:renderDiscuss, settings:renderSettings }[SCREEN] || renderBooks)(root);
}

/* ----- Books ----- */
function renderBooks(root){
  const today = todayKey();
  const readToday = EVENTS.some(e=>e.type==="read_day" && e.date===today);
  const pm = pageMetrics();
  const todayPages = pm.dmap.get(today) || 0;
  const todayUnits = EVENTS.filter(e=>e.type==="unit_complete" && e.date===today).length;

  root.appendChild(el(`<h1 class="screen-title">Today's reading</h1>`));
  root.appendChild(el(`<p class="screen-sub">Log where you ended, check off what you finished, and mark the days you read.</p>`));

  const rt = el(`
    <button class="readtoday ${readToday?'done':''}" id="readtoday-btn">
      <span class="rt-left">
        <span class="rt-title">${readToday?'Read today &#10003;':'I read today'}</span>
        <span class="rt-sub">${readToday?'Streak is safe. Tap to undo.':'15 minutes or more keeps the streak alive'}</span>
      </span>
      <span class="rt-badge">${readToday?'Done':'Mark it'}</span>
    </button>`);
  root.appendChild(rt);

  root.appendChild(el(`
    <div class="today-summary">
      <div class="ts"><b>${todayPages}</b><span>PAGES TODAY</span></div>
      <div class="ts"><b>${todayUnits}</b><span>FINISHED TODAY</span></div>
      <div class="ts"><b>${streakInfo().count}</b><span>DAY STREAK</span></div>
    </div>`));

  root.appendChild(el(`<div class="eyebrow">Your books</div>`));
  for(const b of CONFIG.books){
    const p = bookProgress(b);
    const meta = b.type==="page"
      ? `${p.done} / ${p.total} pp`
      : `${p.done} / ${p.total} finished`;
    const node = el(`
      <button class="book ${p.complete?'is-complete':''}" data-book="${b.id}">
        <span class="book-spine tone-${b.tone%5}"></span>
        <span class="book-body">
          <span class="book-title">${esc(b.title)}</span>
          <span class="book-author">${esc(b.author)}</span>
          <span class="book-meta">${meta}</span>
          ${p.complete?'' : `<span class="book-bar"><i style="width:${Math.round(p.pct*100)}%"></i></span>`}
        </span>
        ${p.complete ? `<span class="book-check">&#10003;</span>` : `<span class="book-cta">Log &rsaquo;</span>`}
      </button>`);
    root.appendChild(node);
  }
}

/* ----- Trends ----- */
function renderTrends(root){
  const pm = pageMetrics();
  const cm = compMetrics();

  root.appendChild(el(`<h1 class="screen-title">The road so far</h1>`));
  root.appendChild(el(`<p class="screen-sub">Two journeys, one finish line — pages on one path, finished readings on the other.</p>`));

  // signature: pace trail
  root.appendChild(journeyCard(pm));

  // page metrics
  root.appendChild(el(`<div class="eyebrow">Pages — The Hobbit, Bronze Bow, Lewis</div>`));
  const behind = pm.avg>0 && pm.projectedDate && daysBetween(pm.projectedDate, CONFIG.targetDate) < 0;
  root.appendChild(el(`
    <div class="metric-grid">
      <div class="metric"><div class="m-val">${Math.round(pm.avg)}</div><div class="m-label">Avg pages / reading day</div></div>
      <div class="metric"><div class="m-val">${Math.round(pm.pct*100)}%</div><div class="m-label">Of all pages read</div></div>
      <div class="metric"><div class="m-val ${behind?'warn':''}">${pm.projectedDate?prettyDate(pm.projectedDate):'—'}</div><div class="m-label">Finish date at this pace</div></div>
      <div class="metric"><div class="m-val">${pm.perDayToTarget}</div><div class="m-label">Pages / day to finish by ${prettyDate(CONFIG.targetDate)}</div></div>
    </div>`));

  // completion metrics
  if(compBooks().length){
    root.appendChild(el(`<div class="eyebrow">Finished readings — Aesop &amp; Psalms</div>`));
    root.appendChild(el(`
      <div class="metric-grid">
        <div class="metric"><div class="m-val">${cm.done}/${cm.total}</div><div class="m-label">Readings finished</div></div>
        <div class="metric"><div class="m-val">${Math.round(cm.pct*100)}%</div><div class="m-label">Of all readings done</div></div>
        <div class="metric"><div class="m-val">${cm.projDate?prettyDate(cm.projDate):'—'}</div><div class="m-label">Finish date at this pace</div></div>
        <div class="metric"><div class="m-val">${(cm.perDay).toFixed(1)}</div><div class="m-label">Readings / active day</div></div>
      </div>`));
  }

  // badges
  root.appendChild(el(`<div class="eyebrow">Milestones</div>`));
  const grid = el(`<div class="badges"></div>`);
  for(const bd of badges()){
    grid.appendChild(el(`
      <div class="badge ${bd.earned?'':'locked'}">
        <div class="b-seal">${bd.glyph}</div>
        <div class="b-name">${esc(bd.name)}</div>
      </div>`));
  }
  root.appendChild(grid);
}

function journeyCard(pm){
  const today = todayKey();
  const span = Math.max(1, daysBetween(CONFIG.startDate, CONFIG.targetDate));
  const elapsed = Math.min(span, Math.max(0, daysBetween(CONFIG.startDate, today)));
  const idealFrac = elapsed/span;                 // where you'd be if perfectly paced
  const actualFrac = pm.totalPages ? pm.done/pm.totalPages : 0;
  const ahead = actualFrac >= idealFrac - 0.001;

  const W=320, H=92, padX=18, top=46;
  const x = f => padX + f*(W-2*padX);
  const accent = ahead ? "var(--gold)" : "var(--oxblood)";

  const svg = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress toward the summer goal">
      <line x1="${x(0)}" y1="${top}" x2="${x(1)}" y2="${top}" stroke="var(--line)" stroke-width="6" stroke-linecap="round"/>
      <line x1="${x(0)}" y1="${top}" x2="${x(actualFrac)}" y2="${top}" stroke="url(#road)" stroke-width="6" stroke-linecap="round"/>
      <defs><linearGradient id="road" x1="0" x2="1"><stop offset="0" stop-color="#2F5247"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs>
      <!-- ideal pace marker -->
      <line x1="${x(idealFrac)}" y1="${top-12}" x2="${x(idealFrac)}" y2="${top+12}" stroke="var(--ink-faint)" stroke-width="2" stroke-dasharray="3 3"/>
      <text x="${x(idealFrac)}" y="${top+26}" text-anchor="middle" font-size="9" fill="var(--ink-faint)">on pace</text>
      <!-- start / goal -->
      <circle cx="${x(0)}" cy="${top}" r="5" fill="#2F5247"/>
      <text x="${x(0)}" y="${top-14}" font-size="10" fill="var(--ink-soft)">${prettyDate(CONFIG.startDate)}</text>
      <circle cx="${x(1)}" cy="${top}" r="6" fill="var(--card)" stroke="var(--gold)" stroke-width="2.5"/>
      <text x="${x(1)}" y="${top-14}" text-anchor="end" font-size="10" fill="var(--ink-soft)">${prettyDate(CONFIG.targetDate)}</text>
      <!-- you -->
      <g transform="translate(${x(actualFrac)},${top})">
        <circle r="8" fill="${accent}"/><circle r="3.4" fill="#fff"/>
      </g>
    </svg>`;

  const gap = Math.round((actualFrac-idealFrac)*100);
  const flag = ahead
    ? `<div class="pace-flag ahead">&#9650; On pace${gap>2?` — ${gap}% ahead`:''}</div>`
    : `<div class="pace-flag behind">&#9660; ${Math.abs(gap)}% behind pace — a little more each day</div>`;

  return el(`<div class="journey">
    <h3>Road to ${prettyDate(CONFIG.targetDate)}</h3>
    <p class="j-sub">${pm.done} of ${pm.totalPages} pages &middot; ${pm.remaining} to go</p>
    ${svg}${flag}
  </div>`);
}

/* ----- Discuss ----- */
function renderDiscuss(root){
  root.appendChild(el(`<h1 class="screen-title">Disputatio</h1>`));
  root.appendChild(el(`<p class="screen-sub">When a section opens a question, talk it through with a parent — make the strongest case for the hard side first, then answer it. Mark it done to earn points.</p>`));

  const hasQs = QUESTIONS && Array.isArray(QUESTIONS.questions) && QUESTIONS.questions.length;

  if(hasQs){
    for(const q of QUESTIONS.questions){
      const b = book(q.bookId);
      const unlocked = isQuestionUnlocked(q);
      const done = EVENTS.some(e=>e.type==="discussion_done" && e.qId===q.id);
      root.appendChild(el(`
        <div class="qcard ${unlocked?'':'locked'}">
          <div class="q-book">${esc(b?shortTitle(b):q.bookId)} &middot; ${esc(q.section||'')}</div>
          <div class="q-text">${unlocked?esc(q.question):'Locked — keep reading to open this question'}</div>
          ${unlocked&&q.note?`<div class="q-note">${esc(q.note)}</div>`:''}
          <div class="q-foot">
            ${unlocked
              ? (done ? `<span class="q-lock">Discussed &#10003;</span>`
                      : `<button class="btn gold sm" data-discuss-q="${q.id}">Mark discussed</button>`)
              : `<span class="q-lock">&#128274; opens later</span>`}
          </div>
        </div>`));
    }
    return;
  }

  // Empty state (v.1): questions not loaded yet, but reward the off-device conversation by book.
  root.appendChild(el(`
    <div class="disc-empty card">
      <div class="de-mark">&#9670;</div>
      <strong>Section questions aren't loaded yet.</strong>
      <p style="margin:8px 0 0">They'll appear here once <code>questions-summer1.json</code> is added to the app. Until then, when you finish a good chunk of a book, sit down with a parent and talk it over — then log it below.</p>
    </div>`));
  root.appendChild(el(`<div class="eyebrow">Log a discussion</div>`));
  for(const b of CONFIG.books){
    const count = EVENTS.filter(e=>e.type==="discussion_done" && e.bookId===b.id).length;
    root.appendChild(el(`
      <div class="qcard">
        <div class="q-book">${esc(shortTitle(b))}</div>
        <div class="q-foot" style="margin-top:6px">
          <span class="q-lock">${count} discussion${count===1?'':'s'} logged</span>
          <button class="btn gold sm" data-discuss-book="${b.id}">+ Log discussion</button>
        </div>
      </div>`));
  }
}
function isQuestionUnlocked(q){
  const b = book(q.bookId); if(!b) return false;
  const p = bookProgress(b);
  if(q.unlockAtPage != null)  return latestPage(b.id) >= q.unlockAtPage;
  if(q.unlockAtUnit != null)  return p.doneIds && p.doneIds.has(q.unlockAtUnit);
  if(q.unlockAtPct  != null)  return p.pct*100 >= q.unlockAtPct;
  return true; // no rule -> always available
}

/* ----- Settings ----- */
function renderSettings(root){
  root.appendChild(el(`<h1 class="screen-title">Settings</h1>`));
  root.appendChild(el(`<p class="screen-sub">Set the finish line, the page counts, and back up the data.</p>`));

  root.appendChild(el(`<div class="eyebrow">The summer</div>`));
  root.appendChild(el(`
    <div class="card" style="padding:16px">
      <div class="row">
        <div class="field"><label>Start date</label><input type="date" id="cfg-start" value="${CONFIG.startDate}"></div>
        <div class="field"><label>Finish by</label><input type="date" id="cfg-target" value="${CONFIG.targetDate}"></div>
      </div>
    </div>`));

  root.appendChild(el(`<div class="eyebrow">Books &amp; page counts</div>`));
  const wrap = el(`<div></div>`);
  for(const b of CONFIG.books){
    const sb = el(`<div class="setting-book" data-cfg-book="${b.id}">
      <div class="sb-head"><span class="sb-title">${esc(b.title)}</span>
        <span class="book-cta" style="text-transform:capitalize">${b.type}</span></div>
      ${ b.type==="page"
        ? `<div class="field" style="margin:0"><label>Total pages (this edition)</label>
             <input type="number" inputmode="numeric" min="1" data-cfg-pages value="${b.pages}"></div>`
        : `<div class="hint" style="margin-bottom:8px">Finished one at a time — no page count.</div>
           ${b.units.map(u=>`<div class="unit-row"><input data-unit-id="${u.id}" value="${esc(u.label)}"></div>`).join("")}`
      }
    </div>`);
    wrap.appendChild(sb);
  }
  root.appendChild(wrap);
  root.appendChild(el(`<button class="btn full" id="cfg-save" style="margin-top:6px">Save settings</button>`));

  // backup
  root.appendChild(el(`<div class="eyebrow">Backup &amp; restore</div>`));
  root.appendChild(el(`
    <div class="card" style="padding:16px">
      <p class="screen-sub" style="margin:0 0 14px">Your reading lives only on this iPad. Export a file every week or so — that file can rebuild everything if data is ever lost.</p>
      <div class="row" style="margin-bottom:10px">
        <button class="btn" id="export-json">Export backup</button>
        <button class="btn ghost" id="import-json">Restore from file</button>
      </div>
      <input type="file" id="import-file" accept="application/json,.json" hidden>
      <div class="field" style="margin:6px 0 0">
        <label>Google Sheet log (optional, secondary backup)</label>
        <input id="cfg-sheet" placeholder="Apps Script web-app URL" value="${esc(CONFIG.sheetUrl)}">
        <div class="hint">Every entry also posts here for parent oversight. See README for the one-time setup.</div>
      </div>
      <button class="btn ghost sm" id="sheet-syncall" style="margin-top:10px">Re-send everything to the Sheet</button>
    </div>`));

  // recent entries (correction path)
  root.appendChild(el(`<div class="eyebrow">Recent entries</div>`));
  const recent = [...EVENTS].sort((a,b)=>b.createdAt-a.createdAt).slice(0,20);
  if(!recent.length){ root.appendChild(el(`<p class="screen-sub">Nothing logged yet.</p>`)); }
  else {
    const ul = el(`<ul class="recent card" style="padding:4px 14px"></ul>`);
    for(const e of recent){
      ul.appendChild(el(`<li>
        <span>${esc(describeEvent(e))}<div class="r-meta">${prettyDate(e.date)}</div></span>
        <button class="btn danger sm" data-del="${e.id}">Delete</button>
      </li>`));
    }
    root.appendChild(ul);
  }

  root.appendChild(el(`<div class="eyebrow">Danger zone</div>`));
  root.appendChild(el(`<button class="btn danger full" id="wipe">Erase all data</button>`));
  root.appendChild(el(`<p class="screen-sub" style="text-align:center;margin-top:18px;color:var(--ink-faint)">Reading Quest &middot; Summer I &middot; v1.0</p>`));
}

function describeEvent(e){
  const b = book(e.bookId);
  switch(e.type){
    case "page_log":        return `${b?shortTitle(b):e.bookId} — to page ${e.endPage}${e.preTracking?' (backfill)':''}`;
    case "unit_complete":   return `${b?shortTitle(b):e.bookId} — finished a reading`;
    case "read_day":        return `Read today (15+ min)`;
    case "discussion_done": return `Discussion logged${b?` — ${shortTitle(b)}`:''}`;
    case "book_status":     return `${b?shortTitle(b):e.bookId} — marked ${e.complete?'complete':'unfinished'}`;
    default: return e.type;
  }
}

/* ============================================================
   SHEETS (sheet host) + interactions
   ============================================================ */
function openSheet(html){ $("#sheet").innerHTML = `<div class="grabber"></div>`+html; $("#sheet-host").hidden=false; }
function closeSheet(){ $("#sheet-host").hidden=true; $("#sheet").innerHTML=""; }
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(t._t); t._t=setTimeout(()=>t.hidden=true,1900); }

function openBookSheet(b){
  const p = bookProgress(b);
  if(b.type==="page"){
    openSheet(`
      <h3>${esc(b.title)}</h3>
      <p class="sheet-sub">Currently at page ${p.done} of ${b.pages}.</p>
      <div class="field"><label>Ended on page</label>
        <input type="number" inputmode="numeric" id="sheet-endpage" min="0" max="${b.pages}" value="${p.done||''}" placeholder="e.g. 84"></div>
      <div class="field"><label>Date</label><input type="date" id="sheet-date" value="${todayKey()}"></div>
      <label class="inline-toggle"><input type="checkbox" id="sheet-pre"> I read this before I started tracking (won't affect streak)</label>
      <div class="row" style="margin-top:8px">
        <button class="btn full" id="sheet-savepage">Save</button>
      </div>
      ${p.complete
        ? `<button class="btn ghost full sm" id="sheet-reopen" style="margin-top:10px">Mark as unfinished</button>`
        : `<button class="btn ghost full sm" id="sheet-complete" style="margin-top:10px">Mark finished now</button>`}
    `);
    $("#sheet-savepage").onclick = async () => {
      const v = parseInt($("#sheet-endpage").value,10);
      if(isNaN(v)||v<0){ toast("Enter a page number"); return; }
      await addEvent({ type:"page_log", bookId:b.id, endPage:Math.min(v,b.pages),
                       date:$("#sheet-date").value||todayKey(), preTracking:$("#sheet-pre").checked });
      closeSheet(); render(); toast(`Saved — page ${Math.min(v,b.pages)}`);
    };
    const c=$("#sheet-complete"); if(c) c.onclick = async()=>{ await addEvent({type:"book_status",bookId:b.id,complete:true,date:todayKey()}); closeSheet(); render(); toast("Marked finished"); };
    const r=$("#sheet-reopen");   if(r) r.onclick   = async()=>{ await addEvent({type:"book_status",bookId:b.id,complete:false,date:todayKey()}); closeSheet(); render(); toast("Reopened"); };
  } else {
    const done = p.doneIds;
    openSheet(`
      <h3>${esc(b.title)}</h3>
      <p class="sheet-sub">Check off each reading as you finish it. ${p.done} of ${p.total} done.</p>
      ${b.units.map(u=>`
        <label class="inline-toggle" style="border-bottom:1px solid var(--line-soft)">
          <input type="checkbox" data-unit="${u.id}" ${done.has(u.id)?'checked':''}>
          <span style="flex:1">${esc(u.label)}</span>
        </label>`).join("")}
      <div class="field" style="margin-top:14px"><label>Date for newly checked</label><input type="date" id="sheet-udate" value="${todayKey()}"></div>
      <button class="btn full" id="sheet-saveunits" style="margin-top:4px">Done</button>
    `);
    $("#sheet-saveunits").onclick = async () => {
      const date = $("#sheet-udate").value || todayKey();
      const checks = [...$("#sheet").querySelectorAll("[data-unit]")];
      for(const c of checks){
        const uId = c.dataset.unit, has = done.has(uId);
        if(c.checked && !has){ await addEvent({type:"unit_complete",bookId:b.id,unitId:uId,date}); }
        if(!c.checked && has){ // uncheck = remove its completion events
          for(const ev of EVENTS.filter(e=>e.type==="unit_complete"&&e.bookId===b.id&&e.unitId===uId)) await removeEvent(ev.id);
        }
      }
      closeSheet(); render(); toast("Updated");
    };
  }
}

/* ---------- Google Sheet POST (fire-and-forget, no-cors) ---------- */
function pushToSheet(ev){
  if(!CONFIG.sheetUrl) return;
  try{
    fetch(CONFIG.sheetUrl, { method:"POST", mode:"no-cors",
      headers:{ "Content-Type":"text/plain;charset=utf-8" },
      body: JSON.stringify({ ...ev, child:"summer1" }) });
  }catch(_){ /* local-first: never block on the network */ }
}
async function syncAllToSheet(){
  if(!CONFIG.sheetUrl){ toast("Add a Sheet URL first"); return; }
  for(const ev of EVENTS) pushToSheet(ev);
  toast(`Re-sent ${EVENTS.length} entries`);
}

/* ---------- JSON backup ---------- */
function exportJSON(){
  const blob = new Blob([JSON.stringify({ schemaVersion:SCHEMA, exportedAt:new Date().toISOString(), config:CONFIG, events:EVENTS }, null, 2)],
                        { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `reading-quest-backup-${todayKey()}.json`;
  a.click(); URL.revokeObjectURL(a.href);
  toast("Backup downloaded");
}
function importJSON(file){
  const fr = new FileReader();
  fr.onload = async () => {
    let data; try{ data = JSON.parse(fr.result); }catch{ toast("That file isn't valid backup JSON"); return; }
    if(!data || typeof data!=="object" || !Array.isArray(data.events)){ toast("Backup file is missing its entries"); return; }
    if(data.schemaVersion && data.schemaVersion>SCHEMA){ toast("This backup is from a newer version"); return; }
    if(!confirm("Restore will REPLACE everything currently in the app with this backup. Continue?")) return;
    await idbClear("events");
    EVENTS = [];
    for(const e of data.events){ if(!e.id) e.id=uid(); EVENTS.push(e); await idbPutEvent(e); }
    if(data.config){ CONFIG = { ...defaultConfig(), ...data.config }; await persistConfig(); }
    render(); toast(`Restored ${EVENTS.length} entries`);
  };
  fr.readAsText(file);
}

/* ---------- questions ---------- */
async function loadQuestions(){
  try{
    const res = await fetch("questions-summer1.json", { cache:"no-cache" });
    if(!res.ok) return;
    const data = await res.json();
    if(data && (data.version==null || data.version<=SCHEMA)) QUESTIONS = data;
  }catch(_){ /* absent in v.1 — Discuss degrades gracefully */ }
}

/* ============================================================
   WIRING
   ============================================================ */
function wire(){
  // tabs
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", ()=>setScreen(t.dataset.screen)));
  document.querySelectorAll("[data-goto]").forEach(b => b.addEventListener("click", ()=>setScreen(b.dataset.goto)));
  // sheet close
  $("#sheet-host").addEventListener("click", e => { if(e.target.matches("[data-close-sheet]")) closeSheet(); });

  // delegated clicks on the screen
  $("#screen").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-book],[data-discuss-book],[data-discuss-q],[data-del],#readtoday-btn,#export-json,#import-json,#sheet-syncall,#cfg-save,#wipe");
    if(!t) return;

    if(t.id==="readtoday-btn"){
      const today=todayKey();
      const ex = EVENTS.find(e=>e.type==="read_day"&&e.date===today);
      if(ex){ await removeEvent(ex.id); toast("Streak un-marked"); }
      else  { await addEvent({type:"read_day",date:today}); toast("Nice — streak +1"); }
      render(); return;
    }
    if(t.dataset.book){ openBookSheet(book(t.dataset.book)); return; }
    if(t.dataset.discussBook){
      await addEvent({type:"discussion_done",bookId:t.dataset.discussBook,date:todayKey()});
      render(); toast(`Discussion logged +${CONFIG.points.discussion}`); return;
    }
    if(t.dataset.discussQ){
      const q = QUESTIONS.questions.find(x=>x.id===t.dataset.discussQ);
      await addEvent({type:"discussion_done",bookId:q.bookId,qId:q.id,date:todayKey()});
      render(); toast(`Discussed +${CONFIG.points.discussion}`); return;
    }
    if(t.dataset.del){ await removeEvent(t.dataset.del); render(); toast("Deleted"); return; }
    if(t.id==="export-json"){ exportJSON(); return; }
    if(t.id==="import-json"){ $("#import-file").click(); return; }
    if(t.id==="sheet-syncall"){ saveSettingsSilently(); syncAllToSheet(); return; }
    if(t.id==="cfg-save"){ await saveSettings(); return; }
    if(t.id==="wipe"){
      if(confirm("Erase ALL reading data on this device? Export a backup first if you might want it back.")){
        await idbClear("events"); EVENTS=[]; render(); toast("All data erased");
      } return;
    }
  });

  $("#screen").addEventListener("change", e => {
    if(e.target.id==="import-file" && e.target.files[0]) importJSON(e.target.files[0]);
  });
}

function readSettingsFromDOM(){
  const start=$("#cfg-start"), target=$("#cfg-target"), sheet=$("#cfg-sheet");
  if(start)  CONFIG.startDate  = start.value || CONFIG.startDate;
  if(target) CONFIG.targetDate = target.value || CONFIG.targetDate;
  if(sheet)  CONFIG.sheetUrl   = sheet.value.trim();
  document.querySelectorAll("[data-cfg-book]").forEach(node=>{
    const b = book(node.dataset.cfgBook); if(!b) return;
    const pg = node.querySelector("[data-cfg-pages]");
    if(pg && b.type==="page"){ const v=parseInt(pg.value,10); if(!isNaN(v)&&v>0) b.pages=v; }
    node.querySelectorAll("[data-unit-id]").forEach(inp=>{
      const u=b.units && b.units.find(x=>x.id===inp.dataset.unitId); if(u) u.label=inp.value;
    });
  });
}
function saveSettingsSilently(){ readSettingsFromDOM(); persistConfig(); }
async function saveSettings(){ readSettingsFromDOM(); await persistConfig(); render(); toast("Settings saved"); }

/* ============================================================
   BOOT
   ============================================================ */
async function boot(){
  try{
    _db = await openDB();
    CONFIG = await idbGetKV("config");
    if(!CONFIG){ CONFIG = defaultConfig(); await persistConfig(); }
    else { CONFIG = { ...defaultConfig(), ...CONFIG }; } // forward-fill new fields
    EVENTS = await idbAllEvents();
  }catch(err){
    document.getElementById("screen").innerHTML =
      `<div class="card" style="padding:18px;margin-top:20px"><h3 style="font-family:var(--display)">Storage is unavailable</h3>
       <p class="screen-sub">This app needs on-device storage, which Safari blocks in Private Browsing. Open it in a normal tab and add it to the Home Screen.</p></div>`;
    return;
  }
  await loadQuestions();
  wire();
  render();

  if("serviceWorker" in navigator){
    navigator.serviceWorker.register("sw.js").catch(()=>{});
  }
}
boot();
})();
