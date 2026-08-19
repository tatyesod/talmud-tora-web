// scan-manual.js — שיוך ידני של סריקה שאין בה קוד זיהוי.
//
// לשימוש חד-פעמי בשנה הנוכחית, שבה הטפסים הודפסו לפני שהוספנו את הקוד.
// הרעיון: לא לבקש מהמשתמש לזהות, אלא רק לאשר. הטופס מודפס עם שם התלמיד
// עליו, והסדר תואם את סדר ההדפסה - ולכן ההצעה נכונה ברוב השורות.

(function () {
  const box = document.getElementById("manual-box");
  if (!box) return;

  const YEAR = box.dataset.year;
  const STUDENTS = JSON.parse((document.getElementById("manual-students-data") || {}).textContent || "[]");
  const fileInput = document.getElementById("manual-file");
  const loadBtn = document.getElementById("manual-load");
  const pairsEl = document.getElementById("manual-pairs");
  const sendBtn = document.getElementById("manual-send");
  const status = document.getElementById("manual-status");

  let srcBytes = null;
  let pairs = [];   // [{ pages:[i,j], studentId }]

  function setStatus(msg, cls) {
    status.className = "manual-status " + (cls || "");
    status.textContent = msg;
  }

  function studentOptions(selectedId) {
    let html = '<option value="">— לא לשייך —</option>';
    for (const s of STUDENTS) {
      const mark = s.hasForm ? " ✓" : "";
      html += '<option value="' + s.id + '"' + (s.id === selectedId ? " selected" : "") + ">" +
              s.name + mark + "</option>";
    }
    return html;
  }

  async function load() {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { setStatus("לא נבחר קובץ.", "err"); return; }
    loadBtn.disabled = true;
    setStatus("קורא את הקובץ…");

    srcBytes = await file.arrayBuffer();
    const pdfjs = await import("/js/vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdf.worker.min.mjs";
    const doc = await pdfjs.getDocument({ data: srcBytes.slice(0) }).promise;

    // כל שני עמודים = טופס אחד. עמוד אחרון יחיד נחשב טופס בן עמוד אחד.
    pairs = [];
    for (let i = 0; i < doc.numPages; i += 2) {
      const pgs = [i];
      if (i + 1 < doc.numPages) pgs.push(i + 1);
      pairs.push({ pages: pgs, studentId: null });
    }

    // הצעה לפי הסדר: הטופס ה-n שייך לתלמיד ה-n ברשימה, כי ההדפסה והרשימה
    // ממוינות שתיהן לפי שם משפחה. אם תלמיד לא החזיר, הסדר יזוז - ולכן
    // התמונה מוצגת ואפשר לתקן כל שורה.
    const free = STUDENTS.filter((s) => !s.hasForm);
    pairs.forEach((p, i) => { if (free[i]) p.studentId = free[i].id; });

    pairsEl.innerHTML = "";
    setStatus("מציג " + pairs.length + " טפסים…");

    for (let i = 0; i < pairs.length; i++) {
      const page = await doc.getPage(pairs[i].pages[0] + 1);
      // קנה מידה גבוה: השם המודפס חייב להיות קריא, אחרת אין ערך לאישור
      const viewport = page.getViewport({ scale: 3.0 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;

      const row = document.createElement("div");
      row.className = "manual-row";

      const thumbWrap = document.createElement("div");
      thumbWrap.className = "manual-thumb";
      // חיתוך לשליש העליון: שם התלמיד תמיד שם, והתצוגה נשארת קריאה
      // חיתוך לפס שבו יושבים שם התלמיד, שם החיבה והכיתה.
      // הערכים נמדדו על טופס סרוק אמיתי: השם ב-19% מגובה העמוד והכיתה
      // ב-23%. חיתוך שהתחיל גבוה יותר כלל את כל הכותרת, והכל התכווץ
      // עד שלא ניתן היה לקרוא; חיתוך שהתחיל נמוך יותר החמיץ את השם עצמו.
      const TOP = 0.185, BOTTOM = 0.315;
      const y0 = Math.round(canvas.height * TOP);
      const bandH = Math.round(canvas.height * (BOTTOM - TOP));
      const crop = document.createElement("canvas");
      crop.width = canvas.width;
      crop.height = bandH;
      crop.getContext("2d").drawImage(canvas, 0, y0, canvas.width, bandH,
                                      0, 0, canvas.width, bandH);
      crop.className = "manual-canvas";
      crop.title = "לחיצה להגדלה";
      crop.addEventListener("click", function () {
        const w = window.open("");
        if (w) w.document.write('<img src="' + canvas.toDataURL() + '" style="width:100%">');
      });
      thumbWrap.appendChild(crop);

      const side = document.createElement("div");
      side.className = "manual-side";
      side.innerHTML =
        '<div class="manual-label">טופס ' + (i + 1) + " · עמודים " +
        pairs[i].pages.map((x) => x + 1).join("-") +
        (pairs[i].pages.length < 2 ? ' <span class="manual-warn">(עמוד אחד בלבד)</span>' : "") +
        "</div>";
      const sel = document.createElement("select");
      sel.className = "manual-select";
      sel.innerHTML = studentOptions(pairs[i].studentId);
      sel.addEventListener("change", function () {
        pairs[i].studentId = sel.value ? parseInt(sel.value, 10) : null;
        checkDupes();
      });
      side.appendChild(sel);
      row.appendChild(thumbWrap);
      row.appendChild(side);
      pairsEl.appendChild(row);
    }

    checkDupes();
    sendBtn.disabled = false;
    loadBtn.disabled = false;
    setStatus(pairs.length + " טפסים מוכנים. בדוק את השמות ותקן במידת הצורך.", "ok");
  }

  // אותו תלמיד בשתי שורות הוא כמעט תמיד טעות הסחה בסדר - מסמנים באדום
  function checkDupes() {
    const counts = {};
    pairs.forEach((p) => { if (p.studentId) counts[p.studentId] = (counts[p.studentId] || 0) + 1; });
    const sels = pairsEl.querySelectorAll(".manual-select");
    let dupes = 0;
    sels.forEach(function (sel, i) {
      const bad = pairs[i].studentId && counts[pairs[i].studentId] > 1;
      sel.classList.toggle("manual-dupe", !!bad);
      if (bad) dupes++;
    });
    sendBtn.textContent = dupes ? "📤 שליחה (" + dupes + " כפולים!)" : "📤 שליחת הטפסים";
  }

  async function send() {
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.load(srcBytes);
    const chosen = pairs.filter((p) => p.studentId);
    if (!chosen.length) { setStatus("לא שויך אף טופס.", "err"); return; }

    sendBtn.disabled = true;
    let saved = 0, skipped = 0, failed = 0;
    for (let i = 0; i < chosen.length; i++) {
      const p = chosen[i];
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, p.pages);
      copied.forEach((pg) => out.addPage(pg));
      const bytes = await out.save();

      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: "application/pdf" }), "form.pdf");
      fd.append("student_id", String(p.studentId));
      fd.append("year", YEAR);
      fd.append("page_count", String(p.pages.length));
      try {
        const r = await fetch("/scans/upload", { method: "POST", body: fd });
        const j = await r.json();
        if (!j.ok) failed++;
        else if (j.status === "saved" || j.status === "replaced") saved++;
        else skipped++;
      } catch (e) { failed++; }
      setStatus("מעלה… " + (i + 1) + " / " + chosen.length);
    }
    setStatus("נקלטו " + saved +
      (skipped ? "  ·  " + skipped + " כבר היו קיימים" : "") +
      (failed ? "  ·  " + failed + " נכשלו" : "") + ". מרענן…", saved ? "ok" : "err");
    setTimeout(function () { window.location.reload(); }, 1600);
  }

  loadBtn.addEventListener("click", function () {
    load().catch(function (e) { setStatus("שגיאה: " + e.message, "err"); loadBtn.disabled = false; });
  });
  sendBtn.addEventListener("click", function () {
    send().catch(function (e) { setStatus("שגיאה: " + e.message, "err"); sendBtn.disabled = false; });
  });
})();
