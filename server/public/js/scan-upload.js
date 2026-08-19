// scan-upload.js — פיצול סריקה ושיוך לתלמידים.
//
// הכל קורה בדפדפן ולא בשרת. הסיבה: פיצול PDF וקריאת קודים דורשים עיבוד
// תמונה, והשרת ב-Render הוא מכונה קטנה שמשרתת את כל המשתמשים. הדפדפן
// עושה את זה מקומית, מהר יותר, ובלי להעמיס.
//
// הזרימה: קוראים כל עמוד -> מחפשים קוד זיהוי -> מקבצים לפי תלמיד ->
// בונים PDF של שני עמודים לכל תלמיד -> מעלים אחד-אחד.

(function () {
  const box = document.getElementById("scan-box");
  if (!box) return;

  const fileInput = document.getElementById("scan-file");
  const startBtn = document.getElementById("scan-start");
  const log = document.getElementById("scan-log");
  const bar = document.getElementById("scan-bar");
  const summary = document.getElementById("scan-summary");
  const YEAR = box.dataset.year;
  // התלמידים של הכיתה, לשיוך ידני של עמודים בלי קוד
  const STUDENTS = JSON.parse((document.getElementById("scan-students-data") || {}).textContent || "[]");

  let pdfjsLib = null;

  function say(msg, cls) {
    const d = document.createElement("div");
    d.className = "scan-line " + (cls || "");
    d.textContent = msg;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  function progress(done, total) {
    bar.style.width = total ? Math.round((done / total) * 100) + "%" : "0%";
    bar.textContent = total ? done + " / " + total : "";
  }

  async function loadPdfJs() {
    if (pdfjsLib) return pdfjsLib;
    pdfjsLib = await import("/js/vendor/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/js/vendor/pdf.worker.min.mjs";
    return pdfjsLib;
  }

  // קריאת קוד הזיהוי מעמוד. מנסה בשתי רזולוציות: סריקות חיוורות או עקומות
  // לא תמיד נקראות בניסיון הראשון.
  async function readCode(page) {
    for (const scale of [2.0, 3.0]) {
      const viewport = page.getViewport({ scale: scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: viewport }).promise;
      const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
      if (code && code.data && code.data.indexOf("HD|") === 0) {
        const parts = code.data.split("|");
        return { studentId: parseInt(parts[1], 10), year: parts[2], pageNo: parseInt(parts[3], 10) };
      }
    }
    return null;
  }

  async function run() {
    const file = fileInput.files && fileInput.files[0];
    if (!file) { say("לא נבחר קובץ.", "err"); return; }

    startBtn.disabled = true;
    log.innerHTML = "";
    summary.textContent = "";
    say("קורא את הקובץ…");

    const buf = await file.arrayBuffer();
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
    say("נמצאו " + doc.numPages + " עמודים. מזהה קודים…");

    // שלב א': זיהוי
    const found = {};        // studentId -> { 1: pageIndex, 2: pageIndex }
    const unknown = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const info = await readCode(page);
      if (info && info.studentId) {
        found[info.studentId] = found[info.studentId] || {};
        found[info.studentId][info.pageNo || 1] = i - 1;
      } else {
        unknown.push(i - 1);
      }
      progress(i, doc.numPages);
    }

    const ids = Object.keys(found);
    say("זוהו " + ids.length + " תלמידים." +
        (unknown.length ? "  " + unknown.length + " עמודים ללא קוד." : ""), ids.length ? "ok" : "err");

    if (unknown.length) {
      say("עמודים ללא קוד לא יועלו — סביר שהם מטופס ישן שהודפס לפני הוספת הקוד. " +
          "אפשר לצרף אותם ידנית מהמסך של הכיתה.", "warn");
    }

    // שלב ב': בניית PDF לכל תלמיד והעלאה
    const { PDFDocument } = window.PDFLib;
    const src = await PDFDocument.load(buf);
    let saved = 0, dup = 0, exists = 0, failed = 0;
    let n = 0;

    for (const idStr of ids) {
      const id = parseInt(idStr, 10);
      const pages = found[idStr];
      const idxs = [pages[1], pages[2]].filter((x) => x !== undefined);
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, idxs);
      copied.forEach((p) => out.addPage(p));
      const bytes = await out.save();

      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: "application/pdf" }), "form.pdf");
      fd.append("student_id", String(id));
      fd.append("year", YEAR);
      fd.append("page_count", String(idxs.length));

      const label = (STUDENTS.find((s) => s.id === id) || {}).name || ("תלמיד " + id);
      try {
        const r = await fetch("/scans/upload", { method: "POST", body: fd });
        const j = await r.json();
        if (!j.ok) { failed++; say("✗ " + label + ": " + (j.error || "שגיאה"), "err"); }
        else if (j.status === "duplicate") { dup++; say("• " + label + " — כבר נסרק (אותו קובץ)", "muted"); }
        else if (j.status === "exists") { exists++; say("⚠ " + label + " — כבר קיים טופס לשנה זו", "warn"); }
        else { saved++; say("✓ " + label + (idxs.length < 2 ? "  (עמוד אחד בלבד!)" : ""), "ok"); }
      } catch (e) {
        failed++;
        say("✗ " + label + ": כשל רשת", "err");
      }
      progress(++n, ids.length);
    }

    summary.innerHTML =
      "<strong>נקלטו " + saved + "</strong>" +
      (dup ? "  ·  " + dup + " כפולים (דולגו)" : "") +
      (exists ? "  ·  " + exists + " כבר קיימים" : "") +
      (failed ? "  ·  " + failed + " נכשלו" : "") +
      (unknown.length ? "  ·  " + unknown.length + " עמודים ללא קוד" : "");
    startBtn.disabled = false;
  }

  startBtn.addEventListener("click", function () {
    run().catch(function (e) {
      say("שגיאה: " + e.message, "err");
      startBtn.disabled = false;
    });
  });
})();
