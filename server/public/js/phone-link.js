// לחיצה על מספר טלפון - שתי התנהגויות לפי סוג המכשיר:
// • במחשב (Windows/Mac) - אין חייגן טלפוני אמיתי, אז מעתיקים את המספר ללוח
//   ומציגים הודעה להמשיך ב-F7+Enter בתוכנת החיוג (כמו קודם).
// • בנייד/אפליקציה (Android/iOS, כולל ה-APK) - מעתיקים ללוח (ליתר ביטחון)
//   וגם מפעילים אקטיבית מעבר לחייגן המכשיר (tel:) - לא מסתמכים רק על
//   ההתנהגות הדיפולטיבית של קישור ה-<a>, כי בתוך WebView עטוף (כמו ה-APK)
//   זו לא תמיד נתפסת אוטומטית ע"י מערכת ההפעלה.
(function () {
  function isMobileDevice() {
    var ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
    // גיבוי: מכשיר עם מסך מגע ובלי סימני "Windows"/"Macintosh" מובהקים של מחשב שולחני
    var hasTouch = (navigator.maxTouchPoints || 0) > 0;
    var looksDesktop = /Windows NT|Macintosh/i.test(ua);
    return hasTouch && !looksDesktop;
  }
  var isMobile = isMobileDevice();

  function showToast(msg) {
    let toast = document.getElementById("phone-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "phone-toast";
      toast.style.cssText = `
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
        background:#2c5f7c; color:#fff; padding:10px 20px; border-radius:8px;
        font-size:0.9em; box-shadow:0 4px 14px rgba(0,0,0,0.25); z-index:9999;
        opacity:0; transition:opacity 0.25s ease;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    requestAnimationFrame(() => { toast.style.opacity = "1"; });
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => { toast.style.opacity = "0"; }, 2200);
  }

  document.addEventListener("click", function (e) {
    const el = e.target.closest(".phone-link");
    if (!el) return;
    e.preventDefault();
    const phone = el.getAttribute("data-phone") || el.textContent.trim();
    if (!phone) return;

    if (isMobile) {
      // מעתיקים ללוח בלי הודעה חוסמת, ומיד לאחר מכן פותחים אקטיבית את חייגן המכשיר
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(phone).catch(() => {});
      }
      window.location.href = "tel:" + phone;
      return;
    }

    // במחשב - שתי פעולות יחד, ובכוונה:
    // 1. העתקה ללוח, שממשיכה לעבוד עם F7+Enter בדיוק כמו עד היום.
    // 2. ניסיון חיוג ישיר דרך tel:, שאפליקציית 3CX במחשב נרשמת לטפל בו.
    //    אם היא מותקנת - השיחה יוצאת מיד ואין צורך ב-F7. אם לא - שום דבר
    //    לא קורה והמספר עדיין בלוח. כלומר אין מה להפסיד.
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(phone)
        .then(() => showToast("מחייג ל-" + phone + " · אם השיחה לא יצאה — F7 ואז Enter"))
        .catch(() => showToast("המספר: " + phone));
    } else {
      showToast("המספר: " + phone);
    }
    // iframe נסתר ולא ניווט ישיר: מעבר לכתובת tel: שאין לה מטפל מוביל
    // בחלק מהדפדפנים לדף שגיאה, והמזכירה מאבדת את הכרטיס שפתחה.
    try {
      var f = document.getElementById("tel-frame");
      if (!f) {
        f = document.createElement("iframe");
        f.id = "tel-frame";
        f.style.display = "none";
        document.body.appendChild(f);
      }
      f.src = "tel:" + phone.replace(/[^\d+]/g, "");
    } catch (err) { /* אין 3CX מותקנת - ההעתקה לבדה מספיקה */ }
  });
})();
