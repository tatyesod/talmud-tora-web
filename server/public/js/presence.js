(function () {
  function ping() {
    fetch("/presence/ping", { method: "POST" }).catch(() => {});
  }
  ping();
  setInterval(ping, 30000);

  function renderPresence() {
    const list = document.getElementById("presence-list");
    if (!list) return;
    fetch("/presence/list")
      .then((r) => r.json())
      .then((users) => {
        list.innerHTML = "";
        users.forEach((u) => {
          const li = document.createElement("li");
          li.className = "presence-item";
          li.innerHTML = `<span class="presence-dot ${u.online ? "online" : "offline"}"></span><span>${u.name}</span>`;
          list.appendChild(li);
        });
      })
      .catch(() => {
        list.innerHTML = '<li class="presence-loading">לא ניתן לטעון</li>';
      });
  }
  renderPresence();
  setInterval(renderPresence, 15000);
})();
