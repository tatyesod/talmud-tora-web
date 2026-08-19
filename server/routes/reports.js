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
  dateCell.value = `הופק בתאריך: ${hd.serialToHebrewString(hd.todayAccessSerial())}`;
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

// ============ משפחות שסיימו (כל הבנים בארכיון) - להפסקת הו"ק ============
router.get("/completed-families", (req, res) => {
  const monthsBack = parseInt(req.query.months) || 12;
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);

  const families = db.prepare(`
    SELECT f.id, f.last_name, f.father_name, f.father_id_number, f.mother_name, f.mother_id_number,
           f.street, f.house_number, f.city, f.billing_company
    FROM families f
    WHERE f.id IN (SELECT DISTINCT family_id FROM students WHERE family_id IS NOT NULL)
    ORDER BY f.last_name
  `).all();

  const studentsByFamily = db.prepare(`
    SELECT family_id, status, exit_date, updated_at FROM students WHERE family_id IS NOT NULL
  `).all();
  const grouped = {};
  studentsByFamily.forEach((s) => {
    if (!grouped[s.family_id]) grouped[s.family_id] = [];
    grouped[s.family_id].push(s);
  });

  const results = [];
  families.forEach((f) => {
    const kids = grouped[f.id] || [];
    if (kids.length === 0) return;
    const allArchived = kids.every((k) => k.status === "ארכיון");
    if (!allArchived) return;

    // תאריך "סיום" המשפחה = התאריך המאוחר מבין כל הילדים - מעדיפים תאריך
    // יציאה אם הוזן, ואם לא, נופלים חזרה לתאריך העדכון האחרון של התלמיד
    // (קירוב סביר למתי שהוא הועבר בפועל לארכיון)
    let latestDate = null;
    kids.forEach((k) => {
      let d = null;
      if (k.exit_date) {
        const g = hd.serialToDateObject(k.exit_date);
        if (g) d = g;
      }
      if (!d && k.updated_at) d = new Date(k.updated_at);
      if (d && (!latestDate || d > latestDate)) latestDate = d;
    });
    if (!latestDate || latestDate < cutoffDate) return;

    results.push({
      family: f,
      completionDate: latestDate,
      completionDateHeb: hd.anyDateToHebrewString(latestDate),
    });
  });

  results.sort((a, b) => b.completionDate - a.completionDate);

  res.render("reports/completed-families", { results, monthsBack });
});

router.get("/completed-families/export", async (req, res) => {
  const monthsBack = parseInt(req.query.months) || 12;
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);

  const families = db.prepare(`
    SELECT f.id, f.last_name, f.father_name, f.father_id_number, f.mother_name, f.mother_id_number,
           f.street, f.house_number, f.city, f.billing_company
    FROM families f
    WHERE f.id IN (SELECT DISTINCT family_id FROM students WHERE family_id IS NOT NULL)
    ORDER BY f.last_name
  `).all();

  const studentsByFamily = db.prepare(`
    SELECT family_id, status, exit_date, updated_at FROM students WHERE family_id IS NOT NULL
  `).all();
  const grouped = {};
  studentsByFamily.forEach((s) => {
    if (!grouped[s.family_id]) grouped[s.family_id] = [];
    grouped[s.family_id].push(s);
  });

  const results = [];
  families.forEach((f) => {
    const kids = grouped[f.id] || [];
    if (kids.length === 0) return;
    const allArchived = kids.every((k) => k.status === "ארכיון");
    if (!allArchived) return;

    let latestDate = null;
    kids.forEach((k) => {
      let d = null;
      if (k.exit_date) {
        const g = hd.serialToDateObject(k.exit_date);
        if (g) d = g;
      }
      if (!d && k.updated_at) d = new Date(k.updated_at);
      if (d && (!latestDate || d > latestDate)) latestDate = d;
    });
    if (!latestDate || latestDate < cutoffDate) return;

    results.push({ family: f, completionDate: latestDate, completionDateHeb: hd.anyDateToHebrewString(latestDate) });
  });
  results.sort((a, b) => b.completionDate - a.completionDate);

  const header = ["משפחה", "שם האב", "ת\"ז אב", "שם האם", "ת\"ז אם", "כתובת", "חברת גביה", "תאריך מעבר לארכיון"];
  const data = results.map((r) => [
    r.family.last_name || "", r.family.father_name || "", r.family.father_id_number || "",
    r.family.mother_name || "", r.family.mother_id_number || "",
    buildAddress(r.family), r.family.billing_company || "", r.completionDateHeb,
  ]);
  await sendWorkbook(res, "משפחות שסיימו.xlsx", "משפחות שסיימו", "משפחות שסיימו - כל הבנים בארכיון", header, data);
});

// ============ רשימת כיתות - ייצוא לאקסל ============
router.get("/class-list", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel, status, branch FROM classes ORDER BY grade_order, name, parallel").all();
  const statuses = db.prepare("SELECT DISTINCT status FROM students WHERE status IS NOT NULL ORDER BY status").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  res.render("reports/class-list", { classes, statuses, branches });
});

