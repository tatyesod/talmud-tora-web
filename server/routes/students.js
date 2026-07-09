const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const { buildOrderBy } = require("../sortHelper");
const { checkNoConflict } = require("../concurrency");

function calcAge(accessSerial) {
  if (!accessSerial) return null;
  const epoch = new Date(1899, 11, 30);
  const date = new Date(epoch.getTime() + accessSerial * 86400000);
  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const m = today.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < date.getDate())) age--;
  return age;
}

function withDates(student) {
  if (!student) return student;
  return {
    ...student,
    birth_date_civil_str: hd.serialToGregorianString(student.birth_date_civil),
    birth_date_hebrew_str: hd.serialToHebrewString(student.birth_date_civil),
    entry_date_str: hd.serialToGregorianString(student.entry_date),
    exit_date_str: hd.serialToGregorianString(student.exit_date),
    registration_date_str: hd.serialToGregorianString(student.registration_date),
    admission_date_str: hd.serialToGregorianString(student.admission_date),
    update_date_str: hd.serialToGregorianString(student.update_date),
    age: calcAge(student.birth_date_civil),
  };
}

const STUDENT_SELECT = `
  SELECT s.*, c.name AS class_name, c.parallel AS class_parallel, c.branch AS branch, co.name AS cohort_name,
         f.last_name AS family_last_name, f.father_name, f.mother_name, f.sector,
         f.home_phone, f.father_mobile, f.mother_mobile,
         f.street, f.house_number, f.apartment, f.city
  FROM students s
  LEFT JOIN classes c ON s.class_id = c.id
  LEFT JOIN cohorts co ON s.cohort_id = co.id
  LEFT JOIN families f ON s.family_id = f.id
`;

function getEmergencyContacts(familyId) {
  if (!familyId) return [];
  return db.prepare("SELECT * FROM emergency_contacts WHERE family_id = ?").all(familyId);
}

function getStudentFile(studentId) {
  return db
    .prepare("SELECT * FROM student_file WHERE student_id = ? ORDER BY entry_date DESC")
    .all(studentId)
    .map((r) => ({ ...r, entry_date_str: hd.serialToGregorianString(r.entry_date) }));
}

function getClassTeachers(classId) {
  if (!classId) return [];
  return db
    .prepare(`
      SELECT t.*, tc.role FROM teacher_classes tc
      JOIN teachers t ON tc.teacher_id = t.id
      WHERE tc.class_id = ?
      ORDER BY CASE tc.role WHEN 'בוקר' THEN 1 WHEN 'אחה"צ' THEN 2 WHEN 'עוזר' THEN 3 ELSE 4 END
    `)
    .all(classId);
}

// --- רשימה וחיפוש ---
router.get("/", (req, res) => res.redirect("/students"));

router.get("/students", (req, res) => {
  const { q, class_id, cohort_id, sector, branch } = req.query;
  const status = req.query.status !== undefined ? req.query.status : "פעיל";
  let sql = STUDENT_SELECT + " WHERE 1=1";
  const params = [];

  if (q) {
    sql += ` AND (
      s.last_name LIKE ? OR s.first_name LIKE ? OR s.nickname LIKE ? OR
      s.id_number LIKE ? OR f.father_name LIKE ? OR f.home_phone LIKE ? OR
      f.father_mobile LIKE ? OR f.mother_mobile LIKE ?
    )`;
    const like = `%${q}%`;
    for (let i = 0; i < 8; i++) params.push(like);
  }
  if (class_id) {
    sql += " AND s.class_id = ?";
    params.push(class_id);
  }
  if (status) {
    sql += " AND s.status = ?";
    params.push(status);
  }
  if (cohort_id) {
    sql += " AND s.cohort_id = ?";
    params.push(cohort_id);
  }
  if (sector) {
    sql += " AND f.sector = ?";
    params.push(sector);
  }
  if (branch) {
    if (branch === "__none__") {
      sql += " AND c.branch IS NULL";
    } else {
      sql += " AND c.branch = ?";
      params.push(branch);
    }
  }
  sql += " " + buildOrderBy(
    req,
    {
      last_name: "s.last_name, s.first_name",
      first_name: "s.first_name, s.last_name",
      nickname: "s.nickname",
      class_name: "c.name, c.parallel",
      id_number: "s.id_number",
      home_phone: "f.home_phone",
      status: "s.status",
    },
    "ORDER BY s.last_name, s.first_name"
  );

  const students = db.prepare(sql).all(...params).map(withDates);
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
  const statuses = db.prepare("SELECT DISTINCT status FROM students WHERE status IS NOT NULL ORDER BY status").all();

  res.render("students/list", {
    students, classes, cohorts, statuses,
    q: q || "", class_id: class_id || "", status: status || "", cohort_id: cohort_id || "",
    sector: sector || "", branch: branch || "",
    sort: req.query.sort || "", dir: req.query.dir || "",
  });
});

