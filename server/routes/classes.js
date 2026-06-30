const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const { buildOrderBy } = require("../sortHelper");

router.get("/", (req, res) => {
  const { branch } = req.query;
  let classIds = req.query.class_id || [];
  if (!Array.isArray(classIds)) classIds = [classIds];

  const allClassesForFilter = db
    .prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel")
    .all();

  let sql = `
      SELECT c.*, cat.name AS category_name, cat.price,
        (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.status = 'פעיל') AS active_count
      FROM classes c
      LEFT JOIN categories cat ON c.category_id = cat.id
      WHERE 1=1
  `;
  const params = [];
  if (branch) {
    sql += " AND c.branch = ?";
    params.push(branch);
  }
  if (classIds.length > 0) {
    sql += ` AND c.id IN (${classIds.map(() => "?").join(",")})`;
    params.push(...classIds);
  }
  sql += " " + buildOrderBy(
    req,
    {
      name: "c.name, c.parallel",
      parallel: "c.parallel",
      branch: "c.branch",
      category: "cat.name",
      active_count: "active_count",
      status: "c.status",
    },
    "ORDER BY c.name, c.parallel"
  );
  const classes = db.prepare(sql).all(...params);
  const filteredTotal = classes.reduce((sum, c) => sum + c.active_count, 0);

  const cohorts = db
    .prepare(`
      SELECT co.*, (SELECT COUNT(*) FROM students s WHERE s.cohort_id = co.id) AS count
      FROM cohorts co ORDER BY co.name DESC
    `)
    .all()
    .map((c) => ({
      ...c,
      from_date_str: hd.serialToGregorianString(c.from_date),
      to_date_str: hd.serialToGregorianString(c.to_date),
    }));

  res.render("classes/list", {
    classes, cohorts, branch: branch || "", sort: req.query.sort || "", dir: req.query.dir || "",
    allClassesForFilter, selectedClassIds: classIds.map(String), filteredTotal,
  });
});

// ============ כיתות - הוספה/עריכה/מחיקה ============
router.get("/new", (req, res) => {
  const categories = db.prepare("SELECT id, name FROM categories ORDER BY id").all();
  res.render("classes/form", { classRow: {}, mode: "new", categories });
});

const CLASS_FIELDS = ["name", "parallel", "class_number", "transfer_number", "status", "category_id", "branch"];

router.post("/", (req, res) => {
  const body = req.body;
  const cols = CLASS_FIELDS.filter((c) => c in body);
  const values = cols.map((c) => (body[c] === "" ? null : body[c]));
  const info = db
    .prepare(`INSERT INTO classes (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...values);
  res.redirect(`/classes/${info.lastInsertRowid}`);
});

router.get("/:id/edit", (req, res) => {
  const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(req.params.id);
  if (!classRow) return res.status(404).render("404");
  const categories = db.prepare("SELECT id, name FROM categories ORDER BY id").all();
  res.render("classes/form", { classRow, mode: "edit", categories });
});

router.put("/:id", (req, res) => {
  const body = req.body;
  const cols = CLASS_FIELDS.filter((c) => c in body);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => (body[c] === "" ? null : body[c]));
  values.push(req.params.id);
  db.prepare(`UPDATE classes SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect(`/classes/${req.params.id}`);
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM classes WHERE id = ?").run(req.params.id);
  res.redirect("/classes");
});

// ============ מחזורים - הוספה/עריכה/מחיקה ============
router.get("/cohorts/new", (req, res) => {
  res.render("classes/cohort-form", { cohort: {}, mode: "new" });
});

const COHORT_FIELDS = ["name", "status", "from_date", "to_date"];
const COHORT_DATE_FIELDS = ["from_date", "to_date"];

function normalizeCohortField(col, value) {
  if (value === undefined || value === "") return null;
  if (COHORT_DATE_FIELDS.includes(col)) return hd.gregorianStringToSerial(value);
  return value;
}

router.post("/cohorts", (req, res) => {
  const body = req.body;
  const cols = COHORT_FIELDS.filter((c) => c in body);
  const values = cols.map((c) => normalizeCohortField(c, body[c]));
  db.prepare(`INSERT INTO cohorts (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...values);
  res.redirect("/classes");
});

router.get("/cohorts/:id/edit", (req, res) => {
  const cohort = db.prepare("SELECT * FROM cohorts WHERE id = ?").get(req.params.id);
  if (!cohort) return res.status(404).render("404");
  res.render("classes/cohort-form", {
    cohort: {
      ...cohort,
      from_date: hd.serialToInputDate(cohort.from_date),
      to_date: hd.serialToInputDate(cohort.to_date),
    },
    mode: "edit",
  });
});

router.put("/cohorts/:id", (req, res) => {
  const body = req.body;
  const cols = COHORT_FIELDS.filter((c) => c in body);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => normalizeCohortField(c, body[c]));
  values.push(req.params.id);
  db.prepare(`UPDATE cohorts SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect("/classes");
});

router.delete("/cohorts/:id", (req, res) => {
  db.prepare("DELETE FROM cohorts WHERE id = ?").run(req.params.id);
  res.redirect("/classes");
});

// --- צפייה בכיתה (תמיד אחרון, כדי לא להתנגש עם /new ו-/cohorts) ---
router.get("/:id", (req, res) => {
  const classRow = db
    .prepare(`
      SELECT c.*, cat.name AS category_name, cat.price FROM classes c
      LEFT JOIN categories cat ON c.category_id = cat.id WHERE c.id = ?
    `)
    .get(req.params.id);
  if (!classRow) return res.status(404).render("404");

  const students = db
    .prepare("SELECT * FROM students WHERE class_id = ? ORDER BY last_name, first_name")
    .all(req.params.id);

  const teachers = db
    .prepare(`
      SELECT t.*, tc.role FROM teacher_classes tc JOIN teachers t ON tc.teacher_id = t.id
      WHERE tc.class_id = ?
      ORDER BY CASE tc.role WHEN 'בוקר' THEN 1 WHEN 'אחה"צ' THEN 2 WHEN 'עוזר' THEN 3 ELSE 4 END
    `)
    .all(req.params.id);

  const sectorBreakdown = db
    .prepare(`
      SELECT COALESCE(f.sector, 'לא צוין') AS sector, COUNT(*) AS count
      FROM students s
      LEFT JOIN families f ON s.family_id = f.id
      WHERE s.class_id = ? AND s.status = 'פעיל'
      GROUP BY f.sector
      ORDER BY count DESC
    `)
    .all(req.params.id);

  res.render("classes/view", { classRow, students, teachers, sectorBreakdown });
});

module.exports = router;
