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

// סדר החודשים העבריים בתוך שנה (מתחיל בתשרי, ראש השנה) - לצורך ניווט "חודש
// קודם/הבא" נכון. בשנה מעוברת יש גם אדר ב' (13) אחרי אדר א' (12).
function hebrewMonthOrder(year) {
  return hd.isHebrewLeapYear(year)
    ? [7, 8, 9, 10, 11, 12, 13, 1, 2, 3, 4, 5, 6]
    : [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6];
}
function nextHebrewMonth(year, month) {
  const order = hebrewMonthOrder(year);
  const idx = order.indexOf(month);
  if (idx === order.length - 1) return { year: year + 1, month: 7 };
  return { year, month: order[idx + 1] };
}
function prevHebrewMonth(year, month) {
  const order = hebrewMonthOrder(year);
  const idx = order.indexOf(month);
  if (idx === 0) {
    const prevOrder = hebrewMonthOrder(year - 1);
    return { year: year - 1, month: prevOrder[prevOrder.length - 1] };
  }
  return { year, month: order[idx - 1] };
}

// ============ תצוגת לוח שנה חודשי עברי - עם ניווט חודש/שנה עברי, ולחיצה על
// יום פותחת יצירת אירוע. התאריך הלועזי מוצג כמידע משני. ============
// ============ חופשות מוסד - תקופות שמסומנות בצבע שונה בלוח השנה ============
function hebrewDateOptions() {
  const todayParts = hd.todayHebrewParts();
  const days = Array.from({ length: 30 }, (_, i) => i + 1);
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((m) => ({ value: m, label: hebrewMonthName(m, todayParts.year) }));
  const years = [];
  for (let y = todayParts.year - 1; y <= todayParts.year + 3; y++) years.push(y);
  return { days, months, years, todayParts };
}

router.get("/vacations", (req, res) => {
  const vacations = db.prepare("SELECT * FROM vacations ORDER BY start_date DESC").all().map((v) => ({
    ...v,
    start_str: hd.serialToHebrewString(v.start_date),
    end_str: hd.serialToHebrewString(v.end_date),
  }));
  res.render("events/vacations", { vacations, ...hebrewDateOptions() });
});

router.post("/vacations", (req, res) => {
  const { title, start_day, start_month, start_year, end_day, end_month, end_year } = req.body;
  if (!title || !start_day || !start_month || !start_year || !end_day || !end_month || !end_year) {
    return res.redirect("/events/vacations");
  }
  const startAbs = hd.hebrewPartsToAbsolute(parseInt(start_year, 10), parseInt(start_month, 10), parseInt(start_day, 10));
  const endAbs = hd.hebrewPartsToAbsolute(parseInt(end_year, 10), parseInt(end_month, 10), parseInt(end_day, 10));
  const startSerial = hd.absoluteToAccessSerial(startAbs);
  const endSerial = hd.absoluteToAccessSerial(endAbs);
  db.prepare("INSERT INTO vacations (title, start_date, end_date, created_at) VALUES (?,?,?,?)").run(
    title, Math.min(startSerial, endSerial), Math.max(startSerial, endSerial), new Date().toISOString()
  );
  res.redirect("/events/vacations");
});

router.delete("/vacations/:id", (req, res) => {
  db.prepare("DELETE FROM vacations WHERE id = ?").run(req.params.id);
  res.redirect("/events/vacations");
});

