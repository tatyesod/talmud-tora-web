(function () {
  function loadPreview() {
    const el = document.getElementById("messages-preview");
    if (!el) return;
    fetch("/messages/recent/json")
      .then((r) => r.json())
      .then((msgs) => {
        if (!msgs.length) {
          el.innerHTML = '<p class="personal-empty">אין הודעות עדיין</p>';
          return;
        }
        el.innerHTML = "";
        msgs.forEach((m) => {
          const div = document.createElement("a");
          div.href = "/messages/" + m.otherId;
          div.className = "msg-preview-item";
          div.style.display = "block";
          div.style.textDecoration = "none";
          div.innerHTML = `<span class="msg-preview-name">${m.mine ? "אל " : ""}${m.otherName}</span><span class="msg-preview-body">${m.body}</span>`;
          el.appendChild(div);
        });
      })
      .catch(() => {
        el.innerHTML = '<p class="personal-empty">לא ניתן לטעון</p>';
      });
  }
  loadPreview();
  setInterval(loadPreview, 20000);
})();
