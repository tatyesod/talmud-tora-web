// media-capture.js — צילום תמונה והקלטת סרטון לבקשת תחזוקה.
//
// שתי מטרות: שהתחזוקן יוכל לצלם ישר מהטאבלט, ושהדיסק לא יתמלא.
// הדיסק ב-Render הוא 1GB, וסרטון גולמי מטלפון הוא 30-60MB - עשרים כאלה
// וגמרנו. לכן:
//   * תמונות מוקטנות בדפדפן לפני ההעלאה (4MB -> ~300KB), בלי לפגוע בקריאות
//     של תקלה בתמונה.
//   * הקלטה מוגבלת ב-20 שניות ובקצב סיביות מופחת (~3MB לסרטון).
// ההקטנה נעשית בצד הלקוח בכוונה: כך הקובץ הכבד אף פעם לא עולה ברשת.

(function () {
  const MAX_SECONDS = 20;
  const MAX_IMAGE_PX = 1600;     // הצלע הארוכה
  const JPEG_QUALITY = 0.82;
  const VIDEO_BPS = 1200000;     // ~1.2Mbps

  function fmtSize(b) {
    return b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB";
  }

  // ---- הקטנת תמונה ----
  function shrinkImage(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        const scale = Math.min(1, MAX_IMAGE_PX / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob(function (blob) {
          // אם ההקטנה לא עזרה (תמונה קטנה מלכתחילה) - שולחים את המקור
          resolve(blob && blob.size < file.size
            ? new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" })
            : file);
        }, "image/jpeg", JPEG_QUALITY);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  document.querySelectorAll(".media-box").forEach(function (box) {
    const reqId = box.dataset.requestId;
    const fileInput = box.querySelector(".media-file");
    const list = box.querySelector(".media-queue");
    const form = box.querySelector(".media-form");
    const recBtn = box.querySelector(".media-record");
    const recNote = box.querySelector(".media-rec-note");
    const preview = box.querySelector(".media-preview");
    let queue = [];        // הקבצים שיישלחו
    let recorder = null, stream = null, timer = null;

    // כתובות ה-blob של התצוגה המקדימה. משוחררות בכל ציור מחדש, אחרת הן
    // נצברות בזיכרון של הטאבלט לאורך יום עבודה.
    let previewUrls = [];
    function releasePreviews() {
      previewUrls.forEach(function (u) { URL.revokeObjectURL(u); });
      previewUrls = [];
    }

    function draw() {
      releasePreviews();
      list.innerHTML = "";
      let total = 0;
      queue.forEach(function (f, i) {
        total += f.size;
        const row = document.createElement("div");
        row.className = "media-qrow";

        // תצוגה מקדימה של הקובץ שיישלח בפועל - התמונה שמוצגת היא זו שאחרי
        // ההקטנה, כך שמה שהוא מאשר הוא בדיוק מה שיישמר.
        const url = URL.createObjectURL(f);
        previewUrls.push(url);
        const isVideo = f.type.startsWith("video");

        if (isVideo) {
          const v = document.createElement("video");
          v.src = url; v.controls = true; v.playsInline = true; v.preload = "metadata";
          v.className = "media-qprev media-qvideo";
          row.appendChild(v);
        } else {
          const a = document.createElement("a");
          a.href = url; a.target = "_blank"; a.rel = "noopener";
          a.title = "לחיצה לתמונה מוגדלת";
          const img = document.createElement("img");
          img.src = url; img.className = "media-qprev";
          a.appendChild(img);
          row.appendChild(a);
        }

        const info = document.createElement("span");
        info.className = "media-qinfo";
        info.innerHTML = (isVideo ? "🎥 סרטון" : "📷 תמונה") +
          ' <small>(' + fmtSize(f.size) + ')</small>';
        row.appendChild(info);

        const x = document.createElement("button");
        x.type = "button"; x.className = "btn small danger";
        x.textContent = "✕";
        x.title = isVideo ? "מחיקת הסרטון" : "מחיקת התמונה";
        x.onclick = function () { queue.splice(i, 1); draw(); };
        row.appendChild(x);

        list.appendChild(row);
      });
      form.querySelector(".media-send").disabled = queue.length === 0;
      const t = box.querySelector(".media-total");
      if (t) {
        t.textContent = queue.length
          ? "סה\"כ " + fmtSize(total) + " · בדוק שהצילום תקין לפני השליחה"
          : "";
      }
    }

    // ---- בחירת/צילום תמונה ----
    if (fileInput) {
      fileInput.addEventListener("change", async function () {
        for (const f of Array.from(fileInput.files)) {
          if (queue.length >= 6) break;
          queue.push(f.type.startsWith("image") ? await shrinkImage(f) : f);
        }
        fileInput.value = "";
        draw();
      });
    }

    // ---- הקלטת סרטון ----
    if (recBtn) {
      // מכשיר בלי גישה למצלמה דרך הדפדפן (או דפדפן מסונן) - מסתירים ומשאירים
      // את בחירת הקובץ, שפותחת את אפליקציית המצלמה של המכשיר
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        recBtn.style.display = "none";
        if (recNote) recNote.textContent = "הקלטה מהדפדפן אינה נתמכת במכשיר זה — אפשר לצלם דרך כפתור הצילום.";
      }

      recBtn.addEventListener("click", async function () {
        if (recorder) { stopRec(); return; }
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: { ideal: 1280 } },
            audio: true,
          });
        } catch (e) {
          if (recNote) recNote.textContent = "לא ניתן לגשת למצלמה. אפשר לצלם דרך כפתור הצילום.";
          return;
        }
        preview.srcObject = stream;
        preview.style.display = "block";
        preview.play().catch(function () {});

        const chunks = [];
        const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
          ? "video/webm;codecs=vp8" : "video/webm";
        recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: VIDEO_BPS });
        recorder.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = function () {
          const blob = new Blob(chunks, { type: "video/webm" });
          queue.push(new File([blob], "video-" + Date.now() + ".webm", { type: "video/webm" }));
          draw();
        };
        recorder.start();

        let left = MAX_SECONDS;
        recBtn.textContent = "⏹ עצור (" + left + ")";
        recBtn.classList.add("recording");
        timer = setInterval(function () {
          left--;
          recBtn.textContent = "⏹ עצור (" + left + ")";
          // עצירה קשיחה: זו ההגנה שמונעת סרטון ארוך שימלא את הדיסק
          if (left <= 0) stopRec();
        }, 1000);
        if (recNote) recNote.textContent = "מקליט… ההקלטה נעצרת אוטומטית אחרי " + MAX_SECONDS + " שניות.";
      });

      function stopRec() {
        clearInterval(timer); timer = null;
        if (recorder && recorder.state !== "inactive") recorder.stop();
        recorder = null;
        if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
        preview.style.display = "none";
        preview.srcObject = null;
        recBtn.textContent = "🎥 הקלטת סרטון (עד " + MAX_SECONDS + " שנ')";
        recBtn.classList.remove("recording");
        if (recNote) recNote.textContent = "";
      }
    }

    // ---- שליחה ----
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!queue.length) return;
      const fd = new FormData(form);
      fd.delete("media");
      queue.forEach(function (f) { fd.append("media", f, f.name); });
      const btn = form.querySelector(".media-send");
      btn.disabled = true;
      btn.textContent = "מעלה…";
      fetch("/inventory/maintenance/" + reqId + "/media", { method: "POST", body: fd })
        .then(function () { window.location.reload(); })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = "📤 שליחה";
          if (recNote) recNote.textContent = "ההעלאה נכשלה. נסה שוב.";
        });
    });

    window.addEventListener("pagehide", releasePreviews);

    draw();
  });
})();
