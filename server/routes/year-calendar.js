const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const { getCurrentYear } = require("../yearManager");

// שמות החודשים לפי המספור הפנימי של hebrewDate. אומת בפועל:
// המספור מתחיל בניסן (1), ותשרי הוא 7. בשנה מעוברת נוסף חודש 13.
const MONTH_NAMES = {
  1: "ניסן", 2: "אייר", 3: "סיון", 4: "תמוז", 5: "אב", 6: "אלול",
  7: "תשרי", 8: "חשון", 9: "כסלו", 10: "טבת", 11: "שבט", 12: "אדר", 13: "אדר ב'",
};
function monthName(m, leap) {
  if (leap && m === 12) return "אדר א'";
  return MONTH_NAMES[m] || ("חודש " + m);
}

// סדר התצוגה: שנת הלימודים מתחילה באלול ולא בניסן, ולכן החודשים
// מוצגים לפי סדר השנה הלימודית ולא לפי המספור הפנימי.
const SCHOOL_ORDER = [6, 7, 8, 9, 10, 11, 12, 13, 1, 2, 3, 4, 5];
function schoolIndex(m) {
  const i = SCHOOL_ORDER.indexOf(m);
  return i === -1 ? 99 : i;
}

// רשימה לבורר, בסדר שנת הלימודים
function monthOptions(leap) {
  return SCHOOL_ORDER
    .filter((m) => leap || m !== 13)
    .map((m) => ({ value: m, label: monthName(m, leap) }));
}

// המרת חודש+יום עברי לתאריך מוחלט בשנה העברית הנוכחית.
// זה הלב: כ"ח חשון נופל בתאריך לועזי אחר בכל שנה, ולכן החישוב נעשה
// מחדש בכל טעינה ולא נשמר.
function taskDates(task) {
  const todayParts = hd.todayHebrewParts();
  const yearNum = todayParts.year;
  const leap = hd.isHebrewLeapYear(yearNum);

  // יום שאינו קיים בחודש (ל' בחודש בן 29) - נדחף ליום האחרון
  const maxDay = hd.daysInHebrewMonth(yearNum, task.hebrew_month) || 30;
  const day = Math.min(task.hebrew_day, maxDay);

  const todayAbs = hd.todayAbsolute();

  // מועד ההופעה הבא. אם התאריך של השנה הזו כבר חלף, מציגים את זה של
  // השנה הבאה - אחרת כל הלוח היה נראה "חלף" מיד אחרי שהמשימה בוצעה,
  // וזה חסר תועלת. משימה שחלפה וטרם סומנה מטופלת בנפרד (wasMissed).
  let abs, occursIn = yearNum;
  try {
    abs = hd.hebrewPartsToAbsolute(yearNum, task.hebrew_month, day);
    if (abs < todayAbs) {
      const nextMax = hd.daysInHebrewMonth(yearNum + 1, task.hebrew_month) || 30;
      abs = hd.hebrewPartsToAbsolute(yearNum + 1, task.hebrew_month, Math.min(task.hebrew_day, nextMax));
      occursIn = yearNum + 1;
    }
  } catch (e) { return null; }

  const daysUntil = abs - todayAbs;
  const remindFrom = (task.remind_days_before === null || task.remind_days_before === undefined)
    ? 14 : task.remind_days_before;

  return {
    absolute: abs,
    serial: hd.absoluteToAccessSerial(abs),
    hebrewLabel: hd.hebrewNumeral(day) + " " + monthName(task.hebrew_month, leap),
    gregorian: hd.serialToGregorianString(hd.absoluteToAccessSerial(abs)),
    daysUntil,
    occursIn,
    isDue: daysUntil <= remindFrom && daysUntil >= 0,
    // "פוספסה": המועד של השנה הנוכחית חלף, כלומר המשימה כבר מצביעה
    // לשנה הבאה. אם גם לא סומנה כבוצעה - כדאי לשים לב.
    isPast: occursIn > yearNum,
  };
}

function loadTasks() {
  const year = getCurrentYear();
  const rows = db.prepare(`
    SELECT t.*, d.done_at, d.note AS done_note, u.display_name AS done_by
    FROM year_tasks t
    LEFT JOIN year_task_done d ON d.task_id = t.id AND d.year_label = ?
    LEFT JOIN users u ON u.id = d.done_by_user_id
    WHERE t.active = 1
    ORDER BY t.hebrew_day, t.sort_order
  `).all(year);

  // מיון לפי סדר שנת הלימודים - אלול ראשון, לא ניסן
  rows.sort((a, b) => schoolIndex(a.hebrew_month) - schoolIndex(b.hebrew_month) ||
                      a.hebrew_day - b.hebrew_day);
  return rows.map((t) => {
    const dates = taskDates(t);
    return { ...t, ...(dates || {}), done: !!t.done_at,
             done_str: t.done_at ? hd.formatGregorian(t.done_at) : "" };
  }).filter((t) => t.absolute);
}

// המשימות שכדאי להתריע עליהן עכשיו - לשימוש דף הבית
function dueTasks() {
  return loadTasks().filter((t) => !t.done && t.isDue);
}

// ============ המסך ============
router.get("/", (req, res) => {
  const tasks = loadTasks();
  const year = getCurrentYear();
  const leap = hd.isHebrewLeapYear(hd.todayHebrewParts().year);

  // קיבוץ לפי חודש, בסדר השנה
  const byMonth = [];
  for (const t of tasks) {
    let g = byMonth.find((x) => x.month === t.hebrew_month);
    if (!g) { g = { month: t.hebrew_month, name: monthName(t.hebrew_month, leap), items: [] }; byMonth.push(g); }
    g.items.push(t);
  }

  res.render("year-calendar/index", {
    byMonth, year,
    total: tasks.length,
    doneCount: tasks.filter((t) => t.done).length,
    dueCount: tasks.filter((t) => !t.done && t.isDue).length,
    months: monthOptions(leap),
    saved: req.query.saved || null,
  });
});

