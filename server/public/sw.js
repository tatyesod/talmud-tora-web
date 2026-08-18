// sw.js - Service Worker בסיסי למערכת ניהול תלמוד תורה החדש
// מאפשר התקנה כאפליקציה (PWA) ומטמון בסיסי לעבודה גם עם חיבור חלש.

// שם המטמון מקבל גרסה חדשה בכל שינוי מבני כאן, כדי שמטמונים ישנים יימחקו
// אוטומטית ב-activate ולא יישארו תקועים אצל משתמשים ותיקים.
const CACHE_NAME = "tt-hachadash-v5";

// נכסים סטטיים בלבד. "/" הוסר מכאן בכוונה: זה דף HTML שמחייב התחברות,
// ובמצב לא-מחובר הוא מחזיר הפניה ל-/login. Cache.put דוחה תגובות שעברו
// הפניה, וב-cache.addAll די בנכס אחד שנכשל כדי שכל הרשימה לא תיכנס למטמון.
const CORE_ASSETS = [
  "/css/style.css",
  "/css/home.css",
  "/images/icon-192.png",
  "/images/icon-512.png",
  "/images/logo.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // כל נכס נשמר בנפרד עם catch משלו - כך שנכס אחד שנכשל לא מפיל את השאר,
      // מה שקרה קודם בגלל ש-addAll הוא הכל-או-כלום.
      Promise.all(CORE_ASSETS.map((url) => cache.add(url).catch(() => {})))
    ).catch(() => {})
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

// אסטרטגיה לנכסים סטטיים: מטמון קודם, ורענון ברקע.
//
// קודם זה היה "רשת קודם": בכל טעינת דף הדפדפן פנה לשרת עבור כל קובץ עיצוב,
// סקריפט ותמונה, והמטמון שימש רק כגיבוי לכישלון. כלומר המטמון היה קיים אבל
// לא האיץ דבר, וכל מעבר בין דפים שילם סבב רשת מלא על כל נכס - וזו הייתה
// ההשהיה שהורגשה בכל ניווט, גם מהתפריט וגם מהכרטיסים.
//
// עכשיו: אם יש עותק במטמון הוא מוחזר מיד, ובמקביל נשלחת בקשה ברקע שמעדכנת
// אותו לפעם הבאה. קבצי העיצוב נטענים עם ?v=<גרסה>, ולכן שינוי בקוד מייצר
// כתובת חדשה שאין לה עותק - והמשתמש מקבל את הגרסה החדשה מיד ולא תקוע על ישן.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // בקשות לשירותים חיצוניים

  // בקשות ניווט (טעינת דף) ובקשות נתונים חייבות לעבור ישירות לדפדפן בלי מגע.
  // בבקשת ניווט הדפדפן מבקש redirect: "manual", ולכן הפניה ל-/login חוזרת
  // כתגובת opaqueredirect שבה response.ok הוא false. גרסה קודמת ראתה
  // "לא ok" ושירתה במקום זה את דף הבית מהמטמון - כך שאחרי סגירה ופתיחה
  // האפליקציה נראתה מחוברת, בעוד שכל בקשות הנתונים נכשלו.
  const STATIC = ["style", "script", "image", "font"];
  if (!STATIC.includes(req.destination)) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      // רענון ברקע. לא ממתינים לו, ולכן הוא לא מעכב את הצגת הדף.
      const network = fetch(req)
        .then((response) => {
          if (response && response.ok && !response.redirected) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => null);

      // יש עותק - מחזירים אותו מיד. אין - ממתינים לרשת.
      if (cached) return cached;
      return network.then(
        (response) =>
          response ||
          new Response("", { status: 504, statusText: "Offline and not cached" })
      );
    })
  );
});
