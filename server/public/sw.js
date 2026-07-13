// sw.js - Service Worker בסיסי למערכת ניהול תלמוד תורה החדש
// מאפשר התקנה כאפליקציה (PWA) ומטמון בסיסי לעבודה גם עם חיבור חלש.

const CACHE_NAME = "tt-hachadash-v2";
const CORE_ASSETS = [
  "/",
  "/css/style.css",
  "/css/home.css",
  "/images/icon-192.png",
  "/images/icon-512.png",
  "/images/logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// אסטרטגיה: network-first עם נפילה לקאש - כדי שנתונים תמיד יהיו עדכניים כשיש רשת,
// אבל האתר עדיין ייפתח (במצב בסיסי) גם ללא חיבור. שומרים במטמון רק תגובות
// תקינות (200 OK) - כדי שתגובה שבורה/חלקית (למשל בגלל ניתוק זמני באמצע דיפלוי)
// לא תישמר במטמון ותוגש שוב ושוב במקום התמונה/קובץ האמיתי.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
