const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");

const HEBREW_MONTH_NAMES = {
  1: "ניסן", 2: "אייר", 3: "סיון", 4: "תמוז", 5: "אב", 6: "אלול",
  7: "תשרי", 8: "חשון", 9: "כסלו", 10: "טבת", 11: "שבט", 12: "אדר", 13: "אדר ב'",
};
function hebrewMonthName(monthNum, year) {
  if (monthNum === 12 && hd.isHebrewLeapYear(year)) return "אדר א'";
  return HEBREW_MONTH_NAMES[monthNum] || "";
}

// מועדים קבועים לפי (חודש, יום) בלוח העברי - לא רשימה ממצה, רק החגים/מועדים
// המרכזיים, כדי שיופיעו על גבי הלוח החודשי
function hebrewHoliday(monthNum, day, year) {
  const key = `${monthNum}-${day}`;
  const fixed = {
    "7-1": "א' ראש השנה", "7-2": "ב' ראש השנה", "7-10": "יום כיפור",
    "7-15": "סוכות", "7-21": "הושענא רבה", "7-22": "שמיני עצרת / שמחת תורה",
    "9-25": "חנוכה", "11-15": "ט\"ו בשבט",
    "1-15": "פסח", "1-21": "שביעי של פסח", "2-18": "ל\"ג בעומר", "3-6": "שבועות",
    "5-9": "תשעה באב",
  };
  const purimMonth = hd.isHebrewLeapYear(year) ? 13 : 12;
  if (monthNum === purimMonth && day === 14) return "פורים";
  if (day === 1 && monthNum !== 7) return "ראש חודש";
  return fixed[key] || "";
}

function withDates(e) {
  return {
    ...e,
    event_date_str: hd.serialToGregorianString(e.event_date),
    event_date_hebrew_str: hd.serialToHebrewString(e.event_date),
    event_date_end_str: hd.serialToGregorianString(e.event_date_end),
  };
}

// ============ תצוגת לוח שנה חודשי - עם ניווט חודש/שנה, ולחיצה על יום פותחת יצירת אירוע ============
router.get("/calendar", (req, res) => {
  const today = new Date();
  const year = parseInt(req.query.year, 10) || today.getFullYear();
  const month = parseInt(req.query.month, 10) || (today.getMonth() + 1); // 1-12

  // טווח הלוח: מתחילים ביום ראשון שלפני (או ביום) ה-1 לחודש, מסיימים בשבת
  // שאחרי (או ב) היום האחרון בחודש - כך שיש תמיד שבועות שלמים בלוח
  const firstOfMonth = new Date(year, month - 1, 1);
  const lastOfMonth = new Date(year, month, 0);
  const gridStart = new Date(firstOfMonth);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const gridEnd = new Date(lastOfMonth);
  gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()));

  const pad = (n) => String(n).padStart(2, "0");
  const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const startSerial = hd.gregorianStringToSerial(toDateStr(gridStart));
  const endSerial = hd.gregorianStringToSerial(toDateStr(gridEnd));

  const events = db.prepare(`
    SELECT e.*, c.name AS class_name, c.parallel FROM events e
    LEFT JOIN classes c ON e.class_id = c.id
    WHERE e.event_date >= ? AND e.event_date <= ?
    ORDER BY e.event_date ASC
  `).all(startSerial, endSerial).map(withDates);
  const eventsByDate = {};
  events.forEach((e) => {
    // מפתח לפי YYYY-MM-DD (לא event_date_str, שזה DD/MM/YYYY לתצוגה) - כדי
    // שיתאים בדיוק למפתחות הימים בלוח
    const eventDateObj = hd.serialToDateObject(e.event_date);
    const key = `${eventDateObj.getUTCFullYear()}-${pad(eventDateObj.getUTCMonth() + 1)}-${pad(eventDateObj.getUTCDate())}`;
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(e);
  });

  const todayStr = toDateStr(today);
  const weeks = [];
  let cursor = new Date(gridStart);
  const hebMonthsInView = new Set();
  while (cursor <= gridEnd) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const dateStr = toDateStr(cursor);
      const serial = hd.gregorianStringToSerial(dateStr);
      const hebParts = hd.serialToHebrewParts(serial);
      const hebMonthLabel = hebrewMonthName(hebParts.month, hebParts.year);
      hebMonthsInView.add(hebMonthLabel);
      week.push({
        dateStr,
        day: cursor.getDate(),
        isCurrentMonth: cursor.getMonth() === month - 1,
        isToday: dateStr === todayStr,
        isSaturday: cursor.getDay() === 6,
        hebDay: hd.hebrewNumeral(hebParts.day),
        hebMonthLabel,
        showHebMonth: hebParts.day === 1,
        holiday: hebrewHoliday(hebParts.month, hebParts.day, hebParts.year),
        events: eventsByDate[dateStr] || [],
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  const monthNames = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
  let prevMonth = month - 1, prevYear = year;
  if (prevMonth < 1) { prevMonth = 12; prevYear--; }
  let nextMonth = month + 1, nextYear = year;
  if (nextMonth > 12) { nextMonth = 1; nextYear++; }

  res.render("events/calendar", {
    year, month, monthName: monthNames[month - 1], weeks,
    hebMonthsLabel: Array.from(hebMonthsInView).filter(Boolean).join("-"),
    prevMonth, prevYear, nextMonth, nextYear,
    todayMonth: today.getMonth() + 1, todayYear: today.getFullYear(),
  });
});

