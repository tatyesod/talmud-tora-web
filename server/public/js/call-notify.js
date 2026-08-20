// call-notify.js — התראת מערכת על שיחה נכנסת.
//
// למה כך ולא חלון קופץ: דפדפן אינו מרשה לאתר לפתוח חלון בלי לחיצת
// משתמש, וזו הגנה שאי אפשר ולא נכון לעקוף. התראת מערכת כן מותרת,
// מופיעה גם כשהחלון ממוזער או מאחורי תוכנות אחרות, ולחיצה עליה
// פותחת את הכרטיס.
//
// דורש שהמערכת תהיה פתוחה - ולו בלשונית ברקע.

(function () {
  if (!("Notification" in window)) return;

  // מבקשים רשות פעם אחת. בלי אישור אין התראות, ולכן זה חייב לקרות
  // מוקדם ולא ברגע השיחה.
  if (Notification.permission === "default") {
    Notification.requestPermission();
  }

  var since = new Date().toISOString();
  var seen = {};
  var POLL_MS = 4000;      // מספיק תכוף לשיחה, לא מעמיס על השרת

  function ring() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      // שני צלילים קצרים - נבדל מצליל ההודעות הרגיל
      [0, 0.22].forEach(function (t) {
        var osc = ctx.createOscillator(), g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.frequency.setValueAtTime(1046, ctx.currentTime + t);
        g.gain.setValueAtTime(0.3, ctx.currentTime + t);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.18);
        osc.start(ctx.currentTime + t);
        osc.stop(ctx.currentTime + t + 0.18);
      });
    } catch (e) { /* אין שמע - ההתראה עדיין מוצגת */ }
  }

  function notify(call) {
    var title = call.matched_title
      ? "📞 " + call.matched_title
      : "📞 שיחה נכנסת";
    var body = call.matched_title
      ? (call.matched_subtitle || "") + (call.matched_subtitle ? " · " : "") + call.number
      : call.number + " — אינו מוכר במערכת";

    if (Notification.permission === "granted") {
      var n = new Notification(title, {
        body: body,
        icon: "/images/icon-192.png",
        // tag קבוע: שיחה חדשה מחליפה את הקודמת במקום לערום התראות
        tag: "incoming-call",
        requireInteraction: true,   // נשארת עד שלוחצים - שיחה לא נעלמת
      });
      n.onclick = function () {
        window.focus();
        if (call.target_url) window.location.href = call.target_url;
        n.close();
      };
    }
    ring();
  }

  function poll() {
    fetch("/phone/recent.json?since=" + encodeURIComponent(since), {
      credentials: "same-origin",
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        since = d.now;
        (d.calls || []).reverse().forEach(function (c) {
          if (seen[c.id]) return;
          seen[c.id] = true;
          notify(c);
        });
      })
      .catch(function () { /* נפילת רשת - ננסה בסבב הבא */ });
  }

  setInterval(poll, POLL_MS);
})();
