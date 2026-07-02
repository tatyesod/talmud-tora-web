// רצועת מידע בדף הבית: שעון חי, דף יומי, מזג אוויר וזמני שבת
// משתמש ב-APIs חיצוניים חינמיים (ללא מפתח): Hebcal (לוח עברי/שבת) ו-Open-Meteo (מזג אוויר)

(function () {
  // --- שעון חי ---
  function updateClock() {
    const el = document.getElementById("clock-time");
    if (!el) return;
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
  updateClock();
  setInterval(updateClock, 1000);

  // --- דף יומי (Hebcal Jewish Calendar API, F=on) ---
  (function loadDafYomi() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    fetch(`https://www.hebcal.com/hebcal?cfg=json&v=1&F=on&start=${dateStr}&end=${dateStr}`)
      .then((r) => r.json())
      .then((data) => {
        const items = (data && data.items) || [];
        const daf = items.find((i) => i.category === "dafyomi");
        const el = document.getElementById("dafyomi-value");
        if (el) el.textContent = daf ? (daf.hebrew || daf.title) : "לא זמין";
      })
      .catch(() => {
        const el = document.getElementById("dafyomi-value");
        if (el) el.textContent = "לא זמין";
      });
  })();

  // --- מזג אוויר (Open-Meteo, בני ברק) ---
  const LAT = 32.0807, LON = 34.8338;
  fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current_weather=true`)
    .then((r) => r.json())
    .then((data) => {
      const el = document.getElementById("weather-temp");
      if (el && data && data.current_weather) {
        el.textContent = Math.round(data.current_weather.temperature) + "°C";
      } else if (el) {
        el.textContent = "--°";
      }
    })
    .catch(() => {
      const el = document.getElementById("weather-temp");
      if (el) el.textContent = "--°";
    });

  // --- זמני היום ההלכתיים (Hebcal Zmanim API, בני ברק) ---
  fetch(`https://www.hebcal.com/zmanim?cfg=json&latitude=${LAT}&longitude=${LON}&tzid=Asia/Jerusalem`)
    .then((r) => r.json())
    .then((data) => {
      const times = (data && data.times) || {};
      const fmtTime = (iso) => {
        if (!iso) return "—";
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      const fields = [
        "alotHaShachar", "sunrise", "sofZmanShmaMGA", "sofZmanShma",
        "sofZmanTfillaMGA", "sofZmanTfilla", "chatzot", "minchaGedola",
        "minchaKetana", "plagHaMincha", "sunset", "tzeit7083deg", "chatzotNight",
      ];
      fields.forEach((f) => {
        const el = document.getElementById("z-" + f);
        if (el) el.textContent = fmtTime(times[f]);
      });
    })
    .catch(() => {
      document.querySelectorAll(".zman-value").forEach((el) => { el.textContent = "לא זמין"; });
    });

  // --- זמני שבת (Hebcal Shabbat API, בני ברק) ---
  fetch(`https://www.hebcal.com/shabbat?cfg=json&latitude=${LAT}&longitude=${LON}&tzid=Asia/Jerusalem&M=on&b=18`)
    .then((r) => r.json())
    .then((data) => {
      const items = (data && data.items) || [];
      const candles = items.find((i) => i.category === "candles");
      const havdalah = items.find((i) => i.category === "havdalah");

      const fmtTime = (iso) => {
        if (!iso) return "—";
        const d = new Date(iso);
        const pad = (n) => String(n).padStart(2, "0");
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };

      const inEl = document.getElementById("shabbat-in");
      const outEl = document.getElementById("shabbat-out");
      if (inEl) inEl.textContent = candles ? fmtTime(candles.date) : "—";
      if (outEl) outEl.textContent = havdalah ? fmtTime(havdalah.date) : "—";
    })
    .catch(() => {
      const inEl = document.getElementById("shabbat-in");
      const outEl = document.getElementById("shabbat-out");
      if (inEl) inEl.textContent = "לא זמין";
      if (outEl) outEl.textContent = "לא זמין";
    });
})();

// ===== פרשת השבוע וצומות — API של Sefaria =====
(function () {
  const parashaEl = document.getElementById("parasha-value");
  const fastEl    = document.getElementById("info-fast");
  const fastVal   = document.getElementById("fast-value");

  // מיפוי שמות צומות לעברית (למקרה ש-API מחזיר באנגלית)
  const FAST_NAMES = {
    "Fast of Gedaliah":   "צום גדליה",
    "Fast of Esther":     "תענית אסתר",
    "Asara B'Tevet":      "עשרה בטבת",
    "17th of Tammuz":     "שבעה עשר בתמוז",
    "9th of Av":          "תשעה באב",
    "Yom Kippur":         "יום כיפור",
    "Tzom Tammuz":        "שבעה עשר בתמוז",
    "Tzom Gedaliah":      "צום גדליה",
  };

  fetch("https://www.sefaria.org/api/calendars?diaspora=1&lang=he", { cache: "force-cache" })
    .then(r => r.json())
    .then(data => {
      const items = data.calendar_items || [];

      // פרשת השבוע
      const parasha = items.find(i =>
        i.title?.en === "Parashat Hashavua" ||
        i.title?.en?.includes("Parasha")
      );
      if (parashaEl) {
        parashaEl.textContent = parasha?.displayValue?.he || "—";
      }

      // צום
      const fast = items.find(i =>
        i.category === "Fasts" ||
        i.title?.en?.toLowerCase().includes("fast") ||
        i.title?.en?.toLowerCase().includes("yom kippur") ||
        i.title?.he?.includes("צום") ||
        i.title?.he?.includes("תענית") ||
        i.title?.en?.includes("Av") ||
        i.title?.en?.includes("Tammuz") ||
        i.title?.en?.includes("Tevet")
      );

      if (fast && fastEl && fastVal) {
        const heName = fast.displayValue?.he || fast.title?.he ||
                       FAST_NAMES[fast.title?.en] || fast.title?.en || "צום";
        fastVal.textContent = heName;
        fastEl.style.display = "";
      }
    })
    .catch(() => {
      if (parashaEl) parashaEl.textContent = "—";
    });
})();

// ===== Fallback: חישוב פרשה מקומי אם ה-API לא זמין =====
(function() {
  // טבלת פרשות לשנת תשפ"ו (דיאספורה) — שבתות מ-18/10/2025
  const PARSHIOT_5786 = [
    "בראשית","נח","לך לך","וירא","חיי שרה","תולדות","ויצא","וישלח","וישב","מקץ",
    "ויגש","ויחי","שמות","וארא","בא","בשלח","יתרו","משפטים","תרומה","תצוה",
    "כי תשא","ויקהל-פקודי","ויקרא","צו","שמיני","תזריע-מצרע","אחרי מות-קדושים",
    "אמור","בהר-בחוקותי","במדבר","נשא","בהעלותך","שלח","קרח","חקת","בלק",
    "פינחס","מטות-מסעי","דברים","ואתחנן","עקב","ראה","שופטים","כי תצא",
    "כי תבוא","נצבים-וילך","האזינו"
  ];
  // שבת בראשית תשפ"ו = 18 אוק' 2025 (ms)
  const ANCHOR = new Date("2025-10-18").getTime();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function getLocalParasha() {
    const now = new Date();
    // מצא את שבת השבוע (יום שני-שישי → שבת הבאה; שבת → השבת הזו)
    const dow = now.getDay(); // 0=א', 6=ש'
    const daysToShabbat = dow === 6 ? 0 : 6 - dow;
    const shabbat = new Date(now.getTime() + daysToShabbat * 24 * 60 * 60 * 1000);
    shabbat.setHours(0,0,0,0);
    const weeks = Math.round((shabbat.getTime() - ANCHOR) / WEEK_MS);
    if (weeks < 0 || weeks >= PARSHIOT_5786.length) return null;
    return PARSHIOT_5786[weeks];
  }

  // ממתין לטעינת הדף ומגדיר fallback אחרי 3 שניות
  setTimeout(() => {
    const el = document.getElementById("parasha-value");
    if (el && (el.textContent === "טוען..." || el.textContent === "—")) {
      const p = getLocalParasha();
      if (p) el.textContent = "פ' " + p;
    }
  }, 3000);
})();
