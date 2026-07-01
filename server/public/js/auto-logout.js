/**
 * auto-logout.js
 * מנתק אוטומטית לאחר 20 דקות ללא שימוש.
 * מתריע ב-18 דקות (2 דקות לפני).
 * מתחדש בכל אינטראקציה של המשתמש.
 */
(function () {
  const TIMEOUT_MS   = 20 * 60 * 1000; // 20 דקות
  const WARNING_MS   = 18 * 60 * 1000; // התראה ב-18 דקות
  const LOGOUT_URL   = "/logout-get";   // נתיב יציאה

  let warnTimer, logoutTimer;
  let warningShown = false;

  // --- בניית חלון ההתראה ---
  const overlay = document.createElement("div");
  overlay.id = "inactivity-overlay";
  overlay.style.cssText = `
    display:none; position:fixed; inset:0; z-index:99999;
    background:rgba(0,0,0,0.6); backdrop-filter:blur(3px);
    align-items:center; justify-content:center;
  `;
  overlay.innerHTML = `
    <div style="
      background:#fff; border-radius:16px; padding:32px 36px;
      max-width:420px; width:90%; text-align:center;
      box-shadow:0 8px 40px rgba(0,0,0,0.4); direction:rtl;
    ">
      <div style="font-size:2.5em; margin-bottom:10px;">⏱️</div>
      <h2 style="margin:0 0 8px; color:#1a3550; font-size:1.3em;">המערכת עומדת להתנתק</h2>
      <p style="color:#555; margin-bottom:6px; font-size:0.95em;">
        לא זוהה שימוש במשך זמן רב.
      </p>
      <p style="color:#c0392b; font-size:1.4em; font-weight:700; margin-bottom:20px;">
        תנתק אוטומטית בעוד <span id="countdown-sec">120</span> שניות
      </p>
      <button id="stay-btn" style="
        background:#2c5f7c; color:#fff; border:none; border-radius:8px;
        padding:11px 28px; font-size:1em; cursor:pointer; font-weight:600;
        margin-left:10px;
      ">המשך שימוש</button>
      <button id="logout-now-btn" style="
        background:transparent; color:#888; border:1px solid #ccc;
        border-radius:8px; padding:11px 20px; font-size:0.9em; cursor:pointer;
      ">התנתק עכשיו</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById("stay-btn").addEventListener("click", resetTimers);
  document.getElementById("logout-now-btn").addEventListener("click", doLogout);

  let countdownInterval;
  let secondsLeft = 120;

  function showWarning() {
    if (warningShown) return;
    warningShown = true;
    secondsLeft = 120;
    overlay.style.display = "flex";

    const cd = document.getElementById("countdown-sec");
    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      secondsLeft--;
      if (cd) cd.textContent = secondsLeft;
      if (secondsLeft <= 0) {
        clearInterval(countdownInterval);
        doLogout();
      }
    }, 1000);
  }

  function doLogout() {
    clearAll();
    // POST לניתוק
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/logout";
    const csrf = document.createElement("input");
    csrf.type = "hidden"; csrf.name = "_method"; csrf.value = "DELETE";
    form.appendChild(csrf);
    document.body.appendChild(form);
    form.submit();
  }

  function clearAll() {
    clearTimeout(warnTimer);
    clearTimeout(logoutTimer);
    clearInterval(countdownInterval);
  }

  function resetTimers() {
    clearAll();
    warningShown = false;
    overlay.style.display = "none";
    warnTimer   = setTimeout(showWarning, WARNING_MS);
    logoutTimer = setTimeout(doLogout, TIMEOUT_MS);
  }

  // אירועי משתמש שמחדשים את הטיימר
  const events = ["mousemove","mousedown","keydown","touchstart","scroll","click"];
  let activityDebounce;
  function onActivity() {
    if (warningShown) return; // אם ההתראה פעילה — לא מאפסים
    clearTimeout(activityDebounce);
    activityDebounce = setTimeout(resetTimers, 500);
  }
  events.forEach(e => document.addEventListener(e, onActivity, { passive: true }));

  // התחלה
  resetTimers();
})();