router.get("/", (req, res) => {
  const qs = req.query.year && req.query.month ? `?year=${req.query.year}&month=${req.query.month}` : "";
  res.redirect(`/events/calendar${qs}`);
});

router.get("/list", (req, res) => {
  const events = db
    .prepare(`
      SELECT e.*, c.name AS class_name, c.parallel,
        (SELECT COUNT(*) FROM event_registrations er WHERE er.event_id = e.id) AS registrations_count
      FROM events e
      LEFT JOIN classes c ON e.class_id = c.id
      ORDER BY e.event_date ASC
    `)
    .all()
    .map(withDates);

  const today = hd.todayAccessSerial();
  const upcoming = events.filter((e) => e.event_date >= today);
  const past = events.filter((e) => e.event_date < today);

  res.render("events/list", { upcoming, past });
});

router.get("/new", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("events/form", { event: { event_date: req.query.date || "" }, mode: "new", classes });
});

const EVENT_FIELDS = ["title", "description", "event_date", "event_date_end", "category", "class_id", "requires_registration", "price"];

function normalize(col, value) {
  if (value === undefined || value === "") return null;
  if (col === "event_date" || col === "event_date_end") return hd.gregorianStringToSerial(value);
  if (col === "requires_registration") return value === "on" || value === "1" ? 1 : 0;
  return value;
}

router.post("/", (req, res) => {
  const body = req.body;
  const cols = EVENT_FIELDS.filter((c) => c === "requires_registration" || c in body);
  const values = cols.map((c) => normalize(c, body[c]));
  const info = db
    .prepare(`INSERT INTO events (${cols.join(",")}, created_at) VALUES (${cols.map(() => "?").join(",")}, ?)`)
    .run(...values, new Date().toISOString());
  res.redirect(`/events/${info.lastInsertRowid}`);
});

router.get("/:id", (req, res) => {
  const event = withDates(
    db.prepare(`
      SELECT e.*, c.name AS class_name, c.parallel FROM events e
      LEFT JOIN classes c ON e.class_id = c.id WHERE e.id = ?
    `).get(req.params.id)
  );
  if (!event.id) return res.status(404).render("404");
  const registrations = db
    .prepare(`
      SELECT er.*, s.first_name, s.last_name FROM event_registrations er
      JOIN students s ON er.student_id = s.id WHERE er.event_id = ?
      ORDER BY s.last_name, s.first_name
    `)
    .all(req.params.id);
  const students = db.prepare("SELECT id, first_name, last_name FROM students WHERE status = 'פעיל' ORDER BY last_name, first_name").all();
  res.render("events/view", { event, registrations, students });
});

router.get("/:id/edit", (req, res) => {
  const event = db.prepare("SELECT * FROM events WHERE id = ?").get(req.params.id);
  if (!event) return res.status(404).render("404");
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("events/form", {
    event: {
      ...event,
      event_date: hd.serialToInputDate(event.event_date),
      event_date_end: hd.serialToInputDate(event.event_date_end),
    },
    mode: "edit", classes,
  });
});

router.put("/:id", (req, res) => {
  const body = req.body;
  const cols = EVENT_FIELDS.filter((c) => c === "requires_registration" || c in body);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => normalize(c, body[c]));
  values.push(req.params.id);
  db.prepare(`UPDATE events SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect(`/events/${req.params.id}`);
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM event_registrations WHERE event_id = ?").run(req.params.id);
  db.prepare("DELETE FROM events WHERE id = ?").run(req.params.id);
  res.redirect("/events");
});

router.post("/:id/register", (req, res) => {
  const { student_id } = req.body;
  if (student_id) {
    db.prepare("INSERT INTO event_registrations (event_id, student_id, created_at) VALUES (?,?,?)").run(
      req.params.id, student_id, new Date().toISOString()
    );
  }
  res.redirect(`/events/${req.params.id}`);
});

router.post("/:id/register/:regId/toggle-paid", (req, res) => {
  const reg = db.prepare("SELECT * FROM event_registrations WHERE id = ?").get(req.params.regId);
  if (reg) db.prepare("UPDATE event_registrations SET paid = ? WHERE id = ?").run(reg.paid ? 0 : 1, reg.id);
  res.redirect(`/events/${req.params.id}`);
});

router.delete("/:id/register/:regId", (req, res) => {
  db.prepare("DELETE FROM event_registrations WHERE id = ?").run(req.params.regId);
  res.redirect(`/events/${req.params.id}`);
});

module.exports = router;
