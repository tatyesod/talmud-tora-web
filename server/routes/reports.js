const express = require("express");
const router = express.Router();
const db = require("../db");
const XLSX = require("xlsx");
const hd = require("../hebrewDate");

function buildAddress(row) {
  return [row.street, row.house_number ? row.house_number : null, row.city]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function sendWorkbook(res, filename, sheetName, headerRow, dataRows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  ws["!cols"] = headerRow.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
}

// --- מסך ראשי - תפריט דוחות ---
router.get("/", (req, res) => {
  res.render("reports/menu");
});

// ============ רשימת כיתות - ייצוא לאקסל ============
router.get("/class-list", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel, status FROM classes ORDER BY name, parallel").all();
  const statuses = db.prepare("SELECT DISTINCT status FROM students WHERE status IS NOT NULL ORDER BY status").all();
  res.render("reports/class-list", { classes, statuses });
});

router.get("/class-list/export", (req, res) => {
  let classIds = req.query.class_id || [];
  if (!Array.isArray(classIds)) classIds = [classIds];
  const status = req.query.status || "";

  let sql = `
    SELECT s.last_name, s.first_name, c.name AS class_name, c.parallel,
           f.street, f.house_number, f.city, f.home_phone, f.father_mobile, f.mother_mobile
    FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    LEFT JOIN families f ON s.family_id = f.id
    WHERE 1=1
  `;
  const params = [];
  if (classIds.length > 0) {
    sql += ` AND s.class_id IN (${classIds.map(() => "?").join(",")})`;
    params.push(...classIds);
  }
  if (status) {
    sql += " AND s.status = ?";
    params.push(status);
  }
  sql += " ORDER BY c.name, c.parallel, s.last_name, s.first_name";

  const rows = db.prepare(sql).all(...params);
  const header = ["שם משפחה", "שם פרטי", "כתה", "כתובת", "טלפון בבית", "נייד אב", "נייד אם"];
  const data = rows.map((r) => [
    r.last_name || "",
    r.first_name || "",
    r.class_name ? r.class_name + (r.parallel ? " " + r.parallel : "") : "",
    buildAddress(r),
    r.home_phone || "",
    r.father_mobile || "",
    r.mother_mobile || "",
  ]);

  sendWorkbook(res, "רשימת כתות.xlsx", "רשימת כתות", header, data);
});

// ============ רשימת תלמידים מלא - ייצוא לאקסל ============
router.get("/full-student-list", (req, res) => {
  const statuses = db.prepare("SELECT DISTINCT status FROM students WHERE status IS NOT NULL ORDER BY status").all();
  res.render("reports/full-student-list", { statuses });
});

router.get("/full-student-list/export", (req, res) => {
  const status = req.query.status || "";
  let sql = `
    SELECT s.last_name, s.first_name, s.id_number, c.name AS class_name, c.parallel,
           s.status, f.father_name, f.mother_name, f.home_phone, f.father_mobile,
           f.mother_mobile, f.street, f.house_number, f.city, s.birth_date_civil
    FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    LEFT JOIN families f ON s.family_id = f.id
    WHERE 1=1
  `;
  const params = [];
  if (status) {
    sql += " AND s.status = ?";
    params.push(status);
  }
  sql += " ORDER BY s.last_name, s.first_name";
  const rows = db.prepare(sql).all(...params);

  const header = [
    "שם משפחה", "שם פרטי", "ת.ז", "כתה", "סטטוס", "שם האב", "שם האם",
    "טלפון בית", "נייד אב", "נייד אם", "כתובת", "תאריך לידה",
  ];
  const data = rows.map((r) => [
    r.last_name || "", r.first_name || "", r.id_number || "",
    r.class_name ? r.class_name + (r.parallel ? " " + r.parallel : "") : "",
    r.status || "", r.father_name || "", r.mother_name || "",
    r.home_phone || "", r.father_mobile || "", r.mother_mobile || "",
    buildAddress(r), hd.serialToGregorianString(r.birth_date_civil),
  ]);

  sendWorkbook(res, "רשימת תלמידים מלא.xlsx", "תלמידים", header, data);
});

// ============ דוח משפחות - ייצוא לאקסל ============
router.get("/families-report", (req, res) => {
  res.render("reports/families-report");
});