router.get("/calendar", (req, res) => {
  const todayParts = hd.todayHebrewParts();
  const year = parseInt(req.query.year, 10) || todayParts.year;
  const month = parseInt(req.query.month, 10) || todayParts.month;

  const pad = (n) => String(n).padStart(2, "0");
  const gregKeyOf = (dateObj) => `${dateObj.getUTCFullYear()}-${pad(dateObj.getUTCMonth() + 1)}-${pad(dateObj.getUTCDate())}`;

  // טווח החודש העברי המבוקש (במונחי "יום אבסולוטי" - ספירה ליניארית, כדי
  // להימנע מהצורך לחשב תאריכים עבריים ידנית - הפונקציות הקיימות כבר עושות
  // את ההמרות בצורה מדויקת)
  const startAbsolute = hd.hebrewPartsToAbsolute(year, month, 1);
  const daysInMonth = hd.daysInHebrewMonth(month, year);
  const endAbsolute = startAbsolute + daysInMonth - 1;

  const startDateObj = hd.serialToDateObject(hd.absoluteToAccessSerial(startAbsolute));
  const endDateObj = hd.serialToDateObject(hd.absoluteToAccessSerial(endAbsolute));
  const gridStartAbsolute = startAbsolute - startDateObj.getUTCDay();
  const gridEndAbsolute = endAbsolute + (6 - endDateObj.getUTCDay());

  const startSerial = hd.absoluteToAccessSerial(gridStartAbsolute);
  const endSerial = hd.absoluteToAccessSerial(gridEndAbsolute);

  const events = db.prepare(`
    SELECT e.*, c.name AS class_name, c.parallel FROM events e
    LEFT JOIN classes c ON e.class_id = c.id
    WHERE e.event_date >= ? AND e.event_date <= ?
    ORDER BY e.event_date ASC
  `).all(startSerial, endSerial).map(withDates);
  const eventsByDate = {};
  events.forEach((e) => {
    const key = gregKeyOf(hd.serialToDateObject(e.event_date));
    if (!eventsByDate[key]) eventsByDate[key] = [];
    eventsByDate[key].push(e);
  });

  // חופשות מוסד שחופפות לטווח המוצג - לא לפי יום בודד, אלא לפי טווח (start-end)
  const vacations = db.prepare(`
    SELECT * FROM vacations WHERE start_date <= ? AND end_date >= ?
  `).all(endSerial, startSerial);
  function vacationOnSerial(serial) {
    return vacations.find((v) => serial >= v.start_date && serial <= v.end_date);
  }

  const todayKey = gregKeyOf(hd.serialToDateObject(hd.todayAccessSerial()));
  const weeks = [];
  let week = [];
  for (let absolute = gridStartAbsolute; absolute <= gridEndAbsolute; absolute++) {
    const serial = hd.absoluteToAccessSerial(absolute);
    const hebParts = hd.serialToHebrewParts(serial);
    const gregDateObj = hd.serialToDateObject(serial);
    const dateKey = gregKeyOf(gregDateObj);
    const hebMonthLabel = hebrewMonthName(hebParts.month, hebParts.year);
    const vacation = vacationOnSerial(serial);
    week.push({
      dateStr: hd.serialToInputDate(serial),
      hebDay: hd.hebrewNumeral(hebParts.day),
      hebMonthLabel,
      showHebMonth: hebParts.day === 1,
      gregDay: gregDateObj.getUTCDate(),
      gregMonthShort: gregDateObj.getUTCMonth() + 1,
      isCurrentMonth: hebParts.month === month && hebParts.year === year,
      isToday: dateKey === todayKey,
      isSaturday: gregDateObj.getUTCDay() === 6,
      holiday: hebrewHoliday(hebParts.month, hebParts.day, hebParts.year),
      isVacation: !!vacation,
      vacationTitle: vacation ? vacation.title : "",
      events: eventsByDate[dateKey] || [],
    });
    if (week.length === 7) { weeks.push(week); week = []; }
  }

  const prev = prevHebrewMonth(year, month);
  const next = nextHebrewMonth(year, month);

  const yearOptions = [];
  for (let y = year - 3; y <= year + 3; y++) yearOptions.push({ value: y, label: hd.formatHebrewYear(y) });

  res.render("events/calendar", {
    year, month, monthName: hebrewMonthName(month, year), hebrewYearLabel: hd.formatHebrewYear(year), weeks,
    gregRangeLabel: `${hd.serialToGregorianString(startSerial)} - ${hd.serialToGregorianString(endSerial)}`,
    prevMonth: prev.month, prevYear: prev.year, nextMonth: next.month, nextYear: next.year,
    todayMonth: todayParts.month, todayYear: todayParts.year,
    allMonthOptions: hebrewMonthOrder(year).map((m) => ({ value: m, label: hebrewMonthName(m, year) })),
    yearOptions,
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
