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