// --- הוספה ---
router.get("/students/new", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
  const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
  const chassidut = db.prepare("SELECT id, name FROM chassidut ORDER BY name").all();
  const yeshivot = db.prepare("SELECT id, name FROM yeshivot ORDER BY name").all();
  res.render("students/form", { student: {}, mode: "new", classes, cohorts, families, chassidut, yeshivot });
});

const STUDENT_FIELDS = [
  "last_name", "first_name", "nickname", "class_id", "id_number", "notes",
  "allergies", "medications", "walks_alone", "health_fund", "birth_country", "immigration_year", "family_id", "status",
  "cohort_id", "birth_date_civil", "entry_date", "update_date", "exit_date",
  "registration_date", "admission_date",
];
const DATE_FIELDS = ["birth_date_civil", "entry_date", "update_date", "exit_date", "registration_date", "admission_date"];

function normalizeField(col, value) {
  if (value === undefined || value === "") return null;
  if (DATE_FIELDS.includes(col)) return hd.gregorianStringToSerial(value);
  return value;
}

router.post("/students", (req, res) => {
  const body = req.body;

  // יצירת משפחה חדשה אם המשתמש בחר "משפחה חדשה"
  if (body.family_mode === "new") {
    const famFields = [
      "last_name","sector","father_name","father_id_number","father_email",
      "mother_name","mother_id_number","mother_email",
      "home_phone","father_mobile","mother_mobile",
      "father_workplace","father_work_phone","mother_workplace","mother_work_phone",
      "street","house_number","apartment","city","zip_code","notes"
    ];
    const famCols = famFields.filter(f => body["fam_"+f] !== undefined && body["fam_"+f] !== "");
    const famVals = famCols.map(f => body["fam_"+f]);
    if (famCols.length > 0) {
      const famInfo = db.prepare(
        `INSERT INTO families (${famCols.join(",")}) VALUES (${famCols.map(()=>"?").join(",")})`
      ).run(...famVals);
      body.family_id = famInfo.lastInsertRowid;
    }
  }

  const cols = STUDENT_FIELDS.filter((c) => c in body);
  const placeholders = cols.map(() => "?").join(",");
  const values = cols.map((c) => normalizeField(c, body[c]));
  const info = db.prepare(`INSERT INTO students (${cols.join(",")}) VALUES (${placeholders})`).run(...values);
  if (body.family_id && body.sector) {
    db.prepare("UPDATE families SET sector = ? WHERE id = ?").run(body.sector, body.family_id);
  }
  res.redirect(`/students/${info.lastInsertRowid}`);
});

