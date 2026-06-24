# Reading Quest — Summer I tracker

A local-first reading tracker built to run as a Safari home-screen app on an iPad,
hosted free on GitHub Pages. One child, Summer 1. No accounts, no server, works offline.

## What it does
- **Books** — log the page you ended on (Hobbit, Bronze Bow, Lewis) or check off finished
  readings (Aesop sets, Psalms). All books open at once; read several in parallel.
- **"I read today"** — one tap for 15+ minutes; drives the streak (separate from pages).
- **Trends** — avg pages/day, % complete, projected finish date, pages/day to hit your goal,
  plus the same four for finished readings, and a "road to the goal" pace trail + milestone badges.
- **Discuss** — disputatio questions unlock as sections are reached (loaded later from a JSON file);
  until then, log the conversations you have with a parent to earn points.
- **Settings** — page counts, start/finish dates, JSON backup + restore, optional Sheet sync.

## Three independent signals (by design)
- pages → analytics · finished readings → progress & question unlocks · 15-min tap → streak.
  None is derived from another, so none can corrupt the others.

## Deploy to GitHub Pages
1. Create a public repo, e.g. `reading-quest`.
2. Upload **all** files in this folder to the repo root
   (`index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `sw.js`,
   `icon.svg`, `icon-180.png`, `icon-512.png`, `questions-summer1.json`).
3. Repo → **Settings → Pages → Source: Deploy from a branch → main / root → Save**.
4. Wait ~1 min, then open `https://<you>.github.io/reading-quest/`.

## Add to the iPad home screen
1. Open the URL in **Safari** (not in-app browsers).
2. Share → **Add to Home Screen**. Launch it from the icon — it runs full-screen and offline.
   > Add to Home Screen once after the first load so the service worker has cached the shell.

## Back up & restore
- **Primary:** Settings → **Export backup** → a `.json` file (do this weekly). **Restore from file**
  replaces everything from that file.
- **Secondary (optional):** the Google Sheet. Set it up with `apps-script.gs`, paste the URL into
  Settings. Every entry posts there for oversight. (The app does not read the Sheet back —
  the JSON file is the restore path.)

## Backfilling a book already finished (e.g. The Hobbit)
Log it as several entries with **past dates** (the date field in the log sheet is editable).
Tick **"I read this before I started tracking"** so the pages still count toward progress and
pace but don't invent streak days. Spread the entries across a few dates to give the trend a
real curve instead of one spike.

## Adding the disputatio questions later
`questions-summer1.json` ships with one clearly-marked example. Replace the `questions` array
with your real set — one object per section:

```json
{ "id": "hobbit-ch5", "bookId": "hobbit", "section": "Chapter 5",
  "unlockAtPage": 90,
  "question": "…", "note": "what to listen for" }
```
Unlock each with **one** of `unlockAtPage` (page-books), `unlockAtUnit` (a unit id, e.g. `"p23"`),
or `unlockAtPct`. Commit the file and bump `CACHE` in `sw.js` so devices pick up the change.
Author the questions in your companion parent's guide first, then mirror them here.

## Tuning
Book list, page counts, dates, and point values live in `defaultConfig()` in `app.js`
(and most are editable in-app under Settings). Points: read day 5 · finished reading 10 ·
discussion 25 · finished book 50.

v1.0 — Summer I, one child. Built to extend to Summers II–VII by swapping the config + questions.
