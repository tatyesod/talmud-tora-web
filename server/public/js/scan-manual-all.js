// scan-manual-all.js — שיוך סריקה מעורבת, כמה כיתות יחד ובכל סדר.
//
// בלי קוד זיהוי אין דרך לדעת לאיזו כיתה שייך טופס. אבל גם אין צורך:
// ברגע שנבחר התלמיד, הכיתה נגזרת ממנו והמערכת מסדרת הכל לבד.
// לכן כאן אין הצעה לפי סדר - יש חיפוש: מקלידים שם משפחה ובוחרים.

(function () {
  const box = document.getElementById("manual-all");
  if (!box) return;

  const YEAR = box.dataset.year;
  // הנתונים מגיעים מבלוק JSON ולא ממאפיין: שמות הכיתות מכילים גרש,
  // שסוגר מאפיין HTML באמצע ושובר את הפענוח.
  const dataEl = document.getElementById("ma-students-data");
  const STUDENTS = JSON.parse((dataEl && dataEl.textContent) || "[]");
  const fileInput = document.getElementById("ma-file");
  const loadBtn = document.getElementById("ma-load");
  const sendBtn = document.getElementById("ma-send");
  const listEl = document.getElementById("ma-list");
  const status = document.getElementById("ma-status");
  const counter = document.getElementById("ma-counter");

  let srcBytes = null;
  let pairs = [];

  const setStatus = (m, c) => { status.className = "ma-status " + (c || ""); status.textContent = m; };

  function updateCounter() {
    const done = pairs.filter((p) => p.studentId).length;
    counter.textContent = done + " מתוך " + pairs.length + " שויכו";
    // אותו תלמיד בשתי שורות - כמעט תמיד טעות
    const counts = {};
    pairs.forEach((p) => { if (p.studentId) counts[p.studentId] = (counts[p.studentId] || 0) + 1; });
    let dupes = 0;
    listEl.querySelectorAll(".ma-input").forEach(function (inp, i) {
      const bad = pairs[i].studentId && counts[pairs[i].studentId] > 1;
      inp.classList.toggle("ma-dupe", !!bad);
      if (bad) dupes++;
    });
    sendBtn.disabled = done === 0;
    sendBtn.textContent = dupes ? "📤 שליחה (" + dupes + " כפולים!)" : "📤 שליחת " + done + " טפסים";
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

    pairs = [];
    for (let i = 0; i < doc.numPages; i += 2) {
      const pgs = [i];
      if (i + 1 < doc.numPages) pgs.push(i + 1);
      pairs.push({ pages: pgs, studentId: null });
    }
    listEl.innerHTML = "";
    setStatus("מציג " + pairs.length + " טפסים…");

    for (let i = 0; i < pairs.length; i++) {
      const page = await doc.getPage(pairs[i].pages[0] + 1);
      const vp = page.getViewport({ scale: 1.6 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;

      // ראש הטופס בלבד - שם התלמיד והכיתה מודפסים שם
      const crop = document.createElement("canvas");
      crop.width = canvas.width;
      crop.height = Math.round(canvas.height * 0.34);
      crop.getContext("2d").drawImage(canvas, 0, 0, canvas.width, crop.height,
                                      0, 0, canvas.width, crop.height);
      crop.className = "ma-canvas";
      crop.title = "לחיצה להגדלה";
      crop.addEventListener("click", function () {
        const w = window.open("");
        if (w) w.document.write('<img src="' + canvas.toDataURL() + '" style="width:100%">');
      });

      const row = document.createElement("div");
      row.className = "ma-row";
      const left = document.createElement("div");
      left.className = "ma-thumb";
      left.appendChild(crop);

      const right = document.createElement("div");
      right.className = "ma-side";
      right.innerHTML = '<div class="ma-label">טופס ' + (i + 1) +
        (pairs[i].pages.length < 2 ? ' <span class="ma-warn">(עמוד אחד בלבד)</span>' : "") + "</div>";

      // שדה חיפוש עם השלמה - 837 תלמידים ברשימה נפתחת אינם שמישים
      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "ma-input";
      inp.setAttribute("list", "ma-students");
      inp.placeholder = "הקלד שם משפחה…";
      inp.addEventListener("input", function () {
        const match = STUDENTS.find((s) => s.label === inp.value);
        pairs[i].studentId = match ? match.id : null;
        inp.classList.toggle("ma-ok", !!match);
        updateCounter();
      });
      right.appendChild(inp);

      row.appendChild(left);
      row.appendChild(right);
      listEl.appendChild(row);
    }
    updateCounter();
    loadBtn.disabled = false;
    setStatus(pairs.length + " טפסים נטענו. הקלד שם משפחה לכל טופס.", "ok");
  }

  async function send() {
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.load(srcBytes);
    const chosen = pairs.filter((p) => p.studentId);
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
      (failed ? "  ·  " + failed + " נכשלו" : "") +
      ". כל טופס שויך לכיתה של התלמיד.", saved ? "ok" : "err");
    sendBtn.disabled = false;
  }

  loadBtn.addEventListener("click", function () {
    load().catch(function (e) { setStatus("שגיאה: " + e.message, "err"); loadBtn.disabled = false; });
  });
  sendBtn.addEventListener("click", function () {
    send().catch(function (e) { setStatus("שגיאה: " + e.message, "err"); sendBtn.disabled = false; });
  });
})();