// --- צפייה בכרטיס ---
router.get("/students/:id", (req, res) => {
  const student = withDates(db.prepare(STUDENT_SELECT + " WHERE s.id = ?").get(req.params.id));
  if (!student) return res.status(404).render("404");
  const contacts = getEmergencyContacts(student.family_id);
  const siblings = student.family_id
    ? db.prepare(`
        SELECT s.id, s.first_name, s.last_name, s.status,
               c.name AS class_name, c.parallel
        FROM students s
        LEFT JOIN classes c ON s.class_id = c.id
        WHERE s.family_id = ? AND s.id != ?
        ORDER BY (s.birth_date_civil IS NULL), s.birth_date_civil ASC
      `).all(student.family_id, student.id)
    : [];
  const studentFile = getStudentFile(student.id);
  const teachers = getClassTeachers(student.class_id);
  res.render("students/view", { student, contacts, siblings, studentFile, teachers });
});

// --- עריכה ---
router.get("/students/:id/edit", (req, res) => {
  const student = db.prepare(`
    SELECT s.*, f.sector AS family_sector FROM students s
    LEFT JOIN families f ON s.family_id = f.id WHERE s.id = ?
  `).get(req.params.id);
  if (!student) return res.status(404).render("404");
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
  const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
  res.render("students/form", {
    student: {
      ...student,
      sector: student.family_sector,
      birth_date_civil: hd.serialToInputDate(student.birth_date_civil),
      entry_date: hd.serialToInputDate(student.entry_date),
      exit_date: hd.serialToInputDate(student.exit_date),
      registration_date: hd.serialToInputDate(student.registration_date),
      admission_date: hd.serialToInputDate(student.admission_date),
    },
    mode: "edit", classes, cohorts, families, conflict: req.query.conflict === "1",
  });
});

router.put("/students/:id", (req, res) => {
  const body = req.body;
  if (!checkNoConflict("students", req.params.id, body.updated_at)) {
    return res.redirect(`/students/${req.params.id}/edit?conflict=1`);
  }
  const cols = STUDENT_FIELDS.filter((c) => c in body);
  const setClause = [...cols.map((c) => `${c} = ?`), "updated_at = ?"].join(", ");
  const values = [...cols.map((c) => normalizeField(c, body[c])), new Date().toISOString()];
  values.push(req.params.id);
  db.prepare(`UPDATE students SET ${setClause} WHERE id = ?`).run(...values);
  if (body.family_id && body.sector) {
    db.prepare("UPDATE families SET sector = ? WHERE id = ?").run(body.sector, body.family_id);
  }
  res.redirect(`/students/${req.params.id}`);
});

// --- מחיקה ---
router.delete("/students/:id", (req, res) => {
  db.prepare("DELETE FROM students WHERE id = ?").run(req.params.id);
  res.redirect("/students");
});

// --- מחיקה מרובה (סימון ווי ברשימה) ---
router.post("/students/bulk-delete", (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM students WHERE id IN (${placeholders})`).run(...ids);
  }
  res.redirect("/students");
});

// --- הוספת רשומה לתיק תלמיד ---
router.post("/students/:id/file", (req, res) => {
  const { notes, class_name_at_time, entry_date } = req.body;
  db.prepare(
    "INSERT INTO student_file (student_id, class_name_at_time, entry_date, notes) VALUES (?,?,?,?)"
  ).run(req.params.id, class_name_at_time || null, hd.gregorianStringToSerial(entry_date) || hd.todayAccessSerial(), notes);
  res.redirect(`/students/${req.params.id}`);
});

// --- הדפסת טופס בריאות ---
router.get("/students/:id/print/health", (req, res) => {
  const student = withDates(db.prepare(STUDENT_SELECT + " WHERE s.id = ?").get(req.params.id));
  if (!student) return res.status(404).render("404");
  res.render("students/print-health", { student });
});

// --- הדפסת אנשי קשר לשעת חירום ---
router.get("/students/:id/print/emergency", (req, res) => {
  const student = withDates(db.prepare(STUDENT_SELECT + " WHERE s.id = ?").get(req.params.id));
  if (!student) return res.status(404).render("404");
  const contacts = getEmergencyContacts(student.family_id);
  res.render("students/print-emergency", { student, contacts });
});

module.exports = router;