router.get("/class-list/export", async (req, res) => {
  let classIds = req.query.class_id || [];
  if (!Array.isArray(classIds)) classIds = [classIds];
  const status = req.query.status || "";

  let sql = `
    SELECT s.last_name, s.first_name, s.nickname, c.name AS class_name, c.parallel,
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
  sql += " ORDER BY c.grade_order, c.name, c.parallel, s.last_name, s.first_name";

  const rows = db.prepare(sql).all(...params);
  const header = ["שם משפחה", "שם פרטי", "שם חיבה", "כתה", "כתובת", "טלפון בבית", "נייד אב", "נייד אם"];
  const data = rows.map((r) => [
    r.last_name || "",
    r.first_name || "",
    r.nickname || "",
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
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY grade_order, name, parallel").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  res.render("reports/full-student-list", { statuses, classes, branches });
});

router.get("/full-student-list/export", async (req, res) => {
  const status = req.query.status || "";
  let classIds = req.query.class_id || [];
  if (!Array.isArray(classIds)) classIds = [classIds];
  classIds = classIds.filter(Boolean);

  let sql = `
    SELECT s.last_name, s.first_name, s.nickname, s.id_number, c.name AS class_name, c.parallel,
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
  sql += " ORDER BY c.grade_order, c.name, c.parallel, s.last_name, s.first_name";
  const rows = db.prepare(sql).all(...params);

  const header = [
    "שם משפחה", "שם פרטי", "שם חיבה", "ת.ז", "כתה", "סטטוס", "שם האב", "שם האם",
    "טלפון בית", "נייד אב", "נייד אם", "כתובת", "תאריך לידה",
  ];
  const data = rows.map((r) => [
    r.last_name || "", r.first_name || "", r.nickname || "", r.id_number || "",
    r.class_name ? r.class_name + (r.parallel ? " " + r.parallel : "") : "",
    r.status || "", r.father_name || "", r.mother_name || "",
    r.home_phone || "", r.father_mobile || "", r.mother_mobile || "",
    buildAddress(r), hd.serialToDateObject(r.birth_date_civil),
  ]);

  await sendWorkbook(res, "רשימת תלמידים מלא.xlsx", "תלמידים", "רשימת תלמידים מלא", header, data);
});

