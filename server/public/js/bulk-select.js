// עוזר משותף לבחירה מרובה ברשימות (תלמידים/משפחות וכו') -
// מנהל את תיבת הסימון "בחר הכל", את סרגל הכלים שמופיע כשיש בחירה, ואת אישור המחיקה.
function initBulkSelect(selectAllId, itemLabel) {
  function updateBulkToolbar() {
    const checked = document.querySelectorAll(".row-check:checked");
    const toolbar = document.getElementById("bulk-toolbar");
    const countText = document.getElementById("bulk-count-text");
    if (!toolbar || !countText) return;
    if (checked.length > 0) {
      toolbar.style.display = "flex";
      countText.textContent = checked.length + " נבחרו";
    } else {
      toolbar.style.display = "none";
    }
    const selectAll = document.getElementById(selectAllId);
    const allChecks = document.querySelectorAll(".row-check");
    if (selectAll) {
      selectAll.checked = allChecks.length > 0 && checked.length === allChecks.length;
    }
  }

  window.clearBulkSelection = function () {
    document.querySelectorAll(".row-check").forEach((c) => (c.checked = false));
    updateBulkToolbar();
  };

  window.confirmBulkDelete = function (label) {
    const n = document.querySelectorAll(".row-check:checked").length;
    return confirm(`האם למחוק ${n} ${label || itemLabel}? פעולה זו לא ניתנת לביטול.`);
  };

  document.querySelectorAll(".row-check").forEach((c) => c.addEventListener("change", updateBulkToolbar));
  const selectAll = document.getElementById(selectAllId);
  if (selectAll) {
    selectAll.addEventListener("change", () => {
      document.querySelectorAll(".row-check").forEach((c) => (c.checked = selectAll.checked));
      updateBulkToolbar();
    });
  }
}
