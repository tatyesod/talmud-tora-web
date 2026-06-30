// לחיצה על מספר טלפון: מעתיקה את המספר ללוח (כמו Ctrl+C),
// ומציגה הודעה קצרה. הערה: דפדפן לא יכול לדמות לחיצות מקלדת (F7+Enter)
// ברמת מערכת ההפעלה כלפי תוכנה חיצונית (חסימת אבטחה של דפדפנים) -
// לכן השלב של F7+Enter בתוכנת החיוג עדיין נדרש באופן ידני, אך כבר
// המספר מועתק אוטומטית ומוכן בלוח.
(function () {
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
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(phone)
        .then(() => showToast("המספר " + phone + " הועתק — כעת לחצו F7 ואז Enter בתוכנת החיוג"))
        .catch(() => showToast("לא ניתן היה להעתיק אוטומטית — המספר: " + phone));
    } else {
      showToast("המספר: " + phone);
    }
  });
})();