router.get("/families-report/export", (req, res) => {
  const rows = db.prepare(`
    SELECT f.id, f.last_name, f.father_name, f.mother_name, f.home_phone, f.father_mobile,
           f.mother_mobile, f.street, f.house_number, f.city,
           (SELECT COUNT(*) FROM students s WHERE s.family_id = f.id AND s.status='פעיל') AS active_children
    FROM families f
    ORDER BY f.last_name
  `).all();

  const eldestClassStmt = db.prepare(`
    SELECT c.name AS class_name, c.parallel
    FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    WHERE s.family_id = ?
    ORDER BY (s.birth_date_civil IS NULL), s.birth_date_civil ASC
    LIMIT 1
  `);

  const header = ["שם משפחה", "שם האב", "שם האם", "טלפון בית", "נייד אב", "נייד אם", "כתובת", "מס' ילדים פעילים", "כיתת האח הבכור"];
  const data = rows.map((r) => {
    const eldest = eldestClassStmt.get(r.id);
    const eldestClass = eldest && eldest.class_name
      ? eldest.class_name + (eldest.parallel ? " " + eldest.parallel : "")
      : "";
    return [
      r.last_name || "", r.father_name || "", r.mother_name || "",
      r.home_phone || "", r.father_mobile || "", r.mother_mobile || "",
      buildAddress(r), r.active_children, eldestClass,
    ];
  });

  sendWorkbook(res, "דוח משפחות.xlsx", "משפחות", header, data);
});

// ============ רשימת סבים וכתובתם - ייצוא לאקסל ============
router.get("/grandparents-report", (req, res) => {
  res.render("reports/grandparents-report");
});

router.get("/grandparents-report/export", (req, res) => {
  const rows = db.prepare("SELECT name, address, city FROM grandparents WHERE name IS NOT NULL ORDER BY name").all();
  const header = ["שם", "כתובת", "עיר"];
  const data = rows.map((r) => [r.name || "", r.address || "", r.city || ""]);
  sendWorkbook(res, "רשימת סבים וכתובתם.xlsx", "סבים", header, data);
});

// ============ יומן כיתה ============
router.get("/class-journal", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("reports/class-journal", { classes });
});

router.get("/class-journal/view", (req, res) => {
  const classId = req.query.class_id;
  if (!classId) return res.redirect("/reports/class-journal");
  const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(classId);
  const students = db
    .prepare("SELECT * FROM students WHERE class_id = ? AND status = 'פעיל' ORDER BY last_name, first_name")
    .all(classId);
  res.render("reports/class-journal-print", { classRow, students });
});

// ============ הצהרת בריאות ============
router.get("/health-declaration", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("reports/health-declaration", { classes });
});

router.get("/health-declaration/view", (req, res) => {
  let classIds = req.query.class_id || [];
  if (!Array.isArray(classIds)) classIds = [classIds];

  let sql = `
    SELECT s.*, c.name AS class_name, c.parallel AS class_parallel,
           f.father_name, f.father_id_number, f.father_workplace, f.father_mobile, f.father_work_phone,
           f.mother_name, f.mother_workplace, f.mother_mobile, f.mother_work_phone,
           f.home_phone, f.street, f.house_number, f.apartment, f.city,
           (SELECT COUNT(*) FROM students s2 WHERE s2.family_id = s.family_id) AS siblings_count
    FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    LEFT JOIN families f ON s.family_id = f.id
    WHERE s.status = 'פעיל'
  `;
  const params = [];
  if (classIds.length > 0) {
    sql += ` AND s.class_id IN (${classIds.map(() => "?").join(",")})`;
    params.push(...classIds);
  }
  sql += " ORDER BY c.name, c.parallel, s.last_name, s.first_name";

  const students = db.prepare(sql).all(...params).map((s) => ({
    ...s,
    birth_date_civil_str: hd.serialToGregorianString(s.birth_date_civil),
    birth_date_hebrew_str: hd.serialToHebrewString(s.birth_date_civil),
    address: [s.street, s.house_number, s.apartment ? "דירה " + s.apartment : "", s.city].filter(Boolean).join(" "),
    emergency_contact: db.prepare("SELECT * FROM emergency_contacts WHERE family_id = ? LIMIT 1").get(s.family_id),
    hasHealthIssue: !!(
      (s.allergies && s.allergies !== "לא ידוע") || (s.medications && s.medications !== "לא ידוע")
    ),
  }));

  res.render("reports/health-declaration-print", { students });
});

module.exports = router;