router.get("/new", (req, res) => {
  const leap = hd.isHebrewLeapYear(hd.todayHebrewParts().year);
  res.render("year-calendar/form", {
    task: { remind_days_before: 14, active: 1, sort_order: 50 },
    months: monthOptions(leap), mode: "new",
  });
});

router.get("/:id/edit", (req, res) => {
  const task = db.prepare("SELECT * FROM year_tasks WHERE id = ?").get(req.params.id);
  if (!task) return res.redirect("/year-calendar");
  const leap = hd.isHebrewLeapYear(hd.todayHebrewParts().year);
  res.render("year-calendar/form", {
    task, months: monthOptions(leap), mode: "edit",
  });
});

const FIELDS = ["title", "notes", "hebrew_month", "hebrew_day",
                "remind_days_before", "scope", "link_url", "sort_order"];

router.post("/", (req, res) => {
  const b = req.body;
  db.prepare(`INSERT INTO year_tasks
    (title, notes, hebrew_month, hebrew_day, remind_days_before, scope, link_url, sort_order, active, created_at)
    VALUES (?,?,?,?,?,?,?,?,1,?)`).run(
    String(b.title || "").trim(), String(b.notes || "").trim(),
    parseInt(b.hebrew_month, 10) || 1, parseInt(b.hebrew_day, 10) || 1,
    parseInt(b.remind_days_before, 10) || 14,
    String(b.scope || "").trim(), String(b.link_url || "").trim(),
    parseInt(b.sort_order, 10) || 50, new Date().toISOString()
  );
  res.redirect("/year-calendar?saved=1");
});

router.post("/:id", (req, res) => {
  const b = req.body;
  db.prepare(`UPDATE year_tasks SET title=?, notes=?, hebrew_month=?, hebrew_day=?,
    remind_days_before=?, scope=?, link_url=?, sort_order=? WHERE id=?`).run(
    String(b.title || "").trim(), String(b.notes || "").trim(),
    parseInt(b.hebrew_month, 10) || 1, parseInt(b.hebrew_day, 10) || 1,
    parseInt(b.remind_days_before, 10) || 14,
    String(b.scope || "").trim(), String(b.link_url || "").trim(),
    parseInt(b.sort_order, 10) || 50, req.params.id
  );
  res.redirect("/year-calendar?saved=1");
});

// סימון ביצוע לשנה הנוכחית. ידני בכוונה: לכל משימה מדד אחר, ואין דרך
// אמינה להסיק "בוצע" מהנתונים בלי לטעות.
router.post("/:id/done", (req, res) => {
  const year = getCurrentYear();
  const undo = req.body.undo === "1";
  if (undo) {
    db.prepare("DELETE FROM year_task_done WHERE task_id = ? AND year_label = ?").run(req.params.id, year);
  } else {
    db.prepare(`INSERT OR REPLACE INTO year_task_done
      (task_id, year_label, done_at, done_by_user_id, note) VALUES (?,?,?,?,?)`).run(
      req.params.id, year, new Date().toISOString(),
      req.currentUser ? req.currentUser.id : null, String(req.body.note || "").trim()
    );
  }
  res.redirect("/year-calendar");
});

router.post("/:id/delete", (req, res) => {
  db.prepare("UPDATE year_tasks SET active = 0 WHERE id = ?").run(req.params.id);
  res.redirect("/year-calendar?saved=deleted");
});

// ============ הזנה ליומן גוגל ============
// גוגל מושך מכתובת זו לבד. חד-כיווני - מהמערכת ליומן - וזה הכיוון הנדרש.
// ללא אימות, ולכן הכתובת אינה מכילה מידע רגיש: רק כותרות משימות.
router.get("/feed.ics", (req, res) => {
  const tasks = loadTasks();
  const esc = (s) => String(s || "").replace(/[\\;,]/g, (m) => "\\" + m).replace(/\n/g, "\\n");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//talmud-tora//year-calendar//HE\r\n";
  ics += "CALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:לוח שנת הלימודים\r\n";
  for (const t of tasks) {
    const d = hd.serialToDateObject(t.serial);
    if (!d) continue;
    const ymd = d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    ics += "BEGIN:VEVENT\r\n";
    ics += "UID:yt-" + t.id + "-" + ymd + "@talmud-tora\r\n";
    ics += "DTSTAMP:" + stamp + "\r\n";
    ics += "DTSTART;VALUE=DATE:" + ymd + "\r\n";
    ics += "SUMMARY:" + esc(t.title) + "\r\n";
    const desc = [t.hebrewLabel, t.scope, t.notes].filter(Boolean).join(" · ");
    if (desc) ics += "DESCRIPTION:" + esc(desc) + "\r\n";
    // תזכורת מראש, לפי מה שהוגדר במשימה
    ics += "BEGIN:VALARM\r\nTRIGGER:-P" + (t.remind_days_before || 14) + "D\r\n";
    ics += "ACTION:DISPLAY\r\nDESCRIPTION:" + esc(t.title) + "\r\nEND:VALARM\r\n";
    ics += "END:VEVENT\r\n";
  }
  ics += "END:VCALENDAR\r\n";

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.send(ics);
});

module.exports = router;
module.exports.dueTasks = dueTasks;
