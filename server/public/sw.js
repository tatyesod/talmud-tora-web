// sw.js - Service Worker בסיסי למערכת ניהול תלמוד תורה החדש
// מאפשר התקנה כאפליקציה (PWA) ומטמון בסיסי לעבודה גם עם חיבור חלש.

// שם המטמון מקבל גרסה חדשה בכל שינוי מבני כאן, כדי שמטמונים ישנים יימחקו
// אוטומטית ב-activate ולא יישארו תקועים אצל משתמשים ותיקים.
const CACHE_NAME = "tt-hachadash-v4";

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

// אסטרטגיה: network-first עם נפילה לקאש.
//
// הבאג שתוקן כאן: קודם ה-catch תפס רק כשל רשת אמיתי (אין חיבור), ותגובה
// שהגיעה בהצלחה אבל הייתה שגויה - 502 בזמן פריסה ב-Render, 503, או דף
// חסימה של מסנן אינטרנט - הוחזרה לדפדפן כמו שהיא. התוצאה הייתה שהלוגו
// "נעלם" מדי פעם למרות שעותק תקין שלו ישב במטמון ולא נגעו בו.
// עכשיו כל תגובה שאינה תקינה נחשבת ככישלון ונופלת קודם למטמון.
//
// בנוסף: אם גם הרשת נכשלה וגם אין עותק במטמון, caches.match מחזיר undefined,
// ו-respondWith(undefined) מייצר שגיאת רשת קשה בדפדפן. לכן מוחזרת תגובה
// מפורשת במקום.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // בקשות לשירותים חיצוניים

  // מטפלים אך ורק בנכסים סטטיים - עיצוב, סקריפטים, תמונות וגופנים.
  //
  // חשוב במיוחד: בקשות ניווט (טעינת דף) ובקשות נתונים חייבות לעבור ישירות
  // לדפדפן בלי מגע. בבקשת ניווט הדפדפן מבקש redirect: "manual", ולכן הפניה
  // ל-/login חוזרת כתגובת opaqueredirect שבה response.ok הוא false. גרסה
  // קודמת של הקובץ הזה ראתה "לא ok" ושירתה במקום זה את דף הבית מהמטמון -
  // כך שאחרי סגירה ופתיחה האפליקציה נראתה מחוברת, בעוד שכל בקשות הנתונים
  // נכשלו והפאנלים בצדדים נתקעו על "טוען...".
  const STATIC = ["style", "script", "image", "font"];
  if (!STATIC.includes(req.destination)) return;

  event.respondWith(
    fetch(req)
      .then((response) => {
        if (!response || !response.ok || response.redirected) {
          // תגובה שגויה (502 בזמן פריסה, דף חסימה של מסנן) - מנסים את המטמון.
          // אם אין שם עותק, מחזירים את התגובה המקורית כדי לא להסתיר שגיאה אמיתית.
          return caches.match(req).then((cached) => cached || response);
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        return response;
      })
      .catch(() =>
        caches.match(req).then((cached) =>
          cached || new Response("", { status: 504, statusText: "Offline and not cached" })
        )
      )
  );
});
