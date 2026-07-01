const express = require("express");
const router = express.Router();
const db = require("../db");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");
const hd = require("../hebrewDate");

const LOGO_PATH = path.join(__dirname, "..", "public", "images", "logo-reports.jpg");
const LOGO_EXT = "jpeg";

function buildAddress(row) {
  return [row.street, row.house_number ? row.house_number : null, row.city]
    .filter(Boolean)
    .join(" ")
    .trim();
}

async function sendWorkbook(res, filename, sheetName, reportTitle, headerRow, dataRows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "מערכת ניהול תלמוד תורה החדש";
  const ws = wb.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });

  const lastCol = headerRow.length;

  // --- כותרת עליונה: שם המוסד + שם הדוח, עם מקום ללוגו בצד ימין ---
  ws.mergeCells(1, 1, 1, Math.max(1, lastCol - 1));
  const titleCell = ws.getCell(1, 1);
  titleCell.value = "תלמוד תורה החדש";
  titleCell.font = { size: 16, bold: true, color: { argb: "FF2C5F7C" } };
  titleCell.alignment = { horizontal: "right", vertical: "middle" };
  ws.getRow(1).height = 28;

  ws.mergeCells(2, 1, 2, Math.max(1, lastCol - 1));
  const subtitleCell = ws.getCell(2, 1);
  subtitleCell.value = reportTitle;
  subtitleCell.font = { size: 12, bold: true, color: { argb: "FF555555" } };
  subtitleCell.alignment = { horizontal: "right", vertical: "middle" };

  ws.mergeCells(3, 1, 3, Math.max(1, lastCol - 1));
  const dateCell = ws.getCell(3, 1);
  dateCell.value = `הופק בתאריך: ${new Date().toLocaleDateString("he-IL")}`;
  dateCell.font = { size: 9, italic: true, color: { argb: "FF888888" } };
  dateCell.alignment = { horizontal: "right", vertical: "middle" };

  // לוגו בעמודה הימנית ביותר (אם קיים קובץ לוגו)
  if (fs.existsSync(LOGO_PATH)) {
    try {
      const imageId = wb.addImage({ filename: LOGO_PATH, extension: LOGO_EXT });
      ws.addImage(imageId, {
        tl: { col: lastCol - 1, row: 0 },
        ext: { width: 68, height: 59 },
      });
    } catch (e) {
      // אם הוספת התמונה נכשלת, ממשיכים בלי לוגו (לא קריטי)
    }
  }

  ws.addRow([]); // שורת רווח

  const headerRowIdx = 5;
  const headerExcelRow = ws.getRow(headerRowIdx);
  headerRow.forEach((h, i) => {
    headerExcelRow.getCell(i + 1).value = h;
  });
  headerExcelRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerExcelRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C5F7C" } };
    cell.alignment = { horizontal: "right", vertical: "middle" };
    cell.border = { bottom: { style: "thin" } };
  });
  headerExcelRow.height = 20;

  dataRows.forEach((row) => {
    const r = ws.addRow(row);
    r.alignment = { horizontal: "right" };
  });

  ws.columns.forEach((col, i) => {
    let maxLen = (headerRow[i] || "").toString().length;
    dataRows.forEach((row) => {
      const v = row[i] != null ? String(row[i]) : "";
      if (v.length > maxLen) maxLen = v.length;
    });
    col.width = Math.min(Math.max(maxLen + 3, 12), 40);
  });

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res);
  res.end();
}

// --- מסך ראשי - תפריט דוחות ---
router.get("/", (req, res) => {
  res.render("reports/menu");
});

// ============ רשימת כיתות - ייצוא לאקסל ============
router.get("/class-list", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel, status, branch FROM classes ORDER BY name, parallel").all();
  const statuses = db.prepare("SELECT DISTINCT status FROM students WHERE status IS NOT NULL ORDER BY status").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  res.render("reports/class-list", { classes, statuses, branches });
});

router.get("/class-list/export", async (req, res) => {
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

  await sendWorkbook(res, "רשימת כתות.xlsx", "רשימת כתות", "רשימת כתות", header, data);
});

