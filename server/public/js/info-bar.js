// רצועת מידע — קריאה ישירה ל-APIs (כמו לפני השדרוג)

(function () {
  const LAT = 32.0807, LON = 34.8338;

  // --- שעון חי ---
  function updateClock() {
    const el = document.getElementById("clock-time");
    if (!el) return;
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    el.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
  updateClock();
  setInterval(updateClock, 1000);

  // --- דף יומי ---
  (function loadDafYomi() {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    fetch(`https://www.hebcal.com/hebcal?cfg=json&v=1&F=on&start=${dateStr}&end=${dateStr}`)
      .then(r => r.json())
      .then(data => {
        const daf = (data.items||[]).find(i => i.category === "dafyomi");
        const el = document.getElementById("dafyomi-value");
        if (el) el.textContent = daf ? (daf.hebrew || daf.title) : "לא זמין";
      })
      .catch(() => {
        const el = document.getElementById("dafyomi-value");
        if (el) el.textContent = "לא זמין";
      });
  })();

  // --- מזג אוויר ---
  fetch(`https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current_weather=true`)
    .then(r => r.json())
    .then(data => {
      const el = document.getElementById("weather-temp");
      if (el && data.current_weather)
        el.textContent = Math.round(data.current_weather.temperature) + "°C";
    })
    .catch(() => {});

  // --- זמני היום ---
  fetch(`https://www.hebcal.com/zmanim?cfg=json&latitude=${LAT}&longitude=${LON}&tzid=Asia/Jerusalem`)
    .then(r => r.json())
    .then(data => {
      const times = data.times || {};
      const fmt = iso => {
        if (!iso) return "—";
        const d = new Date(iso);
        const pad = n => String(n).padStart(2, "0");
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      ["alotHaShachar","sunrise","sofZmanShmaMGA","sofZmanShma","sofZmanTfillaMGA",
       "sofZmanTfilla","chatzot","minchaGedola","minchaKetana","plagHaMincha",
       "sunset","tzeit7083deg","chatzotNight"].forEach(f => {
        const el = document.getElementById("z-"+f);
        if (el) el.textContent = fmt(times[f]);
      });
    })
    .catch(() => {
      document.querySelectorAll(".zman-value").forEach(el => el.textContent = "לא זמין");
    });

  // --- זמני שבת ---
  // i=on - לוח שנה וקריאת התורה של ארץ ישראל. בלי זה Hebcal מחזיר את לוח חו"ל,
  // שנבדל מישראל בשבוע שלם בתקופה שאחרי פסח ואחרי שבועות.
  fetch(`https://www.hebcal.com/shabbat?cfg=json&latitude=${LAT}&longitude=${LON}&tzid=Asia/Jerusalem&i=on&M=on&b=18`)
    .then(r => r.json())
    .then(data => {
      const items = data.items || [];
      const candles  = items.find(i => i.category === "candles");
      const havdalah = items.find(i => i.category === "havdalah");
      const fmt = iso => {
        if (!iso) return "—";
        const d = new Date(iso);
        const pad = n => String(n).padStart(2, "0");
        return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      };
      const inEl  = document.getElementById("shabbat-in");
      const outEl = document.getElementById("shabbat-out");
      if (inEl)  inEl.textContent  = candles  ? fmt(candles.date)  : "—";
      if (outEl) outEl.textContent = havdalah ? fmt(havdalah.date) : "—";
      // צאת השבת היא נקודת ההחלפה של הפרשה - לכן טוענים אותה רק עכשיו
      loadParasha(havdalah && havdalah.date ? new Date(havdalah.date) : null);
    })
    .catch(() => {
      const inEl  = document.getElementById("shabbat-in");
      const outEl = document.getElementById("shabbat-out");
      if (inEl)  inEl.textContent  = "לא זמין";
      if (outEl) outEl.textContent = "לא זמין";
      loadParasha(null);
    });

  // --- פרשת השבוע (Sefaria, עם Hebcal כגיבוי) ---
  const parashaEl = document.getElementById("parasha-value");
  const fastEl    = document.getElementById("info-fast");
  const fastVal   = document.getElementById("fast-value");

  const pad2 = n => String(n).padStart(2, "0");
  const isoOf = o => `${o.y}-${pad2(o.m)}-${pad2(o.d)}`;

  // התאריך בירושלים, ללא תלות באזור הזמן שמוגדר במחשב שממנו גולשים
  function jerusalemParts(dt) {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(dt).reduce((a, x) => (a[x.type] = x.value, a), {});
    return { y: +p.year, m: +p.month, d: +p.day };
  }

  function addDays(o, n) {
    const d = new Date(Date.UTC(o.y, o.m - 1, o.d));
    d.setUTCDate(d.getUTCDate() + n);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
  }

  // התאריך שלפיו נקבעת הפרשה: היום - אלא אם כבר עברה צאת השבת, ואז מיד
  // עוברים לפרשה הבאה. קודם לכן ההחלפה קרתה רק בחצות.
  // ההשוואה היא בין שתי נקודות זמן מוחלטות, ולכן חסינה לאזור הזמן של הדפדפן.
  function effectiveDate(havdalahAt) {
    const now = new Date();
    const today = jerusalemParts(now);
    return (havdalahAt && now >= havdalahAt) ? addDays(today, 1) : today;
  }

  function loadParasha(havdalahAt) {
    if (!parashaEl) return;
    const eff = effectiveDate(havdalahAt);
    fetch(`/api/jewish-calendar?date=${isoOf(eff)}`)
      .then(r => r.json())
      .then(data => {
        const items = data.calendar_items || [];
        const parasha = items.find(i => i.category === "Parasha" || i.title?.en === "Parashat Hashavua");
        const he = parasha && parasha.displayValue && parasha.displayValue.he;
        if (he) { parashaEl.textContent = he; return; }
        return parashaFallback(eff);
      })
      .catch(() => parashaFallback(eff));
  }

  // גיבוי: Hebcal לשבת הקרובה. מחליף את רשימת 47 הפרשיות הקשיחה שהייתה כאן,
  // שהסתיימה ב"האזינו", לא התחשבה בחגים, והייתה פגה בסוף המחזור.
  function parashaFallback(eff) {
    const sat = addDays(eff, (6 - new Date(Date.UTC(eff.y, eff.m - 1, eff.d)).getUTCDay() + 7) % 7);
    const s = isoOf(sat);
    return fetch(`https://www.hebcal.com/hebcal?cfg=json&v=1&i=on&s=on&leyning=off&start=${s}&end=${s}`)
      .then(r => r.json())
      .then(data => {
        const p = (data.items || []).find(i => i.category === "parashat");
        // Sefaria מחזיר "שופטים" ו-Hebcal מחזיר "פרשת שופטים" - מאחדים לתצוגה זהה
        if (p) parashaEl.textContent = (p.hebrew || p.title || "").replace(/^פרשת\s+/, "");
        else if (parashaEl.textContent === "טוען...") parashaEl.textContent = "—";
      })
      .catch(() => {
        if (parashaEl.textContent === "טוען...") parashaEl.textContent = "—";
      });
  }

  // --- צום היום (Hebcal - זה ה-API הנכון לזיהוי ימי צום, עם שדות category/subcat מדויקים) ---
  // מיפוי מפורש לשם התצוגה המלא - תמיד "צום ..." (חוץ מיום כיפור, שנהוג לומר בלי המילה "צום")
  const FAST_DISPLAY = {
    "Tzom Gedaliah": "צום גדליה",
    "Ta'anit Esther": "צום תענית אסתר",
    "Asara B'Tevet": "צום עשרה בטבת",
    "Ta'anit Bechorot": "תענית בכורות",
    "17th of Tammuz": "צום י\"ז בתמוז",
    "Tzom Tammuz": "צום י\"ז בתמוז",
    "9th of Av": "צום ט' באב",
    "Tisha B'Av": "צום ט' באב",
    "Yom Kippur": "יום כיפור",
  };

  (function loadFastDay() {
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
    // mf=on - צומות קטנים (י"ז בתמוז, ט' באב, עשרה בטבת, גדליה, תענית אסתר)
    // maj=on - חגים גדולים (כולל יום כיפור)
    fetch(`https://www.hebcal.com/hebcal?cfg=json&v=1&mf=on&maj=on&start=${dateStr}&end=${dateStr}`)
      .then(r => r.json())
      .then(data => {
        const items = data.items || [];
        const fast = items.find(i =>
          (i.category === "holiday" && i.subcat === "fast") || i.title === "Yom Kippur"
        );
        if (fast && fastEl && fastVal) {
          const heVal = fast.hebrew || "";
          fastVal.textContent = FAST_DISPLAY[fast.title] ||
            (/^(צום|יום)/.test(heVal) ? heVal : ("צום " + heVal));
          fastEl.style.display = "";
        }
      })
      .catch(() => {});
  })();

})();
