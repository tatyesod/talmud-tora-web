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
    row.forEach((val, i) => {
      if (val instanceof Date) {
        r.getCell(i + 1).numFmt = "dd/mm/yyyy";
      }
    });
  });

  ws.columns.forEach((col, i) => {
    let maxLen = (headerRow[i] || "").toString().length;
    dataRows.forEach((row) => {
      const cellVal = row[i];
      const v = cellVal instanceof Date ? "00/00/0000" : (cellVal != null ? String(cellVal) : "");
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
  let classIds = req.query.class_id || [];
  if (!Array.isArray(classIds)) classIds = [classIds];
  classIds = classIds.filter(Boolean);

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
  if (classIds.length > 0) {
    sql += ` AND s.class_id IN (${classIds.map(() => "?").join(",")})`;
    params.push(...classIds);
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
    buildAddress(r), hd.serialToDateObject(r.birth_date_civil),
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
    SELECT s.first_name, s.last_name, c.name AS class_name, c.parallel
    FROM students s LEFT JOIN classes c ON s.class_id = c.id
    WHERE s.family_id = ? AND s.status='פעיל' AND c.id IS NOT NULL
    ORDER BY s.birth_date_civil ASC LIMIT 1
  `);

  const header = ["שם משפחה", "שם האב", "שם האם", "טלפון בית", "נייד אב", "נייד אם", "כתובת", "מס' ילדים פעילים", "שם האח הבכור", "כיתת האח הבכור"];
  const enriched = rows.map((r) => {
    const eldest = eldestClassStmt.get(r.id);
    const eldestName = eldest ? `${eldest.first_name || ""} ${eldest.last_name || ""}`.trim() : "";
    const eldestClass = eldest?.class_name ? eldest.class_name + (eldest.parallel ? " " + eldest.parallel : "") : "";
    return { r, eldestName, eldestClass };
  });
  enriched.sort((a, b) => a.eldestClass.localeCompare(b.eldestClass, "he"));
  const data = enriched.map(({ r, eldestName, eldestClass }) => [
    r.last_name || "", r.father_name || "", r.mother_name || "",
    r.home_phone || "", r.father_mobile || "", r.mother_mobile || "",
    buildAddress(r), r.active_children, eldestName, eldestClass,
  ]);

  if (output === "print") {
    const header2 = ["שם משפחה", "שם האב", "שם האם", "טלפון בית", "נייד אב", "נייד אם", "כתובת", "ילדים פעילים", "שם הבכור", "כיתת הבכור"];
    return res.render("reports/print-view", { title: "דוח משפחות", headers: header2, rows: data });
  }

  await sendWorkbook(res, "דוח משפחות.xlsx", "משפחות", "דוח משפחות", header, data);
});

// ============ דוח שכר לימוד למשפחה, עם סינון לפי חברת גביה - ייצוא לאקסל ============
router.get("/tuition-by-billing-company", (req, res) => {
  const companies = db
    .prepare("SELECT DISTINCT billing_company FROM families WHERE billing_company IS NOT NULL AND TRIM(billing_company) != '' ORDER BY billing_company")
    .all()
    .map((r) => r.billing_company);
  res.render("reports/tuition-by-billing-company", { companies });
});

router.get("/tuition-by-billing-company/export", async (req, res) => {
  const { calcAllFamiliesTuition } = require("../tuitionCalc");
  const billingCompany = req.query.billing_company || "";
  const output = req.query.output || "excel";

  let familiesTuition = calcAllFamiliesTuition();
  if (billingCompany) {
    familiesTuition = familiesTuition.filter((f) => (f.billing_company || "") === billingCompany);
  }

  const header = [
    "שם משפחה", "חברת גביה", "שם האב", "טלפון בית", "נייד אב", "נייד אם", "כתובת",
    "מס' ילדים פעילים", "סה\"כ מלא", "אחוז הנחה", "סכום הנחה", "לתשלום חודשי",
  ];
  const data = familiesTuition.map((f) => [
    f.last_name || "", f.billing_company || "", f.father_name || "", f.home_phone || "",
    f.father_mobile || "", f.mother_mobile || "", buildAddress(f),
    f.activeCount, f.grossTotal, f.discountPercent + "%", f.discountAmount, f.netTotal,
  ]);

  const reportTitle = billingCompany ? `דוח שכר לימוד - חברת גביה: ${billingCompany}` : "דוח שכר לימוד - כל המשפחות";

  if (output === "print") {
    return res.render("reports/print-view", { title: reportTitle, headers: header, rows: data });
  }

  await sendWorkbook(res, "דוח שכר לימוד לפי חברת גביה.xlsx", "שכר לימוד", reportTitle, header, data);
});

// ============ רשימת רחובות ייחודית - ייצוא לאקסל ============
router.get("/streets-export", async (req, res) => {
  const rows = db.prepare(`
    SELECT f.street, f.city, COUNT(*) AS family_count
    FROM families f
    WHERE f.street IS NOT NULL AND TRIM(f.street) != ''
    GROUP BY f.street, f.city
    ORDER BY f.street
  `).all();
  const header = ["רחוב", "עיר", "מס' משפחות ברחוב זה"];
  const data = rows.map((r) => [r.street || "", r.city || "", r.family_count]);
  await sendWorkbook(res, "רשימת רחובות.xlsx", "רחובות", "רשימת רחובות ייחודית", header, data);
});

// ============ רשימת סבים וכתובתם - ייצוא לאקסל ============
router.get("/grandparents-report", (req, res) => {
  res.render("reports/grandparents-report");
});

router.get("/grandparents-report/export", async (req, res) => {
  const families = db.prepare(`
    SELECT last_name, paternal_grandparents, paternal_grandparents_address,
           maternal_grandparents, maternal_grandparents_address
    FROM families
    WHERE (paternal_grandparents IS NOT NULL AND paternal_grandparents <> '')
       OR (maternal_grandparents IS NOT NULL AND maternal_grandparents <> '')
    ORDER BY last_name
  `).all();

  const header = ["משפחת הנכד/ה", "צד", "שם הסב/סבתא", "כתובת"];
  const data = [];
  families.forEach((f) => {
    if (f.paternal_grandparents) {
      data.push([f.last_name || "", "הורי האב", f.paternal_grandparents, f.paternal_grandparents_address || ""]);
    }
    if (f.maternal_grandparents) {
      data.push([f.last_name || "", "הורי האם", f.maternal_grandparents, f.maternal_grandparents_address || ""]);
    }
  });
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
           f.father_name, f.father_id_number, f.father_workplace, f.father_mobile, f.father_work_phone, f.father_email,
           f.mother_name, f.mother_workplace, f.mother_mobile, f.mother_work_phone, f.mother_email,
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
    birth_country: s.birth_country || "ישראל",
  }));

  res.render("reports/health-declaration-print", { students });
});

// ============ רישום גני ילדים (מכינה א'-ב') לפי תבנית משרד החינוך ============
router.get("/gan-export", async (req, res) => {
  const classes = db.prepare(`
    SELECT id, name, parallel, institution_code FROM classes
    WHERE (name = 'מכינה א''' OR name = 'מכינה ב''') AND status = 'פעיל'
    ORDER BY name, parallel
  `).all();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("רישום גני ילדים", { views: [{ rightToLeft: true }] });
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 14;
  ws.getColumn(4).width = 12;

  const titleRow = ws.addRow(["תלמוד תורה יסוד העולם"]);
  titleRow.getCell(1).font = { bold: true, size: 13 };
  const headerRow = ws.addRow(["שם פרטי ומשפחה", "מ.ז", "ת.ל לועזי", "סמל גן"]);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF4F8" } };
  });

  classes.forEach((cls) => {
    let students = db.prepare(`
      SELECT first_name, last_name, id_number, birth_date_civil
      FROM students WHERE class_id = ? AND status = 'פעיל'
      ORDER BY last_name, first_name
    `).all(cls.id).map((s) => {
      const d = hd.serialToDateObject(s.birth_date_civil);
      return { ...s, birthYear: d ? d.getFullYear() : null };
    });

    // במכינה ב' לפעמים יש 3 שנתונים בכיתה אחת (למשל 2020,2021,2022) - יש להשאיר
    // תמיד רק את 2 השנתונים הצעירים (הקטנים), ולהוציא את השנתון הגדול/מבוגר מבין השלושה
    if (cls.name === "מכינה ב'") {
      const years = [...new Set(students.map((s) => s.birthYear).filter((y) => y != null))];
      if (years.length > 2) {
        const oldestYear = Math.min(...years);
        students = students.filter((s) => s.birthYear !== oldestYear);
      }
    }

    students.forEach((s) => {
      const row = ws.addRow([
        `${s.first_name || ""} ${s.last_name || ""}`.trim(),
        s.id_number || "",
        hd.serialToDateObject(s.birth_date_civil),
        cls.institution_code || "", // סמל מוסד - מהכיתה, אם הוגדר
      ]);
      if (row.getCell(3).value instanceof Date) row.getCell(3).numFmt = "dd/mm/yyyy";
      row.alignment = { horizontal: "right" };
    });
  });

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent("רישום-גני-ילדים.xlsx")}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
});

// ============ ילדי גן בכיתה א' - איתור התלמידים הצעירים ביותר בכל כיתה א' ============
// פעולה הפוכה מ"רישום גני ילדים": שם הוצאנו את השנתון הגדול (המבוגר), כאן מרכזים
// דווקא את השנתון הקטן (הצעיר) ביותר בכל כיתה - התלמידים שהם בגיל גן אך משובצים בכיתה א'.
router.get("/young-kids-grade-a", async (req, res) => {
  const classes = db.prepare(`
    SELECT id, name, parallel FROM classes
    WHERE name = 'כיתה א''' AND status = 'פעיל'
    ORDER BY parallel
  `).all();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ילדי גן בכיתה א", { views: [{ rightToLeft: true }] });
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 14;
  ws.getColumn(4).width = 14;

  const titleRow = ws.addRow(["תלמוד תורה יסוד העולם"]);
  titleRow.getCell(1).font = { bold: true, size: 13 };
  const headerRow = ws.addRow(["שם פרטי ומשפחה", "מ.ז", "ת.ל לועזי", "כיתה"]);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF4F8" } };
  });

  classes.forEach((cls) => {
    const students = db.prepare(`
      SELECT first_name, last_name, id_number, birth_date_civil
      FROM students WHERE class_id = ? AND status = 'פעיל'
      ORDER BY last_name, first_name
    `).all(cls.id).map((s) => {
      const d = hd.serialToDateObject(s.birth_date_civil);
      return { ...s, birthYear: d ? d.getFullYear() : null };
    });

    // רק אם יש בפועל יותר משנתון אחד בכיתה, יש טעם "לחלץ" את הצעירים ביותר -
    // אחרת (כולם מאותו שנתון) אין ילדי-גן חריגים לדווח עליהם מהכיתה הזו.
    const years = [...new Set(students.map((s) => s.birthYear).filter((y) => y != null))];
    if (years.length <= 1) return;

    const youngestYear = Math.max(...years);
    const youngStudents = students.filter((s) => s.birthYear === youngestYear);

    youngStudents.forEach((s) => {
      const row = ws.addRow([
        `${s.first_name || ""} ${s.last_name || ""}`.trim(),
        s.id_number || "",
        hd.serialToDateObject(s.birth_date_civil),
        `${cls.name}${cls.parallel ? " " + cls.parallel : ""}`,
      ]);
      if (row.getCell(3).value instanceof Date) row.getCell(3).numFmt = "dd/mm/yyyy";
      row.alignment = { horizontal: "right" };
    });
  });

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent("ילדי-גן-בכיתה-א.xlsx")}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
});

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
    headers = ["משפחת הנכד/ה", "צד", "שם הסב/סבתא", "כתובת"];
    const families2 = db.prepare(`
      SELECT last_name, paternal_grandparents, paternal_grandparents_address,
             maternal_grandparents, maternal_grandparents_address
      FROM families
      WHERE (paternal_grandparents IS NOT NULL AND paternal_grandparents <> '')
         OR (maternal_grandparents IS NOT NULL AND maternal_grandparents <> '')
      ORDER BY last_name
    `).all();
    families2.forEach((f) => {
      if (f.paternal_grandparents) rows.push([f.last_name || "", "הורי האב", f.paternal_grandparents, f.paternal_grandparents_address || ""]);
      if (f.maternal_grandparents) rows.push([f.last_name || "", "הורי האם", f.maternal_grandparents, f.maternal_grandparents_address || ""]);
    });
  }

  res.render("reports/print-view", { title, headers, rows });
});

module.exports = router;
