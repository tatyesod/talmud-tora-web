/**
 * shared-tasks.js
 * לוח משימות משותף — מתעדכן אוטומטית כל 15 שניות
 */
(function () {
  const listEl = document.getElementById("shared-tasks-list");
  const formEl = document.getElementById("shared-task-form");
  const titleEl = document.getElementById("shared-task-title");
  const assignEl = document.getElementById("shared-task-assign");
  if (!listEl) return;

  function renderTask(t) {
    const wrap = document.createElement("div");
    wrap.className = "shared-task-item" + (t.done ? " shared-task-done" : "");
    wrap.dataset.id = t.id;
    wrap.innerHTML = `
      <span class="shared-task-dot ${t.done ? 'done' : 'pending'}"></span>
      <span class="shared-task-title">${t.title}</span>
      <span class="shared-task-assign">${t.assigned_label || 'כולם'}</span>
      <span class="shared-task-creator">${t.created_by_name || ''}</span>
      <div class="shared-task-actions">
        ${!t.done
          ? `<button class="stbtn stbtn-done" onclick="sharedTaskDone(${t.id})">✓ בוצע</button>`
          : `<button class="stbtn stbtn-undo" onclick="sharedTaskUndone(${t.id})">↩</button>`}
        <button class="stbtn stbtn-del" onclick="sharedTaskDelete(${t.id})">✕</button>
      </div>`;
    return wrap;
  }

  function loadTasks() {
    fetch("/api/shared-tasks")
      .then(r => r.json())
      .then(tasks => {
        listEl.innerHTML = "";
        if (!tasks.length) {
          listEl.innerHTML = '<span style="color:#7c8a96; font-size:0.85em;">אין משימות משותפות</span>';
          return;
        }
        tasks.forEach(t => listEl.appendChild(renderTask(t)));
      })
      .catch(() => {});
  }

  window.openAddSharedTask = () => {
    formEl.style.display = "flex";
    titleEl.focus();
  };
  window.closeAddSharedTask = () => {
    formEl.style.display = "none";
    titleEl.value = "";
  };
  window.submitSharedTask = () => {
    const title = titleEl.value.trim();
    if (!title) return titleEl.focus();
    fetch("/api/shared-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, assigned_label: assignEl?.value || "כולם" }),
    }).then(() => {
      closeAddSharedTask();
      loadTasks();
    });
  };
  window.sharedTaskDone = (id) => {
    fetch(`/api/shared-tasks/${id}/done`, { method: "POST" }).then(loadTasks);
  };
  window.sharedTaskUndone = (id) => {
    fetch(`/api/shared-tasks/${id}/undone`, { method: "POST" }).then(loadTasks);
  };
  window.sharedTaskDelete = (id) => {
    fetch(`/api/shared-tasks/${id}`, { method: "DELETE" }).then(loadTasks);
  };

  // Enter לשמירה
  document.addEventListener("keydown", e => {
    if (e.key === "Enter" && document.activeElement === titleEl) submitSharedTask();
    if (e.key === "Escape" && formEl.style.display !== "none") closeAddSharedTask();
  });

  loadTasks();
  setInterval(loadTasks, 15000);
})();
