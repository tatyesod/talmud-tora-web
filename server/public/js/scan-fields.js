// scan-fields.js — מפת השדות בטופס הצהרת הבריאות וגילוי דיו.
//
// הרעיון: אנחנו מדפיסים את הטופס, ולכן אנחנו יודעים בדיוק היכן יושב כל
// קו ריק. אין צורך "לחפש כתב יד" בדף - בודקים ארבעה־עשר מלבנים ידועים.
//
// והבדיקה עצמה אינה זיהוי כתב יד אלא השוואה: המערכת יודעת אילו שדות
// הודפסו ריקים (כי הערך במסד היה ריק), ואם נמצא בהם דיו - ההורים כתבו.
// זה מדויק לחלוטין ואינו תלוי בקריאה.
//
// הקואורדינטות יחסיות לעמוד, ולכן עובדות בכל רזולוציית סריקה.
// כוילו על סריקה אמיתית: שדה ריק נותן כ-0.3% דיו, שדה עם תוכן 1.7%-10%.

window.ScanFields = (function () {
  const ROW0 = 0.1955;      // מרכז השורה הראשונה
  const STEP = 0.02135;     // מרווח בין שורות
  const RIGHT = [0.55, 0.80];
  const LEFT = [0.16, 0.41];
  const INK_THRESHOLD = 1.2;   // מתחת לזה - הקו ריק

  // field_key תואם לשם העמודה במסד, כדי שהעדכון יהיה ישיר
  const FIELDS = [
    { row: 1,  side: "left",  key: "nickname",           label: "שם חיבה",         table: "students" },
    { row: 2,  side: "left",  key: "health_fund",        label: "קופת חולים",      table: "students" },
    { row: 4,  side: "left",  key: "immigration_year",   label: "שנת עלייה",       table: "students" },
    { row: 6,  side: "right", key: "address",            label: "כתובת",           table: "families" },
    { row: 7,  side: "right", key: "home_phone",         label: "טלפון בית",       table: "families" },
    { row: 8,  side: "left",  key: "father_workplace",   label: "מקום לימוד האב",  table: "families" },
    { row: 9,  side: "right", key: "father_mobile",      label: "נייד האב",        table: "families" },
    { row: 9,  side: "left",  key: "father_synagogue",   label: "מקום תפילה האב",  table: "families" },
    { row: 10, side: "left",  key: "mother_workplace",   label: "מקום עבודת האם",  table: "families" },
    { row: 11, side: "right", key: "mother_mobile",      label: "נייד האם",        table: "families" },
    { row: 11, side: "left",  key: "mother_work_phone",  label: "טלפון בעבודת האם", table: "families" },
    { row: 12, side: "right", key: "father_email",       label: "אימייל האב",      table: "families" },
    { row: 12, side: "left",  key: "mother_email",       label: "אימייל האם",      table: "families" },
  ];

  function box(canvas, f) {
    const cy = ROW0 + f.row * STEP;
    const [x0, x1] = f.side === "right" ? RIGHT : LEFT;
    return {
      x: Math.round(canvas.width * x0),
      y: Math.round(canvas.height * (cy - 0.008)),
      w: Math.round(canvas.width * (x1 - x0)),
      h: Math.round(canvas.height * 0.018),
    };
  }

  // אחוז הפיקסלים הכהים באזור. קו הבסיס דק ותורם מעט מאוד, ולכן קו ריק
  // נותן ערך קרוב לאפס.
  function inkPct(ctx, b) {
    const d = ctx.getImageData(b.x, b.y, b.w, b.h).data;
    let dark = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (g < 150) dark++;
      n++;
    }
    return n ? (dark / n) * 100 : 0;
  }

  // emptyKeys - השדות שהיו ריקים במסד בזמן ההדפסה, ולכן הודפסו כקו ריק
  function detect(canvas, emptyKeys) {
    const ctx = canvas.getContext("2d");
    const found = [];
    for (const f of FIELDS) {
      if (emptyKeys.indexOf(f.key) === -1) continue;   // הודפס עם ערך
      const b = box(canvas, f);
      let pct = 0;
      try { pct = inkPct(ctx, b); } catch (e) { continue; }
      if (pct < INK_THRESHOLD) continue;               // הקו נשאר ריק

      // חיתוך התמונה של השדה, להצגה במסך העדכון
      const c = document.createElement("canvas");
      c.width = b.w; c.height = b.h;
      c.getContext("2d").drawImage(canvas, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      found.push({
        key: f.key, label: f.label, table: f.table,
        ink: Math.round(pct * 10) / 10,
        crop: c.toDataURL("image/png"),
      });
    }
    return found;
  }

  return { FIELDS: FIELDS, detect: detect, INK_THRESHOLD: INK_THRESHOLD };
})();