// ============ דוח משפחות - ייצוא לאקסל ============
router.get("/families-report", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY grade_order, name, parallel").all();
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
    SELECT s.first_name, s.nickname, s.last_name, c.name AS class_name, c.parallel
    FROM students s LEFT JOIN classes c ON s.class_id = c.id
    WHERE s.family_id = ? AND s.status='פעיל' AND c.id IS NOT NULL
    ORDER BY s.birth_date_civil ASC LIMIT 1
  `);

  const header = ["שם משפחה", "שם האב", "שם האם", "טלפון בית", "נייד אב", "נייד אם", "כתובת", "מס' ילדים פעילים", "שם האח הבכור", "כיתת האח הבכור"];
  const enriched = rows.map((r) => {
    const eldest = eldestClassStmt.get(r.id);
    const eldestName = eldest ? `${eldest.nickname || eldest.first_name || ""} ${eldest.last_name || ""}`.trim() : "";
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
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY grade_order, name, parallel").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  // כל שיוכי מלמד-כיתה, כדי לבנות ברשימה הנפתחת "מלמד" את האפשרויות
  // המתאימות לכיתה שנבחרה (בוקר/אחה"צ/עוזר) - בלי צורך בקריאת שרת נוספת
  const teacherAssignments = db.prepare(`
    SELECT tc.class_id, t.id AS teacher_id, t.first_name, t.last_name, tc.role
    FROM teacher_classes tc JOIN teachers t ON tc.teacher_id = t.id
    WHERE t.status = 'פעיל'
  `).all();
  const savedTemplates = db.prepare("SELECT id, name, pages FROM journal_templates ORDER BY name").all()
    .map((t) => ({ ...t, pages: JSON.parse(t.pages) }));
  res.render("reports/class-journal", { classes, branches, teacherAssignments, savedTemplates });
});

router.post("/class-journal/templates", (req, res) => {
  const { name, pages } = req.body;
  if (!name || !name.trim() || !pages) return res.redirect("/reports/class-journal");
  let pagesArr = Array.isArray(pages) ? pages : [pages];
  db.prepare("INSERT INTO journal_templates (name, pages, created_at) VALUES (?,?,?)").run(
    name.trim(), JSON.stringify(pagesArr), new Date().toISOString()
  );
  res.redirect("/reports/class-journal?saved=1");
});

router.delete("/class-journal/templates/:id", (req, res) => {
  db.prepare("DELETE FROM journal_templates WHERE id = ?").run(req.params.id);
  res.redirect("/reports/class-journal");
});

router.put("/class-journal/templates/:id", (req, res) => {
  const { pages, name } = req.body;
  if (!pages) return res.redirect("/reports/class-journal");
  let pagesArr = Array.isArray(pages) ? pages : [pages];
  if (name && name.trim()) {
    db.prepare("UPDATE journal_templates SET pages = ?, name = ? WHERE id = ?").run(JSON.stringify(pagesArr), name.trim(), req.params.id);
  } else {
    db.prepare("UPDATE journal_templates SET pages = ? WHERE id = ?").run(JSON.stringify(pagesArr), req.params.id);
  }
  res.redirect("/reports/class-journal?saved=1");
});

router.get("/class-journal/view", (req, res) => {
  const { class_id, teacher_id } = req.query;
  if (!class_id) return res.redirect("/reports/class-journal");
  let pages = req.query.pages || ["7col"];
  if (!Array.isArray(pages)) pages = [pages];
  const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(class_id);
  const students = db
    .prepare("SELECT s.first_name, s.nickname, s.last_name, f.last_name AS family_last FROM students s LEFT JOIN families f ON s.family_id=f.id WHERE s.class_id = ? AND s.status = 'פעיל' ORDER BY s.last_name, s.first_name")
    .all(class_id)
    .map(s => ({ ...s, displayName: (s.last_name || s.family_last || "") + " " + (s.nickname || s.first_name || "") }));
  // מלמד - אם נבחר מלמד מפורש (יש בוקר ואחה"צ, ולפעמים גם עוזר) משתמשים בו;
  // אחרת (למשל קישור ישן בלי הבחירה) נופלים חזרה לברירת המחדל הישנה
  const teacher = teacher_id
    ? db.prepare("SELECT t.first_name, t.last_name, tc.role FROM teachers t LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id AND tc.class_id = ? WHERE t.id = ?").get(class_id, teacher_id)
    : db.prepare("SELECT t.first_name, t.last_name, tc.role FROM teacher_classes tc JOIN teachers t ON tc.teacher_id=t.id WHERE tc.class_id=? ORDER BY tc.id LIMIT 1").get(class_id);
  const teacherName = teacher ? `הרב ${teacher.first_name || ""} ${teacher.last_name || ""}`.trim() : "";
  const teacherRole = teacher ? teacher.role || "" : "";
  res.render("reports/class-journal-print", { classRow, students, teacherName, teacherRole, pages });
});

// ============ דף בודד (כמו דפי יומן כיתה, אבל לא חלק מחוברת) ============
// ============ אלפון כיתתי ============
// ============ רשימת שלוחות - דף לתלייה ליד הטלפון בכל כיתה ============
// ============ ניהול שלוחות מרוכז - כיתות, תפקידי צוות ומיקומים נוספים
//              יחד בדף אחד, כדי לא לדלג בין מסכים ============
router.get("/extensions-admin", (req, res) => {
  const classes = db.prepare(`
    SELECT id, name, parallel, branch, extension FROM classes
    WHERE status = 'פעיל'
    ORDER BY branch IS NOT NULL, branch, grade_order, name, parallel
  `).all();
  const staffRoles = db.prepare(`
    SELECT id, name, branch, extension FROM staff_roles
    ORDER BY branch IS NOT NULL, branch, grade_order, name
  `).all();
  const miscLocations = db.prepare(`
    SELECT id, name, branch, extension FROM misc_extensions
    ORDER BY branch IS NOT NULL, branch, grade_order, name
  `).all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL AND branch != '' ORDER BY branch").all().map((r) => r.branch);
  res.render("reports/extensions-admin", { classes, staffRoles, miscLocations, branches });
});

router.post("/extensions-admin", (req, res) => {
  const { new_misc_name, new_misc_branch, new_misc_extension } = req.body;
  db.exec("BEGIN TRANSACTION");
  try {
    Object.keys(req.body).forEach((key) => {
      let match = key.match(/^class_ext_(\d+)$/);
      if (match) {
        db.prepare("UPDATE classes SET extension = ? WHERE id = ?").run((req.body[key] || "").trim() || null, match[1]);
        return;
      }
      match = key.match(/^staff_ext_(\d+)$/);
      if (match) {
        db.prepare("UPDATE staff_roles SET extension = ? WHERE id = ?").run((req.body[key] || "").trim() || null, match[1]);
        return;
      }
      match = key.match(/^misc_ext_(\d+)$/);
      if (match) {
        db.prepare("UPDATE misc_extensions SET extension = ? WHERE id = ?").run((req.body[key] || "").trim() || null, match[1]);
      }
    });
    if (new_misc_name && new_misc_name.trim()) {
      db.prepare("INSERT INTO misc_extensions (name, branch, extension) VALUES (?, ?, ?)").run(
        new_misc_name.trim(), new_misc_branch || null, (new_misc_extension || "").trim() || null
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  res.redirect("/reports/extensions-admin?saved=1");
});

router.delete("/extensions-admin/misc/:id", (req, res) => {
  db.prepare("DELETE FROM misc_extensions WHERE id = ?").run(req.params.id);
  res.redirect("/reports/extensions-admin");
});

router.get("/extensions", (req, res) => {
  const classRows = db.prepare(`
    SELECT c.id, c.name, c.parallel, c.branch, c.extension,
      MAX(CASE WHEN tc.role = 'בוקר' THEN t.first_name || ' ' || t.last_name END) AS morning_name,
      MAX(CASE WHEN tc.role = 'אחה"צ' THEN t.first_name || ' ' || t.last_name END) AS afternoon_name
    FROM classes c
    LEFT JOIN teacher_classes tc ON tc.class_id = c.id AND tc.role IN ('בוקר', 'אחה"צ')
    LEFT JOIN teachers t ON tc.teacher_id = t.id AND t.status = 'פעיל'
    WHERE c.status = 'פעיל' AND COALESCE(c.class_kind,'regular') <> 'waiting'
    GROUP BY c.id
    ORDER BY c.branch, c.grade_order, c.name, c.parallel
  `).all();
  const classItems = classRows.map((r) => ({
    kind: "class", className: r.name + (r.parallel ? " " + r.parallel : ""),
    sortName: r.name, sortParallel: r.parallel || "",
    morningTeacher: r.morning_name ? `הרב ${r.morning_name}` : "",
    afternoonTeacher: r.afternoon_name ? `הרב ${r.afternoon_name}` : "",
    branch: r.branch || "", extension: r.extension || "",
  }));

  // תפקידי צוות שאינם קשורים לכיתה (מזכירים, מורות שילוב וכו') - להם
  // מוגדרת שלוחה ישירות על התפקיד עצמו, לא דרך כיתה
  const staffRows = db.prepare(`
    SELECT sr.name AS role_name, sr.branch, sr.extension, t.first_name, t.last_name
    FROM staff_role_assignments sra
    JOIN staff_roles sr ON sra.staff_role_id = sr.id
    JOIN teachers t ON sra.teacher_id = t.id
    WHERE t.status = 'פעיל' AND sr.extension IS NOT NULL AND sr.extension != ''
    ORDER BY sr.branch IS NOT NULL, sr.branch, sr.grade_order, sr.name
  `).all();
  // תואר מתאים - "הגב'" לתפקידים נשיים ידועים (מורות/רכזת שילוב), "הרב"
  // לשאר (מנהל, מזכיר וכו')
  function staffTitlePrefix(roleName) {
    if (roleName.includes("מורת שילוב") || roleName.includes("מורות שילוב") || roleName.includes("רכזת שילוב")) {
      return "הגב'";
    }
    return "הרב";
  }
  const staffItems = staffRows.map((r) => ({
    kind: "staff", className: r.role_name,
    morningTeacher: `${staffTitlePrefix(r.role_name)} ${r.first_name || ""} ${r.last_name || ""}`.trim(), afternoonTeacher: "",
    branch: r.branch || "", extension: r.extension || "",
  }));

  // מיקומים כלליים שלא קשורים למלמד/תפקיד ספציפי (כמו "חדר מלמדים" בכל סניף)
  const miscRows = db.prepare(`
    SELECT name, branch, extension FROM misc_extensions
    WHERE extension IS NOT NULL AND extension != ''
    ORDER BY branch IS NOT NULL, branch, grade_order, name
  `).all();
  const miscItems = miscRows.map((r) => ({
    kind: "misc", className: r.name,
    morningTeacher: "", afternoonTeacher: "",
    branch: r.branch || "", extension: r.extension || "",
  }));

  // סדר מיון מותאם אישית - לא אלפביתי:
  // מנהל -> מזכירים -> רכזת שילוב -> מורות שילוב -> (לכל סניף לפי הסדר
  // סוקולוב/נפחא/בן פתחיה: כיתות לפי סדר עולה -> חדר מלמדים -> גג)
  const STAFF_ORDER = ["מנהל", "מזכיר", "רכזת שילוב", "מורת שילוב", "מורות שילוב"];
  const BRANCH_ORDER = ["סוקולוב", "נפחא", "בן פתחיה"];

  function staffRank(name) {
    for (let i = 0; i < STAFF_ORDER.length; i++) {
      if (name.includes(STAFF_ORDER[i])) return i;
    }
    return STAFF_ORDER.length; // תפקיד לא מזוהה - אחרי הכל, לפני הכיתות
  }

  // סדר כיתות: מכינה א' -> מכינה ב' -> כיתה א' -> ... -> כיתה ח' - לא
  // אלפביתי (כי אלפביתית "מכינה" הייתה מגיעה אחרי "כיתה", לא לפני)
  const CLASS_NAME_ORDER = [
    "מכינה א", "מכינה ב",
    "כיתה א", "כיתה ב", "כיתה ג", "כיתה ד", "כיתה ה", "כיתה ו", "כיתה ז", "כיתה ח",
  ];
  function classNameRank(name) {
    for (let i = 0; i < CLASS_NAME_ORDER.length; i++) {
      if (name.startsWith(CLASS_NAME_ORDER[i])) return i;
    }
    return CLASS_NAME_ORDER.length; // שם לא מזוהה - בסוף הרשימה
  }

  const allItems = [...staffItems, ...classItems, ...miscItems];
  allItems.sort((a, b) => {
    // קבוצה 0: תפקידי צוות (מנהל/מזכירים/שילוב) - תמיד ראשונים
    if (a.kind === "staff" && b.kind !== "staff") return -1;
    if (a.kind !== "staff" && b.kind === "staff") return 1;
    if (a.kind === "staff" && b.kind === "staff") {
      return staffRank(a.className) - staffRank(b.className);
    }
    // שאר הפריטים (כיתות + מיקומים) - מקובצים לפי סניף, בסדר שהוגדר
    const aBranchIdx = BRANCH_ORDER.indexOf(a.branch);
    const bBranchIdx = BRANCH_ORDER.indexOf(b.branch);
    const aRank = aBranchIdx === -1 ? BRANCH_ORDER.length : aBranchIdx;
    const bRank = bBranchIdx === -1 ? BRANCH_ORDER.length : bBranchIdx;
    if (aRank !== bRank) return aRank - bRank;
    // אותו סניף: כיתות (לפי סדר עולה) לפני מיקומים; בין המיקומים, "חדר
    // מלמדים" לפני "גג"
    const kindRank = (item) => {
      if (item.kind === "class") return 0;
      if (item.className.includes("חדר מלמדים")) return 1;
      if (item.className.includes("גג")) return 2;
      return 3;
    };
    const aKindRank = kindRank(a);
    const bKindRank = kindRank(b);
    if (aKindRank !== bKindRank) return aKindRank - bKindRank;
    if (a.kind === "class" && b.kind === "class") {
      const aRank = classNameRank(a.sortName);
      const bRank = classNameRank(b.sortName);
      if (aRank !== bRank) return aRank - bRank;
      if (a.sortName !== b.sortName) return a.sortName < b.sortName ? -1 : 1;
      return a.sortParallel < b.sortParallel ? -1 : a.sortParallel > b.sortParallel ? 1 : 0;
    }
    return a.className < b.className ? -1 : a.className > b.className ? 1 : 0;
  });

  // תוויות מדור - כדי להציג כותרת קבוצה (סניף / צוות) בטבלה, במקום עמודת
  // "סניף" נפרדת שהפכה מיותרת כשממילא ממוינים ומקובצים לפי סניף
  let lastSection = null;
  allItems.forEach((item) => {
    let section;
    if (item.kind === "staff") section = "הנהלה ומזכירות";
    else section = item.branch || "אחר";
    item.sectionStart = section !== lastSection;
    item.sectionLabel = section;
    lastSection = section;
  });

  // גודל פונט דינמי לפי כמות השורות הכוללת - כדי שהדוח *תמיד* ייכנס בדף
  // אחד, לא משנה כמה כיתות/תפקידים/מיקומים יש (בדיוק כמו שעשינו ביומן כיתה)
  const AVAILABLE_HEIGHT_MM = 260; // גובה A4 פחות שוליים וכותרת
  const sectionCount = allItems.filter((it) => it.sectionStart).length;
  const rowsForCalc = allItems.length + sectionCount + 1; // +שורות כותרת מדור +כותרת טבלה
  let rowHeightMM = Math.min(AVAILABLE_HEIGHT_MM / rowsForCalc, 15);
  rowHeightMM = Math.max(rowHeightMM, 4);
  const extFontPt = Math.max(8, Math.min(20, Math.round(rowHeightMM * 1.7)));
  const bodyFontPt = Math.max(7.5, Math.min(18, Math.round(rowHeightMM * 1.5)));

  res.render("reports/extensions", { items: allItems, rowHeightMM, extFontPt, bodyFontPt });
});

// ============ ניהול מיקומים נוספים (חדר מלמדים וכד') - לא קשורים למלמד ============
router.get("/misc-extensions", (req, res) => {
  const locations = db.prepare("SELECT * FROM misc_extensions ORDER BY branch IS NOT NULL, branch, grade_order, name").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL AND branch != '' ORDER BY branch").all().map((r) => r.branch);
  res.render("reports/misc-extensions", { locations, branches });
});

router.post("/misc-extensions", (req, res) => {
  const { new_name, new_branch, new_extension } = req.body;
  db.exec("BEGIN TRANSACTION");
  try {
    // עדכון קיימים
    Object.keys(req.body).forEach((key) => {
      const match = key.match(/^ext_(\d+)$/);
      if (match) {
        const id = match[1];
        const value = (req.body[key] || "").trim() || null;
        db.prepare("UPDATE misc_extensions SET extension = ? WHERE id = ?").run(value, id);
      }
    });
    // הוספת מיקום חדש, אם מולא שם
    if (new_name && new_name.trim()) {
      db.prepare("INSERT INTO misc_extensions (name, branch, extension) VALUES (?, ?, ?)").run(
        new_name.trim(), new_branch || null, (new_extension || "").trim() || null
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  res.redirect("/reports/misc-extensions?saved=1");
});

router.delete("/misc-extensions/:id", (req, res) => {
  db.prepare("DELETE FROM misc_extensions WHERE id = ?").run(req.params.id);
  res.redirect("/reports/misc-extensions");
});

router.get("/class-directory", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY grade_order, name, parallel").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  res.render("reports/class-directory", { classes, branches });
});

router.get("/class-directory/view", (req, res) => {
  const { class_id } = req.query;
  if (!class_id) return res.redirect("/reports/class-directory");
  const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(class_id);
  const classFullName = classRow ? classRow.name + (classRow.parallel ? " " + classRow.parallel : "") : "";

  // מלמד בוקר - לכותרת (שם + נייד)
  const morningTeacher = db.prepare(`
    SELECT t.first_name, t.last_name, t.mobile FROM teacher_classes tc
    JOIN teachers t ON tc.teacher_id = t.id
    WHERE tc.class_id = ? AND tc.role = 'בוקר'
    ORDER BY (t.mobile IS NOT NULL AND t.mobile != '') DESC, tc.id DESC
    LIMIT 1
  `).get(class_id);
  const teacherNamePart = morningTeacher ? `הרב ${morningTeacher.first_name || ""} ${morningTeacher.last_name || ""}`.trim() : "";
  const teacherMobile = morningTeacher ? morningTeacher.mobile || "" : "";

  // טלפון בבית - אם ריק, נופלים לנייד האם (לא האב)
  const students = db.prepare(`
    SELECT s.first_name, f.last_name AS family_last, f.street, f.house_number,
           COALESCE(NULLIF(f.home_phone, ''), f.mother_mobile) AS phone
    FROM students s
    LEFT JOIN families f ON s.family_id = f.id
    WHERE s.class_id = ? AND s.status = 'פעיל'
    ORDER BY f.last_name, s.first_name
  `).all(class_id);

  res.render("reports/class-directory-print", { classFullName, teacherNamePart, teacherMobile, students });
});

router.get("/single-page", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY grade_order, name, parallel").all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  const teacherAssignments = db.prepare(`
    SELECT tc.class_id, t.id AS teacher_id, t.first_name, t.last_name, tc.role
    FROM teacher_classes tc JOIN teachers t ON tc.teacher_id = t.id
    WHERE t.status = 'פעיל'
  `).all();
  res.render("reports/single-page", { classes, branches, teacherAssignments });
});

// ============ הסדר השארה - מילוי דרך המערכת ============
const STAY_ARRANGEMENT_CLASS_NAMES = ["מכינה א'", "מכינה ב'", "כיתה א'"];

// ============ הסדר השארה - דוח לשומר (רשימה מרוכזת לפי סניף, בלי סכומים) ============
router.get("/stay-arrangement/guard", (req, res) => {
  res.render("reports/stay-arrangement-guard-select");
});

router.get("/stay-arrangement/guard/view", (req, res) => {
  const { branch } = req.query;
  if (!branch) return res.redirect("/reports/stay-arrangement/guard");
  const students = db.prepare(`
    SELECT s.first_name, s.nickname, c.name AS class_name, c.parallel,
      f.last_name AS family_last_name, f.home_phone, f.father_mobile, f.mother_mobile,
      f.street, f.house_number, f.apartment, f.city,
      sa.passover_interested, sa.summer_interested
    FROM students s
    JOIN classes c ON s.class_id = c.id
    LEFT JOIN families f ON s.family_id = f.id
    JOIN stay_arrangements sa ON sa.student_id = s.id
    WHERE s.status = 'פעיל' AND c.branch = ?
      AND c.name IN (${STAY_ARRANGEMENT_CLASS_NAMES.map(() => "?").join(",")})
      AND (sa.passover_interested = 'כן' OR sa.summer_interested = 'כן')
    ORDER BY c.grade_order, c.name, c.parallel, f.last_name, s.first_name
  `).all(branch, ...STAY_ARRANGEMENT_CLASS_NAMES).map((s) => ({
    ...s,
    className: s.class_name + (s.parallel ? " " + s.parallel : ""),
    address: [s.street, s.house_number, s.apartment ? "דירה " + s.apartment : "", s.city].filter(Boolean).join(" "),
    arrangements: [s.passover_interested === "כן" ? "פסח" : "", s.summer_interested === "כן" ? "קיץ" : ""].filter(Boolean).join(" + "),
  }));

  const AVAILABLE_HEIGHT_MM = 260;
  const rowsForCalc = students.length + 1;
  let rowHeightMM = Math.min(AVAILABLE_HEIGHT_MM / rowsForCalc, 12);
  rowHeightMM = Math.max(rowHeightMM, 3.5);
  const bodyFontPt = Math.max(7, Math.min(16, Math.round(rowHeightMM * 1.3)));

  res.render("reports/stay-arrangement-guard", { branch, students, rowHeightMM, bodyFontPt });
});

router.get("/stay-arrangement/edit", (req, res) => {
  const classes = db.prepare(`
    SELECT id, name, parallel, branch FROM classes
    WHERE status = 'פעיל' AND name IN (${STAY_ARRANGEMENT_CLASS_NAMES.map(() => "?").join(",")})
    ORDER BY grade_order, name, parallel
  `).all(...STAY_ARRANGEMENT_CLASS_NAMES);
  res.render("reports/stay-arrangement-edit-select", { classes });
});

router.get("/stay-arrangement/edit/:classId", (req, res) => {
  const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(req.params.classId);
  const students = db.prepare(`
    SELECT s.id, s.first_name, s.nickname, f.last_name AS family_last_name,
      sa.passover_interested, sa.passover_amount, sa.summer_interested, sa.summer_amount
    FROM students s
    LEFT JOIN families f ON s.family_id = f.id
    LEFT JOIN stay_arrangements sa ON sa.student_id = s.id
    WHERE s.class_id = ? AND s.status = 'פעיל'
    ORDER BY f.last_name, s.first_name
  `).all(req.params.classId);
  res.render("reports/stay-arrangement-edit", { classRow, students, saved: req.query.saved === "1" });
});

router.post("/stay-arrangement/edit/:classId", (req, res) => {
  const { student_id, passover_interested, passover_amount, summer_interested, summer_amount } = req.body;
  const ids = Array.isArray(student_id) ? student_id : [student_id];
  const toArr = (v) => (Array.isArray(v) ? v : [v]);
  const pInterested = toArr(passover_interested);
  const pAmount = toArr(passover_amount);
  const sInterested = toArr(summer_interested);
  const sAmount = toArr(summer_amount);

  const upsert = db.prepare(`
    INSERT INTO stay_arrangements (student_id, passover_interested, passover_amount, summer_interested, summer_amount, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id) DO UPDATE SET
      passover_interested = excluded.passover_interested,
      passover_amount = excluded.passover_amount,
      summer_interested = excluded.summer_interested,
      summer_amount = excluded.summer_amount,
      updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();
  ids.forEach((id, i) => {
    if (!id) return;
    upsert.run(
      id,
      pInterested[i] || null,
      pAmount[i] !== "" && pAmount[i] != null ? parseFloat(pAmount[i]) : null,
      sInterested[i] || null,
      sAmount[i] !== "" && sAmount[i] != null ? parseFloat(sAmount[i]) : null,
      now
    );
  });
  res.redirect(`/reports/stay-arrangement/edit/${req.params.classId}?saved=1`);
});

