// sw.js - Service Worker בסיסי למערכת ניהול תלמוד תורה החדש
// מאפשר התקנה כאפליקציה (PWA) ומטמון בסיסי לעבודה גם עם חיבור חלש.

// שם המטמון מקבל גרסה חדשה בכל שינוי מבני כאן, כדי שמטמונים ישנים יימחקו
// אוטומטית ב-activate ולא יישארו תקועים אצל משתמשים ותיקים.
const CACHE_NAME = "tt-hachadash-v3";

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
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (!response || !response.ok) {
          // תשובה שגויה - מנסים קודם את המטמון. אם אין שם עותק, מחזירים את
          // התשובה המקורית כדי שהשגיאה האמיתית של השרת עדיין תגיע למשתמש.
          return caches.match(event.request).then((cached) => cached || response);
        }
        // שומרים רק תגובות תקינות, ולא כאלה שעברו הפניה (Cache.put דוחה אותן).
        if (!response.redirected) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request).then((cached) =>
          cached || new Response("", { status: 504, statusText: "Offline and not cached" })
        )
      )
  );
});
