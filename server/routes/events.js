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
  const days = Array.from({ length: 30 }, (_, i) => ({ value: i + 1, label: hd.hebrewNumeral(i + 1) }));
  const months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((m) => ({ value: m, label: hebrewMonthName(m, todayParts.year) }));
  const years = [];
  for (let y = todayParts.year - 1; y <= todayParts.year + 3; y++) years.push({ value: y, label: hd.formatHebrewYear(y) });
  return { days, months, years, todayParts };
}

// ============ פיד יומן (ICS) להרשמה חד-פעמית ביומן גוגל - חד-כיווני ============
// מייצר קובץ ICS תקני עם כל האירועים והחופשות. מוגן בטוקן סודי בכתובת עצמה
// (לא דורש התחברות/הרשאה של גוגל) - כל מי שמקבל את הכתובת יכול "להירשם"
// אליה פעם אחת ביומן שלו, וגוגל תשאב עדכונים אוטומטית מעת לעת.
function getOrCreateFeedToken() {
  let row = db.prepare("SELECT value FROM settings WHERE key = 'calendar_feed_token'").get();
  if (row) return row.value;
  const token = require("crypto").randomBytes(20).toString("hex");
  db.prepare("INSERT INTO settings (key, value) VALUES ('calendar_feed_token', ?)").run(token);
  return token;
}

