/**
 * shared-tasks.js — משימות משותפות עם popup לפרטים
 */
(function () {
  const listEl   = document.getElementById("shared-tasks-list");
  const formEl   = document.getElementById("shared-task-form");
  const titleEl  = document.getElementById("shared-task-title");
  const assignEl = document.getElementById("shared-task-assign");
  if (!listEl) return;

  let allTasks = [];
  let activeTaskId = null;

  // ===== הצגת רשימה =====
  function renderTask(t) {
    const div = document.createElement("div");
    div.className = "shared-task-item" + (t.done ? " shared-task-done" : "");
    div.dataset.id = t.id;
    div.style.cursor = "pointer";
    div.title = "לחץ לפרטים";
    div.innerHTML = `
      <span class="shared-task-dot ${t.done ? 'done' : 'pending'}"></span>
      <span class="shared-task-title">${t.title}</span>
      <span class="shared-task-assign">${t.assigned_label || 'כולם'}</span>`;
    div.addEventListener("click", () => openTaskDetail(t));
    return div;
  }

  function loadTasks() {
    fetch("/api/shared-tasks")
      .then(r => r.json())
      .then(tasks => {
        allTasks = tasks;
        listEl.style.display = "flex";
        listEl.style.flexDirection = "column";
        listEl.style.gap = "0";
        listEl.innerHTML = "";
        if (!tasks.length) {
          listEl.innerHTML = '<span style="color:#7c8a96; font-size:0.85em;">אין משימות משותפות</span>';
          return;
        }
        tasks.forEach(t => listEl.appendChild(renderTask(t)));
        // עדכון popup אם פתוח
        if (activeTaskId) {
          const updated = tasks.find(t => t.id === activeTaskId);
          if (updated) openTaskDetail(updated);
          else closeTaskDetail();
        }
      })
      .catch(() => {});
  }

  // ===== Popup פרטי משימה =====
  window.openTaskDetail = function(t) {
    activeTaskId = t.id;
    const overlay = document.getElementById("task-detail-overlay");
    if (!overlay) return;
    document.getElementById("td-title").textContent = t.title;
    document.getElementById("td-assign").textContent = "→ " + (t.assigned_label || "כולם");
    document.getElementById("td-creator-name").textContent = t.created_by_name || "";
    document.getElementById("td-done-btn").style.display  = t.done ? "none" : "";
    document.getElementById("td-undo-btn").style.display  = t.done ? "" : "none";
    overlay.style.display = "flex";
  };

  window.closeTaskDetail = function() {
    activeTaskId = null;
    const overlay = document.getElementById("task-detail-overlay");
    if (overlay) overlay.style.display = "none";
  };

  window.tdAction = function(action) {
    if (!activeTaskId) return;
    const id = activeTaskId;
    let url, method;
    if      (action === "done")   { url = `/api/shared-tasks/${id}/done`;   method = "POST"; }
    else if (action === "undone") { url = `/api/shared-tasks/${id}/undone`; method = "POST"; }
    else if (action === "delete") { url = `/api/shared-tasks/${id}`;        method = "DELETE"; }
    fetch(url, { method }).then(() => {
      if (action === "delete") closeTaskDetail();
      loadTasks();
    });
  };

  // ===== טופס הוספה =====
  window.openAddSharedTask = () => {
    formEl.style.display = "block";
    setTimeout(() => titleEl.focus(), 50);
  };
  window.closeAddSharedTask = () => {
    formEl.style.display = "none";
    titleEl.value = "";
  };
  window.submitSharedTask = () => {
    const title = titleEl.value.trim();
    if (!title) { titleEl.style.borderColor = "#e05555"; titleEl.focus(); return; }
    titleEl.style.borderColor = "";
    fetch("/api/shared-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, assigned_label: assignEl?.value || "כולם" }),
    }).then(() => { closeAddSharedTask(); loadTasks(); });
  };

  // קיצורי מקלדת
  document.addEventListener("keydown", e => {
    if (e.key === "Enter" && document.activeElement === titleEl) submitSharedTask();
    if (e.key === "Escape") {
      if (formEl.style.display !== "none") closeAddSharedTask();
      closeTaskDetail();
    }
  });

  loadTasks();
  setInterval(loadTasks, 15000);
})();