router.get("/single-page/view", (req, res) => {
  const { class_id, teacher_id, page } = req.query;
  if (!class_id) return res.redirect("/reports/single-page");

  if (page === "stay_arrangement") {
    const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(class_id);
    const students = db.prepare(`
      SELECT s.first_name, s.nickname,
        f.last_name AS family_last_name, f.home_phone, f.father_mobile, f.mother_mobile,
        f.street, f.house_number, f.apartment, f.city,
        sa.passover_interested, sa.passover_amount, sa.summer_interested, sa.summer_amount
      FROM students s
      LEFT JOIN families f ON s.family_id = f.id
      LEFT JOIN stay_arrangements sa ON sa.student_id = s.id
      WHERE s.class_id = ? AND s.status = 'פעיל'
      ORDER BY f.last_name, s.first_name
    `).all(class_id).map((s) => ({
      ...s,
      address: [s.street, s.house_number, s.apartment ? "דירה " + s.apartment : "", s.city].filter(Boolean).join(" "),
    }));
    // A4 לרוחב (לא לאורך!) - הגובה הזמין הרבה יותר קטן מעמוד רגיל (210
    // מ"מ גובה העמוד, פחות שוליים וכותרת), לכן חייבים קבוע נפרד כאן -
    // זו הייתה הסיבה שהדוח גלש לעמוד שני
    const AVAILABLE_HEIGHT_MM = 175;
    const rowsForCalc = students.length + 1;
    let rowHeightMM = Math.min(AVAILABLE_HEIGHT_MM / rowsForCalc, 14);
    rowHeightMM = Math.max(rowHeightMM, 3.5);
    const bodyFontPt = Math.max(6.5, Math.min(20, Math.round(rowHeightMM * 1.6)));
    return res.render("reports/stay-arrangement", { classRow, students, rowHeightMM, bodyFontPt });
  }

  const pages = [page || "7col"];
  const classRow = db.prepare("SELECT * FROM classes WHERE id = ?").get(class_id);
  const students = db
    .prepare("SELECT s.first_name, s.nickname, s.last_name, f.last_name AS family_last FROM students s LEFT JOIN families f ON s.family_id=f.id WHERE s.class_id = ? AND s.status = 'פעיל' ORDER BY s.last_name, s.first_name")
    .all(class_id)
    .map(s => ({ ...s, displayName: (s.last_name || s.family_last || "") + " " + (s.nickname || s.first_name || "") }));
  const teacher = teacher_id
    ? db.prepare("SELECT t.first_name, t.last_name, tc.role FROM teachers t LEFT JOIN teacher_classes tc ON tc.teacher_id = t.id AND tc.class_id = ? WHERE t.id = ?").get(class_id, teacher_id)
    : db.prepare("SELECT t.first_name, t.last_name, tc.role FROM teacher_classes tc JOIN teachers t ON tc.teacher_id=t.id WHERE tc.class_id=? ORDER BY tc.id LIMIT 1").get(class_id);
  const teacherName = teacher ? `הרב ${teacher.first_name || ""} ${teacher.last_name || ""}`.trim() : "";
  const teacherRole = teacher ? teacher.role || "" : "";
  res.render("reports/class-journal-print", { classRow, students, teacherName, teacherRole, pages, skipCover: true });
});

