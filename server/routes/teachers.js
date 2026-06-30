const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const { buildOrderBy } = require("../sortHelper");

function withDates(t) {
  if (!t) return t;
  return {
    ...t,
    birth_date_civil_str: hd.serialToGregorianString(t.birth_date_civil),
    entry_date_str: hd.serialToGregorianString(t.entry_date),
    exit_date_str: hd.serialToGregorianString(t.exit_date),
  };
}

router.get("/", (req, res) => {
  const { q, status } = req.query;
  let sql = `
    SELECT t.*, ch.name AS chassidut_name FROM teachers t
    LEFT JOIN chassidut ch ON t.chassidut_id = ch.id WHERE 1=1
  `;
  const params = [];
  if (q) {
    sql += " AND (t.last_name LIKE ? OR t.first_name LIKE ? OR t.mobile LIKE ? OR t.id_number LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status) {
    sql += " AND t.status = ?";
    params.push(status);
  }
  sql += " " + buildOrderBy(
    req,
    {
      last_name: "t.last_name, t.first_name",
      first_name: "t.first_name, t.last_name",
      id_number: "t.id_number",
      mobile: "t.mobile",
      chassidut: "ch.name",
      children_count: "t.children_count",
      status: "t.status",
    },
    "ORDER BY t.last_name, t.first_name"
  );

  const teachers = db.prepare(sql).all(...params).map(withDates);
  const statuses = db.prepare("SELECT DISTINCT status FROM teachers WHERE status IS NOT NULL ORDER BY status").all();
  const totalChildren = teachers.reduce((sum, t) => sum + (t.children_count || 0), 0);
  res.render("teachers/list", { teachers, statuses, q: q || "", status: status || "", sort: req.query.sort || "", dir: req.query.dir || "", totalChildren });
});

router.get("/new", (req, res) => {
  const chassidut = db.prepare("SELECT id, name FROM chassidut ORDER BY name").all();
  res.render("teachers/form", { teacher: {}, mode: "new", chassidut });
});

const TEACHER_FIELDS = [
  "last_name", "first_name", "id_number", "birth_date_civil", "street", "house_number",
  "apartment", "city", "zip_code", "home_phone", "mobile", "chassidut_id", "notes",
  "status", "entry_date", "update_date", "exit_date", "children_count",
];
const DATE_FIELDS = ["birth_date_civil", "entry_date", "update_date", "exit_date"];

function normalizeField(col, value) {
  if (value === undefined || value === "") return null;
  if (DATE_FIELDS.includes(col)) return hd.gregorianStringToSerial(value);
  return value;
}

router.post("/", (req, res) => {
  const body = req.body;
  const cols = TEACHER_FIELDS.filter((c) => c in body);
  const values = cols.map((c) => normalizeField(c, body[c]));
  const info = db
    .prepare(`INSERT INTO teachers (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...values);
  res.redirect(`/teachers/${info.lastInsertRowid}`);
});

router.get("/:id", (req, res) => {
  const teacher = withDates(
    db.prepare(`
      SELECT t.*, ch.name AS chassidut_name FROM teachers t
      LEFT JOIN chassidut ch ON t.chassidut_id = ch.id WHERE t.id = ?
    `).get(req.params.id)
  );
  if (!teacher) return res.status(404).render("404");
  const classes = db
    .prepare(`
      SELECT c.*, tc.role FROM teacher_classes tc JOIN classes c ON tc.class_id = c.id
      WHERE tc.teacher_id = ?
    `)
    .all(req.params.id);

  const attendance = db
    .prepare("SELECT * FROM teacher_attendance WHERE teacher_id = ? ORDER BY att_date DESC LIMIT 30")
    .all(req.params.id)
    .map((a) => ({ ...a, att_date_str: hd.serialToGregorianString(a.att_date) }));

  const attendanceSummary = db
    .prepare("SELECT status, COUNT(*) c FROM teacher_attendance WHERE teacher_id = ? GROUP BY status")
    .all(req.params.id);

  const file = db
    .prepare("SELECT * FROM teacher_file WHERE teacher_id = ? ORDER BY entry_date DESC")
    .all(req.params.id)
    .map((f) => ({ ...f, entry_date_str: hd.serialToGregorianString(f.entry_date) }));

  res.render("teachers/view", { teacher, classes, attendance, attendanceSummary, file });
});

router.post("/:id/attendance", (req, res) => {
  const { att_date, status, notes } = req.body;
  db.prepare("INSERT INTO teacher_attendance (teacher_id, att_date, status, notes) VALUES (?,?,?,?)").run(
    req.params.id, att_date ? hd.gregorianStringToSerial(att_date) : hd.todayAccessSerial(), status, notes || null
  );
  res.redirect(`/teachers/${req.params.id}`);
});

router.delete("/:id/attendance/:attId", (req, res) => {
  db.prepare("DELETE FROM teacher_attendance WHERE id = ? AND teacher_id = ?").run(req.params.attId, req.params.id);
  res.redirect(`/teachers/${req.params.id}`);
});

router.post("/:id/file", (req, res) => {
  const { entry_date, category, notes } = req.body;
  db.prepare("INSERT INTO teacher_file (teacher_id, entry_date, category, notes) VALUES (?,?,?,?)").run(
    req.params.id, entry_date ? hd.gregorianStringToSerial(entry_date) : hd.todayAccessSerial(), category || null, notes
  );
  res.redirect(`/teachers/${req.params.id}`);
});

router.get("/:id/edit", (req, res) => {
  const teacher = db.prepare("SELECT * FROM teachers WHERE id = ?").get(req.params.id);
  if (!teacher) return res.status(404).render("404");
  const chassidut = db.prepare("SELECT id, name FROM chassidut ORDER BY name").all();
  const allClasses = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY name, parallel").all();
  const assignments = db
    .prepare(`
      SELECT tc.id AS assignment_id, tc.role, c.id AS class_id, c.name, c.parallel
      FROM teacher_classes tc JOIN classes c ON tc.class_id = c.id
      WHERE tc.teacher_id = ?
      ORDER BY c.name, c.parallel
    `)
    .all(req.params.id);
  res.render("teachers/form", {
    teacher: {
      ...teacher,
      birth_date_civil: hd.serialToInputDate(teacher.birth_date_civil),
      entry_date: hd.serialToInputDate(teacher.entry_date),
      exit_date: hd.serialToInputDate(teacher.exit_date),
    },
    mode: "edit", chassidut, allClasses, assignments,
  });
});

router.post("/:id/classes", (req, res) => {
  const { class_id, role } = req.body;
  if (class_id) {
    db.prepare("INSERT INTO teacher_classes (class_id, teacher_id, role) VALUES (?,?,?)").run(
      class_id, req.params.id, role || null
    );
  }
  res.redirect(`/teachers/${req.params.id}/edit`);
});

router.delete("/:id/classes/:assignmentId", (req, res) => {
  db.prepare("DELETE FROM teacher_classes WHERE id = ? AND teacher_id = ?").run(
    req.params.assignmentId, req.params.id
  );
  res.redirect(`/teachers/${req.params.id}/edit`);
});

router.put("/:id", (req, res) => {
  const body = req.body;
  const cols = TEACHER_FIELDS.filter((c) => c in body);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => normalizeField(c, body[c]));
  values.push(req.params.id);
  db.prepare(`UPDATE teachers SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect(`/teachers/${req.params.id}`);
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM teachers WHERE id = ?").run(req.params.id);
  res.redirect("/teachers");
});

module.exports = router;