// ============ רשימת תלמידים מלא - ייצוא לאקסל ============
router.get("/full-student-list", (req, res) => {
  const statuses = db.prepare("SELECT DISTINCT status FROM students WHERE status IS NOT NULL ORDER BY status").all();
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY name, parallel").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  res.render("reports/full-student-list", { statuses, classes, branches });
});

router.get("/full-student-list/export", async (req, res) => {
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
  sql += " ORDER BY c.name, c.parallel, s.last_name, s.first_name";
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

  await sendWorkbook(res, "רשימת תלמידים מלא.xlsx", "תלמידים", "רשימת תלמידים מלא", header, data);
});

// ============ דוח משפחות - ייצוא לאקסל ============
router.get("/families-report", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY name, parallel").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  res.render("reports/families-report", { classes, branches });
});

router.get("/families-report/export", async (req, res) => {
  let classIds = req.query.class_id || [];
  if (!Array.isArray(classIds)) classIds = [classIds];
  const status = req.query.status || "";
  const output = req.query.output || "excel";

  let sql = `
    SELECT DISTINCT f.id, f.last_name, f.father_name, f.mother_name, f.home_phone, f.father_mobile,
           f.mother_mobile, f.street, f.house_number, f.city,
           (SELECT COUNT(*) FROM students s2 WHERE s2.family_id = f.id AND s2.status='פעיל') AS active_children
    FROM families f
    WHERE EXISTS (
      SELECT 1 FROM students s WHERE s.family_id = f.id
      ${status ? "AND s.status = '" + status.replace(/'/g, "''") + "'" : ""}
      ${classIds.length > 0 ? "AND s.class_id IN (" + classIds.map(() => "?").join(",") + ")" : ""}
    )
  `;
  const params = [...classIds];
  sql += " ORDER BY f.last_name";

  const rows = db.prepare(sql).all(...params);
  const eldestClassStmt = db.prepare(`
    SELECT c.name AS class_name, c.parallel
    FROM students s LEFT JOIN classes c ON s.class_id = c.id
    WHERE s.family_id = ? AND s.status='פעיל' AND c.id IS NOT NULL
    ORDER BY c.name, c.parallel LIMIT 1
  `);

  const header = ["שם משפחה", "שם האב", "שם האם", "טלפון בית", "נייד אב", "נייד אם", "כתובת", "מס' ילדים פעילים", "כיתת האח הבכור"];
  const enriched = rows.map((r) => {
    const eldest = eldestClassStmt.get(r.id);
    const eldestClass = eldest?.class_name ? eldest.class_name + (eldest.parallel ? " " + eldest.parallel : "") : "";
    return { r, eldestClass };
  });
  enriched.sort((a, b) => a.eldestClass.localeCompare(b.eldestClass, "he"));
  const data = enriched.map(({ r, eldestClass }) => [
    r.last_name || "", r.father_name || "", r.mother_name || "",
    r.home_phone || "", r.father_mobile || "", r.mother_mobile || "",
    buildAddress(r), r.active_children, eldestClass,
  ]);

  if (output === "print") {
    const header2 = ["שם משפחה", "שם האב", "שם האם", "טלפון בית", "נייד אב", "נייד אם", "כתובת", "ילדים פעילים", "כיתת הבכור"];
    return res.render("reports/print-view", { title: "דוח משפחות", headers: header2, rows: data });
  }

  await sendWorkbook(res, "דוח משפחות.xlsx", "משפחות", "דוח משפחות", header, data);
});

// ============ רשימת סבים וכתובתם - ייצוא לאקסל ============
router.get("/grandparents-report", (req, res) => {
  res.render("reports/grandparents-report");
});

router.get("/grandparents-report/export", async (req, res) => {
  const rows = db.prepare("SELECT name, address, city FROM grandparents WHERE name IS NOT NULL ORDER BY name").all();
  const header = ["שם", "כתובת", "עיר"];
  const data = rows.map((r) => [r.name || "", r.address || "", r.city || ""]);
  await sendWorkbook(res, "רשימת סבים וכתובתם.xlsx", "סבים", "רשימת סבים וכתובתם", header, data);
});

// ============ יומן כיתה (4 פורמטים) ============
router.get("/class-journal", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY name, parallel").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  res.render("reports/class-journal", { classes, branches });
});

