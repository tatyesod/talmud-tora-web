(function () {
  function loadPreview() {
    const el = document.getElementById("messages-preview");
    const panel = document.getElementById("messages-panel");
    const badge = document.getElementById("unread-count-badge");
    if (!el) return;

    fetch("/messages/recent/json")
      .then((r) => r.json())
      .then((msgs) => {
        // מציגים רק הודעות נכנסות שלא נקראו
        const unread = msgs.filter((m) => !m.mine && m.unread);
        if (panel) panel.style.display = unread.length > 0 ? "flex" : "none";
        if (badge) badge.textContent = unread.length;

        if (!unread.length) {
          el.innerHTML = '<p class="personal-empty">אין הודעות חדשות</p>';
          return;
        }
        el.innerHTML = "";
        unread.forEach((m) => {
          const a = document.createElement("a");
          a.href = "/messages/" + m.otherId;
          a.className = "msg-preview-item";
          a.innerHTML = `
            <span class="msg-preview-dot"></span>
            <div>
              <span class="msg-preview-name">${m.otherName}</span>
              <span class="msg-preview-body">${m.body}</span>
            </div>`;
          el.appendChild(a);
        });
      })
      .catch(() => {});
  }
  loadPreview();
  setInterval(loadPreview, 15000);
})();
