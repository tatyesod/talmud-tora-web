const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const { buildOrderBy } = require("../sortHelper");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// הגדרת multer להעלאת קבצי תיק עובד
const DATA_DIR = process.env.RENDER_PERSISTENT_DIR || path.join(__dirname, "..");
const uploadDir = path.join(DATA_DIR, "uploads", "teachers");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = Buffer.from(file.originalname, "latin1").toString("utf8");
    cb(null, `${req.params.id}_${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB מקסימום
  fileFilter: (req, file, cb) => {
    const allowed = [".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".xls", ".xlsx"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

function calcAge(accessSerial) {
  if (!accessSerial) return null;
  // המרה מ-Access serial ל-JavaScript Date
  const epoch = new Date(1899, 11, 30);
  const date = new Date(epoch.getTime() + accessSerial * 86400000);
  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const m = today.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < date.getDate())) age--;
  return age;
}

function withDates(t) {
  if (!t) return t;
  return {
    ...t,
    birth_date_civil_str: hd.serialToGregorianString(t.birth_date_civil),
    entry_date_str: hd.serialToGregorianString(t.entry_date),
    exit_date_str: hd.serialToGregorianString(t.exit_date),
    spouse_birth_date_str: hd.serialToGregorianString(t.spouse_birth_date),
    age: calcAge(t.birth_date_civil),
    spouse_age: calcAge(t.spouse_birth_date),
  };
}

router.get("/", (req, res) => {
  const { q } = req.query;
  const status = req.query.status !== undefined ? req.query.status : "פעיל";
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

router.post("/:id/file", upload.single("attachment"), (req, res) => {
  const { entry_date, category, notes } = req.body;
  const file_path = req.file ? `/uploads/teachers/${req.file.filename}` : null;
  const file_name = req.file ? Buffer.from(req.file.originalname, "latin1").toString("utf8") : null;
  db.prepare("INSERT INTO teacher_file (teacher_id, entry_date, category, notes, file_path, file_name) VALUES (?,?,?,?,?,?)").run(
    req.params.id,
    entry_date ? hd.gregorianStringToSerial(entry_date) : hd.todayAccessSerial(),
    category || null,
    notes || null,
    file_path,
    file_name
  );
  res.redirect(`/teachers/${req.params.id}`);
});

router.delete("/:id/file/:fileId", (req, res) => {
  const row = db.prepare("SELECT file_path FROM teacher_file WHERE id=? AND teacher_id=?").get(req.params.fileId, req.params.id);
  if (row?.file_path) {
    const full = path.join(__dirname, "..", row.file_path.replace(/^\//, ""));
    try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch(e) {}
  }
  db.prepare("DELETE FROM teacher_file WHERE id = ? AND teacher_id = ?").run(req.params.fileId, req.params.id);
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
