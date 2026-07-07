const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const { buildOrderBy } = require("../sortHelper");
const { checkNoConflict } = require("../concurrency");

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

  const cohortsRaw = db
    .prepare(`
      SELECT co.*, (SELECT COUNT(*) FROM students s WHERE s.cohort_id = co.id) AS count
      FROM cohorts co ORDER BY co.to_date DESC, co.from_date DESC
    `)
    .all();

  // מספור אוטומטי עולה לפי סדר כרונולוגי (המחזור הכי ישן = מספר 1)
  const chronological = [...cohortsRaw].sort((a, b) => (a.from_date || 0) - (b.from_date || 0));
  const numberByCohortId = {};
  chronological.forEach((c, i) => { numberByCohortId[c.id] = i + 1; });

  const cohorts = cohortsRaw.map((c) => ({
    ...c,
    from_date_str: hd.serialToHebrewString(c.from_date),
    to_date_str: hd.serialToHebrewString(c.to_date),
    cohort_number: hd.hebrewNumeral(numberByCohortId[c.id]),
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

  const teacherAssignments = db
    .prepare(`
      SELECT tc.id AS assignment_id, tc.role, t.id AS teacher_id, t.first_name, t.last_name
      FROM teacher_classes tc JOIN teachers t ON tc.teacher_id = t.id
      WHERE tc.class_id = ?
      ORDER BY CASE tc.role WHEN 'בוקר' THEN 1 WHEN 'אחה"צ' THEN 2 WHEN 'עוזר' THEN 3 ELSE 4 END
    `)
    .all(req.params.id);
  const allTeachers = db.prepare("SELECT id, first_name, last_name FROM teachers ORDER BY last_name, first_name").all();

  // ניווט חצים בין כיתות - לפי אותו סדר כמו ברשימת הכיתות (שם, מקבילה)
  const orderedIds = db.prepare("SELECT id FROM classes ORDER BY name, parallel").all().map((r) => r.id);
  const curIdx = orderedIds.findIndex((id) => String(id) === String(req.params.id));
  const prevId = curIdx > 0 ? orderedIds[curIdx - 1] : null;
  const nextId = curIdx >= 0 && curIdx < orderedIds.length - 1 ? orderedIds[curIdx + 1] : null;

  res.render("classes/form", {
    classRow, mode: "edit", categories, conflict: req.query.conflict === "1",
    teacherAssignments, allTeachers, teacherAssignError: req.query.teacherAssignError || null,
    prevId, nextId, saved: req.query.saved === "1",
  });
});

router.post("/:id/teachers", (req, res) => {
  const { teacher_id, role } = req.body;
  if (teacher_id) {
    if (role === "בוקר" || role === 'אחה"צ') {
      const existing = db.prepare(`
        SELECT t.id, t.first_name, t.last_name FROM teacher_classes tc
        JOIN teachers t ON tc.teacher_id = t.id
        WHERE tc.class_id = ? AND tc.role = ? AND tc.teacher_id != ?
      `).get(req.params.id, role, teacher_id);
      if (existing) {
        const msg = `הכיתה כבר משובצת ל${role} עם ${existing.first_name || ""} ${existing.last_name || ""}. לא ניתן לשבץ מלמד נוסף לאותה כיתה באותה משמרת.`;
        return res.redirect(`/classes/${req.params.id}/edit?teacherAssignError=${encodeURIComponent(msg)}`);
      }
    }
    db.prepare("INSERT INTO teacher_classes (class_id, teacher_id, role) VALUES (?,?,?)").run(
      req.params.id, teacher_id, role || null
    );
  }
  res.redirect(`/classes/${req.params.id}/edit`);
});

router.delete("/:id/teachers/:assignmentId", (req, res) => {
  db.prepare("DELETE FROM teacher_classes WHERE id = ? AND class_id = ?").run(
    req.params.assignmentId, req.params.id
  );
  res.redirect(`/classes/${req.params.id}/edit`);
});

router.put("/:id", (req, res) => {
  const body = req.body;
  if (!checkNoConflict("classes", req.params.id, body.updated_at)) {
    return res.redirect(`/classes/${req.params.id}/edit?conflict=1`);
  }
  const cols = CLASS_FIELDS.filter((c) => c in body);
  const setClause = [...cols.map((c) => `${c} = ?`), "updated_at = ?"].join(", ");
  const values = [...cols.map((c) => (body[c] === "" ? null : body[c])), new Date().toISOString()];
  values.push(req.params.id);
  db.prepare(`UPDATE classes SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect(`/classes/${req.params.id}/edit?saved=1`);
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM classes WHERE id = ?").run(req.params.id);
  res.redirect("/classes");
});

// ============ מחזורים - הוספה/עריכה/מחיקה ============
router.get("/cohorts/new", (req, res) => {
  const currentYear = hd.currentHebrewYearNumber();
  res.render("classes/cohort-form", {
    cohort: {
      start_day: 1, start_month: 4, start_year: currentYear,
      end_day: 30, end_month: 3, end_year: currentYear + 1,
    },
    mode: "new",
  });
});

const COHORT_FIELDS = ["name", "status"];

function hebrewFieldsToSerial(day, month, year) {
  if (!day || !month || !year) return null;
  const abs = hd.hebrewPartsToAbsolute(parseInt(year, 10), parseInt(month, 10), parseInt(day, 10));
  return hd.absoluteToAccessSerial(abs);
}

router.post("/cohorts", (req, res) => {
  const body = req.body;
  const cols = [...COHORT_FIELDS.filter((c) => c in body), "from_date", "to_date"];
  const values = [
    ...COHORT_FIELDS.filter((c) => c in body).map((c) => body[c] || null),
    hebrewFieldsToSerial(body.start_day, body.start_month, body.start_year),
    hebrewFieldsToSerial(body.end_day, body.end_month, body.end_year),
  ];
  db.prepare(`INSERT INTO cohorts (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...values);
  res.redirect("/classes");
});

router.get("/cohorts/:id/edit", (req, res) => {
  const cohort = db.prepare("SELECT * FROM cohorts WHERE id = ?").get(req.params.id);
  if (!cohort) return res.status(404).render("404");
  const startParts = hd.serialToHebrewParts(cohort.from_date) || { day: 1, month: 4, year: hd.currentHebrewYearNumber() };
  const endParts = hd.serialToHebrewParts(cohort.to_date) || { day: 30, month: 3, year: hd.currentHebrewYearNumber() + 1 };
  res.render("classes/cohort-form", {
    cohort: {
      ...cohort,
      start_day: startParts.day, start_month: startParts.month, start_year: startParts.year,
      end_day: endParts.day, end_month: endParts.month, end_year: endParts.year,
    },
    mode: "edit",
    conflict: req.query.conflict === "1",
  });
});

router.put("/cohorts/:id", (req, res) => {
  const body = req.body;
  if (!checkNoConflict("cohorts", req.params.id, body.updated_at)) {
    return res.redirect(`/classes/cohorts/${req.params.id}/edit?conflict=1`);
  }
  const cols = [...COHORT_FIELDS.filter((c) => c in body), "from_date", "to_date", "updated_at"];
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = [
    ...COHORT_FIELDS.filter((c) => c in body).map((c) => body[c] || null),
    hebrewFieldsToSerial(body.start_day, body.start_month, body.start_year),
    hebrewFieldsToSerial(body.end_day, body.end_month, body.end_year),
    new Date().toISOString(),
  ];
  values.push(req.params.id);
  db.prepare(`UPDATE cohorts SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect("/classes");
});

router.delete("/cohorts/:id", (req, res) => {
  db.prepare("DELETE FROM cohorts WHERE id = ?").run(req.params.id);
  res.redirect("/classes");
});

// ============ שיבוץ אוטומטי לכיתות "עדיין לא נכנסו" לפי אזור מגורים ============
const { getZoneForAddress } = require("../streetZones");

router.get("/zone-assignment", (req, res) => {
  const cohortId = req.query.cohort_id || "";
  const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();

  let students;
  if (cohortId) {
    students = db.prepare(`
      SELECT s.id, s.first_name, s.last_name, s.class_id, s.status,
             c.parallel AS current_parallel, c.name AS current_class_name,
             f.street, f.house_number, f.city
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN families f ON s.family_id = f.id
      WHERE s.cohort_id = ? AND s.status NOT IN ('ארכיון', 'לא התקבל')
      ORDER BY s.last_name, s.first_name
    `).all(cohortId);
  } else {
    students = db.prepare(`
      SELECT s.id, s.first_name, s.last_name, s.class_id, s.status,
             c.parallel AS current_parallel, c.name AS current_class_name,
             f.street, f.house_number, f.city
      FROM students s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN families f ON s.family_id = f.id
      WHERE c.name LIKE 'עדיין לא נכנסו%' AND s.status NOT IN ('ארכיון', 'לא התקבל')
      ORDER BY s.last_name, s.first_name
    `).all();
  }

  const targetClassesByParallel = {};
  [1, 2, 3, 4].forEach((p) => {
    targetClassesByParallel[p] = db
      .prepare("SELECT id, parallel, branch FROM classes WHERE name LIKE 'עדיין לא נכנסו%' AND parallel = ? AND status = 'פעיל' LIMIT 1")
      .get(String(p));
  });

  const rows = students.map((s) => {
    const result = getZoneForAddress(s.street, s.house_number);
    let targetClass = null, status = "unmatched";
    if (result) {
      targetClass = targetClassesByParallel[result.zone];
      if (!targetClass) status = "missing_class";
      else if (targetClass.id === s.class_id) status = "already_correct";
      else status = "needs_move";
    }
    return {
      ...s,
      zone: result ? result.zone : null,
      branch: result ? result.branch : null,
      target_class_id: targetClass ? targetClass.id : null,
      status,
    };
  });

  const summary = {
    total: rows.length,
    needs_move: rows.filter((r) => r.status === "needs_move").length,
    already_correct: rows.filter((r) => r.status === "already_correct").length,
    unmatched: rows.filter((r) => r.status === "unmatched").length,
    missing_class: rows.filter((r) => r.status === "missing_class").length,
  };

  res.render("classes/zone-assignment", {
    rows, summary, cohorts, cohortId,
    done: req.query.done === "1",
  });
});

router.post("/zone-assignment/apply", (req, res) => {
  let studentIds = req.body.student_id || [];
  if (!Array.isArray(studentIds)) studentIds = [studentIds];
  let targetIds = req.body.target_class_id || [];
  if (!Array.isArray(targetIds)) targetIds = [targetIds];
  const setInactive = req.body.set_inactive === "1";
  const cohortId = req.body.cohort_id || "";

  const updateWithStatus = db.prepare("UPDATE students SET class_id = ?, status = 'לא פעיל' WHERE id = ?");
  const updateClassOnly = db.prepare("UPDATE students SET class_id = ? WHERE id = ?");
  studentIds.forEach((sid, i) => {
    if (targetIds[i]) {
      if (setInactive) updateWithStatus.run(targetIds[i], sid);
      else updateClassOnly.run(targetIds[i], sid);
    }
  });

  const qs = cohortId ? `cohort_id=${encodeURIComponent(cohortId)}&done=1` : "done=1";
  res.redirect(`/classes/zone-assignment?${qs}`);
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
    .prepare(`
      SELECT s.*, f.sector, f.home_phone, f.father_mobile, f.mother_mobile,
             f.street, f.house_number, f.city
      FROM students s
      LEFT JOIN families f ON s.family_id = f.id
      WHERE s.class_id = ?
      ORDER BY s.last_name, s.first_name
    `)
    .all(req.params.id)
    .map((s) => ({ ...s, birth_date_hebrew_str: hd.serialToHebrewString(s.birth_date_civil) }));

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