router.get("/class-journal/view", (req, res) => {
  const { class_id, fmt } = req.query;
  if (!class_id) return res.redirect("/reports/class-journal");
  const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(class_id);
  const students = db
    .prepare("SELECT s.first_name, s.last_name, f.last_name AS family_last FROM students s LEFT JOIN families f ON s.family_id=f.id WHERE s.class_id = ? AND s.status = 'פעיל' ORDER BY s.last_name, s.first_name")
    .all(class_id)
    .map(s => ({ ...s, displayName: (s.last_name || s.family_last || "") + " " + (s.first_name || "") }));
  // teacher
  const teacher = db.prepare("SELECT t.first_name, t.last_name FROM teacher_classes tc JOIN teachers t ON tc.teacher_id=t.id WHERE tc.class_id=? ORDER BY tc.id LIMIT 1").get(class_id);
  const teacherName = teacher ? `ר' ${teacher.first_name || ""} ${teacher.last_name || ""}`.trim() : "";
  res.render("reports/class-journal-print", { classRow, students, teacherName, fmt: fmt || "7col" });
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

// ============ יצוא PDF — תצוגת הדפסה לדוחות קיימים ============
router.get("/print-view", (req, res) => {
  const { type, status, class_id } = req.query;
  let classIds = class_id || [];
  if (!Array.isArray(classIds)) classIds = [classIds];

  let title = "", headers = [], rows = [];

  if (type === "full-student-list") {
    title = "רשימת תלמידים מלא";
    headers = ["שם משפחה", "שם פרטי", "כיתה", "סטטוס", "טלפון בית", "נייד אב", "נייד אם", "כתובת"];
    let sql = `SELECT s.last_name, s.first_name, c.name||' '||COALESCE(c.parallel,'') AS cls,
      s.status, f.home_phone, f.father_mobile, f.mother_mobile, f.street||' '||COALESCE(f.house_number,'')||' '||COALESCE(f.city,'') AS addr
      FROM students s LEFT JOIN classes c ON s.class_id=c.id LEFT JOIN families f ON s.family_id=f.id WHERE 1=1`;
    const params = [];
    if (status) { sql += " AND s.status=?"; params.push(status); }
    if (classIds.length > 0) { sql += ` AND s.class_id IN (${classIds.map(()=>"?").join(",")})`; params.push(...classIds); }
    sql += " ORDER BY c.name, c.parallel, s.last_name, s.first_name";
    rows = db.prepare(sql).all(...params).map(r => [r.last_name, r.first_name, r.cls, r.status, r.home_phone, r.father_mobile, r.mother_mobile, r.addr]);

  } else if (type === "families-report") {
    title = "דוח משפחות";
    headers = ["שם משפחה", "שם האב", "שם האם", "טלפון בית", "נייד אב", "נייד אם", "כתובת", "ילדים פעילים"];
    let sql = `SELECT DISTINCT f.last_name, f.father_name, f.mother_name, f.home_phone, f.father_mobile, f.mother_mobile,
      f.street||' '||COALESCE(f.house_number,'')||' '||COALESCE(f.city,'') AS addr,
      (SELECT COUNT(*) FROM students s2 WHERE s2.family_id=f.id AND s2.status='פעיל') AS cnt
      FROM families f JOIN students s ON s.family_id=f.id WHERE 1=1`;
    const params = [];
    if (status) { sql += " AND s.status=?"; params.push(status); }
    if (classIds.length > 0) { sql += ` AND s.class_id IN (${classIds.map(()=>"?").join(",")})`; params.push(...classIds); }
    sql += " ORDER BY f.last_name";
    rows = db.prepare(sql).all(...params).map(r => [r.last_name, r.father_name, r.mother_name, r.home_phone, r.father_mobile, r.mother_mobile, r.addr, r.cnt]);

  } else if (type === "grandparents") {
    title = "רשימת סבים";
    headers = ["שם", "כתובת", "עיר"];
    rows = db.prepare("SELECT name, address, city FROM grandparents WHERE name IS NOT NULL ORDER BY name").all().map(r => [r.name, r.address, r.city]);
  }

  res.render("reports/print-view", { title, headers, rows });
});
