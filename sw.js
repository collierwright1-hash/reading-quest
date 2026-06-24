/* Reading Quest service worker — offline app shell.
   Bump CACHE when you change app files so devices pick up the update. */
const CACHE = "reading-quest-v1";
const SHELL = [
  "./", "./index.html", "./styles.css", "./app.js",
  "./manifest.webmanifest", "./icon.svg", "./icon-180.png", "./icon-512.png",
  "./questions-summer1.json"
];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.filter(Boolean))).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if(e.request.method !== "GET" || url.origin !== location.origin) return; // never cache Sheet POSTs etc.
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
