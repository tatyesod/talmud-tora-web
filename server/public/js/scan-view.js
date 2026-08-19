// scan-view.js — הצגת טופס סרוק בלי להסתמך על מציג ה-PDF של הדפדפן.
//
// הסיבה: כשההגדרה "הורד קבצי PDF במקום לפתוח אותם" פעילה, הדפדפן מציג
// במסגרת מוטמעת סמל וכפתור "פתיחה" במקום את המסמך. זו הגדרה של המשתמש
// ואי אפשר לעקוף אותה - אבל אפשר פשוט לא להזדקק לה: אנחנו מציירים את
// העמודים בעצמנו, באותה ספרייה שכבר משמשת לקליטת הסריקות.

(function () {
  const box = document.getElementById("sv-render");
  if (!box) return;

  const url = box.dataset.url;
  const status = document.getElementById("sv-status");
  const say = (m, cls) => { status.className = "sv-status " + (cls || ""); status.textContent = m; };

  let rendered = [];   // הקנבסים, לשימוש בהדפסה

  async function render() {
    say("טוען את הטופס…");
    const pdfjs = await import("/js/vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = "/js/vendor/pdf.worker.min.mjs";
    const doc = await pdfjs.getDocument({
      url: url,
      standardFontDataUrl: "/js/vendor/standard_fonts/",
      wasmUrl: "/js/vendor/wasm/",
    }).promise;

    box.innerHTML = "";
    rendered = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      // רזולוציה גבוהה: הטופס נסרק ולכן טקסט דק, וקנה מידה נמוך הופך
      // אותו לבלתי קריא על המסך.
      const vp = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      canvas.className = "sv-page";
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      box.appendChild(canvas);
      rendered.push(canvas);
    }
    say(doc.numPages + (doc.numPages === 1 ? " עמוד" : " עמודים"), "ok");
  }

  // הדפסה: חלון עם התמונות בלבד, בלי התפריט ובלי מסגרת המערכת
  window.printForm = function () {
    if (!rendered.length) { window.open(url, "_blank"); return; }
    const w = window.open("", "_blank");
    if (!w) { alert("החלון נחסם. אפשר לאשר חלונות קופצים, או להשתמש בהורדה."); return; }
    let html = '<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8">' +
      "<title>הדפסת טופס</title><style>" +
      "@page { size: A4; margin: 0; } body { margin:0; }" +
      "img { width:100%; display:block; page-break-after:always; }" +
      "img:last-child { page-break-after:auto; }" +
      "</style></head><body>";
    rendered.forEach((c) => { html += '<img src="' + c.toDataURL("image/png") + '">'; });
    html += "<script>window.onload=function(){window.print();}<\/script></body></html>";
    w.document.write(html);
    w.document.close();
  };

  render().catch(function (e) {
    say("לא ניתן היה להציג את הטופס: " + e.message + " — נסה 'פתיחה בלשונית'.", "err");
  });
})();