// ============ הצהרת בריאות ============
router.get("/health-declaration", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY grade_order, name, parallel").all();
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
  sql += " ORDER BY c.grade_order, c.name, c.parallel, s.last_name, s.first_name";

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

// ============ כמות שולחנות וכסאות בכיתה - לפי סניפים ============
router.get("/furniture-count", (req, res) => {
  const { GRADE_ORDER } = require("../yearManager");
  const rows = db.prepare(`
    SELECT c.id, c.name, c.parallel, c.branch, c.room_description, COUNT(s.id) AS student_count
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id AND s.status = 'פעיל'
    WHERE c.status = 'פעיל' AND COALESCE(c.class_kind,'regular') <> 'waiting'
    GROUP BY c.id
    ORDER BY c.branch
  `).all().map((c) => ({
    ...c,
    chairs: c.student_count,
    tables: Math.ceil(c.student_count / 2),
  }));

  // מיון לפי גיל התלמידים (מכינה א' -> מכינה ב' -> כיתה א' -> ... -> כיתה
  // ח'), ואז לפי מספר הכיתה - לא אלפביתי
  rows.sort((a, b) => {
    const gradeA = GRADE_ORDER.indexOf(a.name), gradeB = GRADE_ORDER.indexOf(b.name);
    if (gradeA !== gradeB) return (gradeA === -1 ? 999 : gradeA) - (gradeB === -1 ? 999 : gradeB);
    return (parseInt(a.parallel, 10) || 0) - (parseInt(b.parallel, 10) || 0);
  });

  const grouped = {};
  rows.forEach((r) => {
    const key = r.branch || "ללא סניף";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  });

  const grandChairs = rows.reduce((sum, r) => sum + r.chairs, 0);
  const grandTables = rows.reduce((sum, r) => sum + r.tables, 0);

  res.render("reports/furniture-count", {
    grouped, grandChairs, grandTables, todayHebrewStr: hd.serialToHebrewString(hd.todayAccessSerial()),
  });
});

// ============ כמויות צילומים - לפי סניפים ושנת לימודים, עם תוספת ידנית ============
router.get("/photocopies", (req, res) => {
  const { GRADE_ORDER } = require("../yearManager");
  const { getCurrentYear } = require("../yearManager");
  const schoolYear = getCurrentYear();

  const rows = db.prepare(`
    SELECT c.id, c.name, c.parallel, c.branch, COUNT(s.id) AS student_count,
      pe.extra AS manual_extra
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id AND s.status = 'פעיל'
    LEFT JOIN photocopy_extras pe ON pe.class_id = c.id AND pe.school_year = ?
    WHERE c.status = 'פעיל' AND COALESCE(c.class_kind,'regular') <> 'waiting'
    GROUP BY c.id
    ORDER BY c.branch
  `).all(schoolYear).map((c) => {
    const extra = c.manual_extra || 0;
    const copies = c.student_count + extra;
    let page2 = Math.ceil(copies / 2);
    if (page2 % 2 !== 0) page2 += 1;
    return { ...c, extra, copies, page2 };
  });

  rows.sort((a, b) => {
    const gradeA = GRADE_ORDER.indexOf(a.name), gradeB = GRADE_ORDER.indexOf(b.name);
    if (gradeA !== gradeB) return (gradeA === -1 ? 999 : gradeA) - (gradeB === -1 ? 999 : gradeB);
    return (parseInt(a.parallel, 10) || 0) - (parseInt(b.parallel, 10) || 0);
  });

  const grouped = {};
  rows.forEach((r) => {
    const key = r.branch || "ללא סניף";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  });

  res.render("reports/photocopies", { grouped, schoolYear, saved: req.query.saved === "1" });
});

router.post("/photocopies/save", (req, res) => {
  const { getCurrentYear } = require("../yearManager");
  const schoolYear = getCurrentYear();
  const upsert = db.prepare(`
    INSERT INTO photocopy_extras (class_id, school_year, extra, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(class_id, school_year) DO UPDATE SET extra = excluded.extra, updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();
  Object.keys(req.body).forEach((key) => {
    const match = key.match(/^extra_(\d+)$/);
    if (match) {
      const val = parseInt(req.body[key], 10);
      upsert.run(match[1], schoolYear, isNaN(val) ? 0 : val, now);
    }
  });
  res.redirect("/reports/photocopies?saved=1");
});

router.get("/photocopies/export", async (req, res) => {
  const { GRADE_ORDER, getCurrentYear } = require("../yearManager");
  const schoolYear = getCurrentYear();

  const rows = db.prepare(`
    SELECT c.id, c.name, c.parallel, c.branch, COUNT(s.id) AS student_count,
      pe.extra AS manual_extra
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id AND s.status = 'פעיל'
    LEFT JOIN photocopy_extras pe ON pe.class_id = c.id AND pe.school_year = ?
    WHERE c.status = 'פעיל' AND COALESCE(c.class_kind,'regular') <> 'waiting'
    GROUP BY c.id
    ORDER BY c.branch
  `).all(schoolYear).map((c) => {
    const extra = c.manual_extra || 0;
    const copies = c.student_count + extra;
    let page2 = Math.ceil(copies / 2);
    if (page2 % 2 !== 0) page2 += 1;
    return { ...c, extra, copies, page2 };
  });

  rows.sort((a, b) => {
    const gradeA = GRADE_ORDER.indexOf(a.name), gradeB = GRADE_ORDER.indexOf(b.name);
    if (gradeA !== gradeB) return (gradeA === -1 ? 999 : gradeA) - (gradeB === -1 ? 999 : gradeB);
    return (parseInt(a.parallel, 10) || 0) - (parseInt(b.parallel, 10) || 0);
  });

  const grouped = {};
  rows.forEach((r) => {
    const key = r.branch || "ללא סניף";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(r);
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "מערכת ניהול תלמוד תורה החדש";

  Object.keys(grouped).forEach((branch) => {
    const ws = wb.addWorksheet(branch, { views: [{ rightToLeft: true }] });
    const classRows = grouped[branch];

    // כותרת עליונה צהובה
    ws.mergeCells(1, 1, 1, 4);
    const titleCell = ws.getCell(1, 1);
    titleCell.value = `שנת לימודים ${schoolYear} (${branch})`;
    titleCell.font = { size: 13, bold: true };
    titleCell.alignment = { horizontal: "center", vertical: "middle", readingOrder: "rtl" };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF200" } };
    ws.getRow(1).height = 24;

    const THIN_BORDER = { style: "thin", color: { argb: "FF000000" } };
    const ALL_BORDERS = { top: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER };

    // כותרות עמודות - סדר לוגי A->D: כיתה, מס' הילדים, מס' הצילומים, 2
    // בעמוד (בגיליון RTL עמודה A עדיין מוצגת מימין, כך שהסדר הוויזואלי
    // נשאר נכון מימין לשמאל)
    const headerRow = ws.getRow(2);
    ["הכיתה", "מס' הילדים", "מס' הצילומים", "2 בעמוד"].forEach((h, i) => {
      const cell = headerRow.getCell(i + 1);
      cell.value = h;
      cell.font = { bold: true };
      cell.alignment = { horizontal: "center", readingOrder: "rtl" };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
      cell.border = ALL_BORDERS;
    });
    headerRow.height = 20;

    let rowIdx = 3;
    let totalCopies = 0;
    classRows.forEach((c, i) => {
      const row = ws.getRow(rowIdx);
      row.getCell(1).value = c.name + (c.parallel ? " " + c.parallel : "");
      row.getCell(2).value = c.student_count;
      row.getCell(3).value = c.copies;
      row.getCell(4).value = c.page2;
      [1, 2, 3, 4].forEach((col) => {
        row.getCell(col).alignment = { horizontal: "center", readingOrder: "rtl" };
        row.getCell(col).border = ALL_BORDERS;
        if (i % 2 === 0) row.getCell(col).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
      });
      totalCopies += c.copies;
      rowIdx++;
    });

    // שורת סיכום
    ws.mergeCells(rowIdx, 1, rowIdx, 2);
    const sumLabelCell = ws.getCell(rowIdx, 1);
    sumLabelCell.value = "צילומים";
    sumLabelCell.font = { bold: true };
    sumLabelCell.alignment = { horizontal: "center", readingOrder: "rtl" };
    sumLabelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF200" } };
    sumLabelCell.border = ALL_BORDERS;
    const sumValCell = ws.getCell(rowIdx, 3);
    sumValCell.value = totalCopies;
    sumValCell.font = { bold: true };
    sumValCell.alignment = { horizontal: "center", readingOrder: "rtl" };
    sumValCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF200" } };
    sumValCell.border = ALL_BORDERS;
    const sumLeftoverCell = ws.getCell(rowIdx, 4);
    sumLeftoverCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF200" } };
    sumLeftoverCell.border = ALL_BORDERS;

    ws.getColumn(1).width = 16;
    ws.getColumn(2).width = 16;
    ws.getColumn(3).width = 16;
    ws.getColumn(4).width = 16;
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="photocopies.xlsx"; filename*=UTF-8''${encodeURIComponent("כמויות-צילומים.xlsx")}`);
  await wb.xlsx.write(res);
  res.end();
});


router.get("/gan-export", async (req, res) => {
  const classes = db.prepare(`
    SELECT id, name, parallel, institution_code FROM classes
    WHERE (name = 'מכינה א''' OR name = 'מכינה ב''') AND status = 'פעיל'
    ORDER BY grade_order, name, parallel
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
    headers = ["שם משפחה", "שם פרטי", "שם חיבה", "כיתה", "סטטוס", "טלפון בית", "נייד אב", "נייד אם", "כתובת"];
    let sql = `SELECT s.last_name, s.first_name, s.nickname, c.name||' '||COALESCE(c.parallel,'') AS cls,
      s.status, f.home_phone, f.father_mobile, f.mother_mobile, f.street||' '||COALESCE(f.house_number,'')||' '||COALESCE(f.city,'') AS addr
      FROM students s LEFT JOIN classes c ON s.class_id=c.id LEFT JOIN families f ON s.family_id=f.id WHERE 1=1`;
    const params = [];
    if (status) { sql += " AND s.status=?"; params.push(status); }
    if (classIds.length > 0) { sql += ` AND s.class_id IN (${classIds.map(()=>"?").join(",")})`; params.push(...classIds); }
    sql += " ORDER BY c.grade_order, c.name, c.parallel, s.last_name, s.first_name";
    rows = db.prepare(sql).all(...params).map(r => [r.last_name, r.first_name, r.nickname, r.cls, r.status, r.home_phone, r.father_mobile, r.mother_mobile, r.addr]);

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
