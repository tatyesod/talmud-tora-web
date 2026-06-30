const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");

function withDates(e) {
  return {
    ...e,
    event_date_str: hd.serialToGregorianString(e.event_date),
    event_date_hebrew_str: hd.serialToHebrewString(e.event_date),
    event_date_end_str: hd.serialToGregorianString(e.event_date_end),
  };
}

router.get("/", (req, res) => {
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
  res.render("events/form", { event: {}, mode: "new", classes });
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
