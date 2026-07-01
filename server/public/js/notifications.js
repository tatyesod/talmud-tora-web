// התראות שולחן עבודה + צליל עם קבלת הודעה חדשה
(function () {
  let lastUnread = null;

  // יצירת צליל התראה (Web Audio API — ללא קובץ חיצוני)
  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.35, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch (e) {
      // Web Audio לא זמין — ממשיכים בלי צליל
    }
  }

  // בקשת הרשאה להצגת התראות
  function requestPermission() {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }

  function showNotification(senderName, msgBody) {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
      const n = new Notification("הודעה חדשה מ-" + senderName, {
        body: msgBody,
        icon: "/images/logo.png",
        dir: "rtl",
        lang: "he",
      });
      n.onclick = () => {
        window.focus();
        n.close();
      };
      setTimeout(() => n.close(), 6000);
    }
    playNotificationSound();
  }

  // בדיקת הודעות חדשות כל 15 שניות
  function checkMessages() {
    fetch("/messages/recent/json")
      .then((r) => r.json())
      .then((msgs) => {
        // סופרים הודעות שלא שלחתי (שנשלחו אלי)
        const incomingCount = msgs.filter((m) => !m.mine).length;
        if (lastUnread === null) {
          lastUnread = incomingCount;
          return;
        }
        if (incomingCount > lastUnread) {
          // יש הודעה חדשה שלא שלחתי
          const newMsg = msgs.find((m) => !m.mine);
          if (newMsg) showNotification(newMsg.otherName, newMsg.body);
        }
        lastUnread = incomingCount;
      })
      .catch(() => {});
  }

  // מבקשים הרשאה בטעינה הראשונה
  requestPermission();
  // בדיקה ראשונה אחרי 3 שניות (כדי לאתחל את lastUnread), ואז כל 15 שניות
  setTimeout(() => {
    checkMessages();
    setInterval(checkMessages, 15000);
  }, 3000);
})();
