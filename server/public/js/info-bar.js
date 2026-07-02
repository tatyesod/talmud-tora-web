// רצועת מידע — כל הנתונים דרך proxy מקומי (עוקף חסימות אינטרנט כשר)

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
    fetch(`/api/proxy/hebcal?cfg=json&v=1&F=on&start=${dateStr}&end=${dateStr}`)
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
  fetch(`/api/proxy/weather?latitude=${LAT}&longitude=${LON}&current_weather=true`)
    .then(r => r.json())
    .then(data => {
      const el = document.getElementById("weather-temp");
      if (el && data.current_weather)
        el.textContent = Math.round(data.current_weather.temperature) + "°C";
    })
    .catch(() => {});

  // --- זמני היום ---
  fetch(`/api/proxy/zmanim?cfg=json&latitude=${LAT}&longitude=${LON}&tzid=Asia/Jerusalem`)
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
  fetch(`/api/proxy/shabbat?cfg=json&latitude=${LAT}&longitude=${LON}&tzid=Asia/Jerusalem&M=on&b=18`)
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

  // --- פרשת השבוע וצומות (Sefaria דרך proxy) ---
  const parashaEl = document.getElementById("parasha-value");
  const fastEl    = document.getElementById("info-fast");
  const fastVal   = document.getElementById("fast-value");

  const FAST_NAMES = {
    "Fast of Gedaliah": "צום גדליה", "Fast of Esther": "תענית אסתר",
    "Asara B'Tevet": "עשרה בטבת", "17th of Tammuz": "שבעה עשר בתמוז",
    "9th of Av": "תשעה באב", "Yom Kippur": "יום כיפור",
  };

  fetch("/api/jewish-calendar")
    .then(r => r.json())
    .then(data => {
      const items = data.calendar_items || [];

      // פרשה
      const parasha = items.find(i =>
        i.category === "Parasha" || i.title?.en === "Parashat Hashavua"
      );
      if (parashaEl) parashaEl.textContent = parasha?.displayValue?.he || parashaEl.textContent;

      // צום
      const fast = items.find(i =>
        i.category === "Fasts" ||
        ["fast","yom kippur","tammuz","tevet","gedaliah","esther","av"].some(k =>
          i.title?.en?.toLowerCase().includes(k))
      );
      if (fast && fastEl && fastVal) {
        fastVal.textContent = fast.displayValue?.he || fast.title?.he ||
                              FAST_NAMES[fast.title?.en] || fast.displayValue?.en || "צום";
        fastEl.style.display = "";
      }
    })
    .catch(() => {});

  // --- Fallback פרשה מחושב (אם API לא זמין) ---
  const PARSHIOT = [
    "בראשית","נח","לך לך","וירא","חיי שרה","תולדות","ויצא","וישלח","וישב","מקץ",
    "ויגש","ויחי","שמות","וארא","בא","בשלח","יתרו","משפטים","תרומה","תצוה",
    "כי תשא","ויקהל-פקודי","ויקרא","צו","שמיני","תזריע-מצרע","אחרי מות-קדושים",
    "אמור","בהר-בחוקותי","במדבר","נשא","בהעלותך","שלח","קרח","חקת","בלק",
    "פינחס","מטות-מסעי","דברים","ואתחנן","עקב","ראה","שופטים","כי תצא",
    "כי תבוא","נצבים-וילך","האזינו"
  ];
  const ANCHOR_MS = new Date("2025-10-18").getTime();
  const WEEK_MS   = 7 * 24 * 60 * 60 * 1000;

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