function icsEscape(text) {
  return String(text || "").replace(/[\\,;]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
}
function serialToIcsDate(serial) {
  // ICS לאירועי "יום שלם" דורש פורמט YYYYMMDD (בלי מקפים)
  return (hd.serialToInputDate(serial) || "").replace(/-/g, "");
}
function addDaysToIcsDate(icsDate, days) {
  const y = parseInt(icsDate.slice(0, 4), 10), m = parseInt(icsDate.slice(4, 6), 10), d = parseInt(icsDate.slice(6, 8), 10);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

router.get("/feed/:token.ics", (req, res) => {
  const expectedToken = getOrCreateFeedToken();
  if (req.params.token !== expectedToken) return res.status(404).send("Not found");

  const events = db.prepare("SELECT * FROM events ORDER BY event_date").all();
  const vacations = db.prepare("SELECT * FROM vacations ORDER BY start_date").all();

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//תלמוד תורה החדש//לוח שנה//HE",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:תלמוד תורה החדש - אירועים, חופשות, משימות וימי הולדת",
    "X-WR-TIMEZONE:Asia/Jerusalem",
  ];

  events.forEach((e) => {
    const startIcs = serialToIcsDate(e.event_date);
    if (!startIcs) return;
    const endSerial = e.event_date_end || e.event_date;
    const endIcs = addDaysToIcsDate(serialToIcsDate(endSerial), 1); // DTEND ב-ICS לא כולל, אז מוסיפים יום
    lines.push(
      "BEGIN:VEVENT",
      `UID:event-${e.id}@talmud-tora-web`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
      `DTSTART;VALUE=DATE:${startIcs}`,
      `DTEND;VALUE=DATE:${endIcs}`,
      `SUMMARY:${icsEscape(e.title)}`,
      e.description ? `DESCRIPTION:${icsEscape(e.description)}` : null,
      "END:VEVENT"
    );
  });

  vacations.forEach((v) => {
    const startIcs = serialToIcsDate(v.start_date);
    if (!startIcs) return;
    const endIcs = addDaysToIcsDate(serialToIcsDate(v.end_date), 1);
    lines.push(
      "BEGIN:VEVENT",
      `UID:vacation-${v.id}@talmud-tora-web`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
      `DTSTART;VALUE=DATE:${startIcs}`,
      `DTEND;VALUE=DATE:${endIcs}`,
      `SUMMARY:🏖️ ${icsEscape(v.title)}`,
      "END:VEVENT"
    );
  });

  // משימות כלליות (משותפות לכולם) עם תאריך יעד - לא משימות אישיות, כי הפיד
  // הזה משותף לכולם ולא "יודע" מי בדיוק נכנס אליו
  const sharedTasks = db.prepare("SELECT * FROM shared_tasks WHERE due_date IS NOT NULL").all();
  sharedTasks.forEach((t) => {
    const startIcs = serialToIcsDate(t.due_date);
    if (!startIcs) return;
    const endIcs = addDaysToIcsDate(startIcs, 1);
    lines.push(
      "BEGIN:VEVENT",
      `UID:shared-task-${t.id}@talmud-tora-web`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
      `DTSTART;VALUE=DATE:${startIcs}`,
      `DTEND;VALUE=DATE:${endIcs}`,
      `SUMMARY:👥 ${icsEscape(t.title)}`,
      "END:VEVENT"
    );
  });

  // ימי הולדת (תלמידים + צוות) - לפי התאריך העברי, מחושבים לשנה העברית
  // הנוכחית והבאה (כדי שתמיד יהיה יום הולדת קרוב זמין, גם אחרי שהקודם עבר)
  const { hebrewBirthdayAbsoluteForYear } = require("../birthdays");
  const currentHebYear = hd.todayHebrewParts().year;
  const students = db.prepare("SELECT id, first_name, last_name, birth_date_civil FROM students WHERE status='פעיל' AND birth_date_civil IS NOT NULL").all();
  const teachers = db.prepare("SELECT id, first_name, last_name, birth_date_civil FROM teachers WHERE status='פעיל' AND birth_date_civil IS NOT NULL").all();
  const addBirthdayEvents = (people, kind) => {
    people.forEach((p) => {
      [currentHebYear, currentHebYear + 1].forEach((y) => {
        const abs = hebrewBirthdayAbsoluteForYear(p.birth_date_civil, y);
        if (abs == null) return;
        const serial = hd.absoluteToAccessSerial(abs);
        const startIcs = serialToIcsDate(serial);
        if (!startIcs) return;
        const endIcs = addDaysToIcsDate(startIcs, 1);
        const name = `${p.last_name || ""} ${p.first_name || ""}`.trim();
        lines.push(
          "BEGIN:VEVENT",
          `UID:birthday-${kind}-${p.id}-${y}@talmud-tora-web`,
          `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
          `DTSTART;VALUE=DATE:${startIcs}`,
          `DTEND;VALUE=DATE:${endIcs}`,
          `SUMMARY:🎂 ${icsEscape(name)}`,
          "END:VEVENT"
        );
      });
    });
  };
  addBirthdayEvents(students, "student");
  addBirthdayEvents(teachers, "teacher");

  lines.push("END:VCALENDAR");
  const icsContent = lines.filter(Boolean).join("\r\n");

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="talmud-tora-calendar.ics"');
  res.send(icsContent);
});

router.get("/feed-info", (req, res) => {
  const token = getOrCreateFeedToken();
  const feedUrl = `${req.protocol}://${req.get("host")}/events/feed/${token}.ics`;
  res.render("events/feed-info", { feedUrl });
});

router.get("/vacations", (req, res) => {
  const vacations = db.prepare("SELECT * FROM vacations ORDER BY start_date DESC").all().map((v) => ({
    ...v,
    start_str: hd.serialToHebrewString(v.start_date),
    end_str: hd.serialToHebrewString(v.end_date),
    start_parts: hd.serialToHebrewParts(v.start_date),
    end_parts: hd.serialToHebrewParts(v.end_date),
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

router.put("/vacations/:id", (req, res) => {
  const { title, start_day, start_month, start_year, end_day, end_month, end_year } = req.body;
  if (!title || !start_day || !start_month || !start_year || !end_day || !end_month || !end_year) {
    return res.redirect("/events/vacations");
  }
  const startAbs = hd.hebrewPartsToAbsolute(parseInt(start_year, 10), parseInt(start_month, 10), parseInt(start_day, 10));
  const endAbs = hd.hebrewPartsToAbsolute(parseInt(end_year, 10), parseInt(end_month, 10), parseInt(end_day, 10));
  const startSerial = hd.absoluteToAccessSerial(startAbs);
  const endSerial = hd.absoluteToAccessSerial(endAbs);
  db.prepare("UPDATE vacations SET title = ?, start_date = ?, end_date = ? WHERE id = ?").run(
    title, Math.min(startSerial, endSerial), Math.max(startSerial, endSerial), req.params.id
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

  // משימות אישיות (של המשתמש המחובר בלבד) עם תאריך יעד בטווח המוצג
  const myTasksRaw = db.prepare(`
    SELECT id, title, done, due_date FROM tasks WHERE user_id = ? AND due_date >= ? AND due_date <= ?
  `).all(req.currentUser.id, startSerial, endSerial);
  const tasksBySerial = {};
  myTasksRaw.forEach((t) => {
    if (!tasksBySerial[t.due_date]) tasksBySerial[t.due_date] = [];
    tasksBySerial[t.due_date].push({ ...t, isShared: false });
  });

  // משימות כלליות (משותפות לכולם) עם תאריך יעד בטווח המוצג
  const sharedTasksRaw = db.prepare(`
    SELECT id, title, done, due_date, assigned_label FROM shared_tasks WHERE due_date >= ? AND due_date <= ?
  `).all(startSerial, endSerial);
  sharedTasksRaw.forEach((t) => {
    if (!tasksBySerial[t.due_date]) tasksBySerial[t.due_date] = [];
    tasksBySerial[t.due_date].push({ ...t, isShared: true });
  });

  // ימי הולדת (תלמידים + צוות) - לפי תאריך הלידה העברי, שחוזר כל שנה. בודקים
  // את השנה העברית של הטווח וגם שנה לפני/אחרי, כדי לכסות מעברי שנה בקצוות הלוח
  const { hebrewBirthdayAbsoluteForYear } = require("../birthdays");
  const students = db.prepare("SELECT id, first_name, last_name, birth_date_civil FROM students WHERE status='פעיל' AND birth_date_civil IS NOT NULL").all();
  const teachers = db.prepare("SELECT id, first_name, last_name, birth_date_civil FROM teachers WHERE status='פעיל' AND birth_date_civil IS NOT NULL").all();
  const birthdaysByAbsolute = {};
  const addBirthday = (person, kind, hrefBase) => {
    [year - 1, year, year + 1].forEach((y) => {
      const abs = hebrewBirthdayAbsoluteForYear(person.birth_date_civil, y);
      if (abs == null || abs < gridStartAbsolute || abs > gridEndAbsolute) return;
      if (!birthdaysByAbsolute[abs]) birthdaysByAbsolute[abs] = [];
      birthdaysByAbsolute[abs].push({ name: `${person.last_name || ""} ${person.first_name || ""}`.trim(), kind, href: `${hrefBase}/${person.id}` });
    });
  };
  students.forEach((s) => addBirthday(s, "student", "/students"));
  teachers.forEach((t) => addBirthday(t, "teacher", "/teachers"));

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
      tasks: tasksBySerial[serial] || [],
      birthdays: birthdaysByAbsolute[absolute] || [],
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
