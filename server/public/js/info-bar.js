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
  fetch(`https://www.hebcal.com/shabbat?cfg=json&latitude=${LAT}&longitude=${LON}&tzid=Asia/Jerusalem&M=on&b=18`)
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
    })
    .catch(() => {
      const inEl  = document.getElementById("shabbat-in");
      const outEl = document.getElementById("shabbat-out");
      if (inEl)  inEl.textContent  = "לא זמין";
      if (outEl) outEl.textContent = "לא זמין";
    });

  // --- פרשת השבוע (ממשיך להשתמש ב-Sefaria, שעובד טוב לזה) ---
  const parashaEl = document.getElementById("parasha-value");
  const fastEl    = document.getElementById("info-fast");
  const fastVal   = document.getElementById("fast-value");

  fetch("/api/jewish-calendar")
    .then(r => r.json())
    .then(data => {
      const items = data.calendar_items || [];
      const parasha = items.find(i => i.category === "Parasha" || i.title?.en === "Parashat Hashavua");
      if (parashaEl) parashaEl.textContent = parasha?.displayValue?.he || parashaEl.textContent;
    })
    .catch(() => {});

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

  // --- Fallback פרשה מחושב ---
  const PARSHIOT = [
    "בראשית","נח","לך לך","וירא","חיי שרה","תולדות","ויצא","וישלח","וישב","מקץ",
    "ויגש","ויחי","שמות","וארא","בא","בשלח","יתרו","משפטים","תרומה","תצוה",
    "כי תשא","ויקהל-פקודי","ויקרא","צו","שמיני","תזריע-מצרע","אחרי מות-קדושים",
    "אמור","בהר-בחוקותי","במדבר","נשא","בהעלותך","שלח","קרח","חקת","בלק",
    "פינחס","מטות-מסעי","דברים","ואתחנן","עקב","ראה","שופטים","כי תצא",
    "כי תבוא","נצבים-וילך","האזינו"
  ];
  const ANCHOR_MS = new Date("2025-10-18").getTime();
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  setTimeout(() => {
    if (!parashaEl || (parashaEl.textContent !== "טוען..." && parashaEl.textContent !== "—")) return;
    const now = new Date();
    const dow = now.getDay();
    const daysToSat = dow === 6 ? 0 : 6 - dow;
    const sat = new Date(now.getTime() + daysToSat * 86400000);
    sat.setHours(0,0,0,0);
    const weeks = Math.round((sat.getTime() - ANCHOR_MS) / WEEK_MS);
    if (weeks >= 0 && weeks < PARSHIOT.length)
      parashaEl.textContent = "פ' " + PARSHIOT[weeks];
  }, 3000);

})();
