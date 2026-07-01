(function () {
  function loadPreview() {
    const el = document.getElementById("messages-preview");
    const badge = document.getElementById("unread-count-badge");
    if (!el) return;

    fetch("/messages/recent/json")
      .then((r) => r.json())
      .then((convs) => {
        // עדכון badge
        const totalUnread = convs.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
        if (badge) {
          badge.textContent = totalUnread;
          badge.style.display = totalUnread > 0 ? "inline" : "none";
        }

        if (!convs.length) {
          el.innerHTML = '<p class="personal-empty">אין שיחות</p>';
          return;
        }

        el.innerHTML = "";
        convs.forEach((c) => {
          const item = document.createElement("a");
          item.href = "/messages/" + c.otherId;
          item.className = "chat-preview-item" + (c.unread ? " chat-preview-unread" : "");

          const initial = c.otherName.charAt(0);
          const lastMsg = c.body
            ? `<span class="chat-preview-msg">${c.mine ? "אתה: " : ""}${c.body}</span>`
            : `<span class="chat-preview-msg chat-preview-empty">אין הודעות עדיין</span>`;

          item.innerHTML = `
            <div class="chat-preview-avatar">${initial}</div>
            <div class="chat-preview-text">
              <div class="chat-preview-top">
                <span class="chat-preview-name">${c.otherName}</span>
                ${c.unread ? `<span class="chat-preview-badge">${c.unreadCount}</span>` : ""}
              </div>
              ${lastMsg}
            </div>`;
          el.appendChild(item);
        });
      })
      .catch(() => {
        el.innerHTML = '<p class="personal-empty">לא ניתן לטעון</p>';
      });
  }
  loadPreview();
  setInterval(loadPreview, 15000);
})();
