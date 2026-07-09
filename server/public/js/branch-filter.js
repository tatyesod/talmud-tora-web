/**
 * branch-filter.js
 * סינון כיתות לפי סניף — משמש בדפי דוחות, מדבקות, יומן כיתה ועוד.
 * כל רכיב כיתה צריך להיות עם data-branch="שם הסניף"
 */
(function () {
  function applyBranchFilter(branchValue) {
    // dropdowns — option elements
    document.querySelectorAll("select[data-branch-filter] option").forEach(opt => {
      if (!opt.value || !opt.getAttribute("data-branch")) return;
      const matches = !branchValue || opt.getAttribute("data-branch") === branchValue;
      opt.style.display = matches ? "" : "none";
      if (!matches && opt.selected) {
        opt.selected = false;
        opt.parentElement.value = "";
      }
    });

    // checkboxes — label wrappers
    document.querySelectorAll("[data-branch-item]").forEach(el => {
      const b = el.getAttribute("data-branch-item");
      const matches = !branchValue || b === branchValue;
      el.style.display = matches ? "" : "none";
      const cb = el.querySelector("input[type='checkbox']");
      if (!cb) return;
      if (!matches) {
        // כיתה שלא בסניף שנבחר - תמיד מוסתרת ולא מסומנת
        cb.checked = false;
      } else if (branchValue) {
        // נבחר סניף ספציפי - מסמנים אוטומטית את כל הכיתות שלו,
        // כדי שהסינון באמת יפעל (ולא ייצא בטעות את כל הכיתות/הסניפים
        // רק כי אף תיבה לא סומנה ידנית)
        cb.checked = true;
      }
    });
  }

  function initBranchFilter(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.addEventListener("change", () => applyBranchFilter(sel.value));
    applyBranchFilter(sel.value);
  }

  window.BranchFilter = { init: initBranchFilter, apply: applyBranchFilter };
})();
