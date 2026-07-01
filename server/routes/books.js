const express = require("express");
const router = express.Router();
const db = require("../db");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const LOGO_PATH = path.join(__dirname, "..", "public", "images", "logo-reports.jpg");

// ============ דף ראשי ============
router.get("/", (req, res) => {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;

  const classes = db.prepare(
    "SELECT DISTINCT class_name FROM book_catalog WHERE year_label=? ORDER BY class_name"
  ).all(year).map(r => r.class_name);

  // סטטיסטיקה
  const stats = {};
  for (const cls of classes) {
    const students = db.prepare(`
      SELECT COUNT(DISTINCT s.id) c FROM students s
      JOIN classes c ON s.class_id = c.id
      WHERE c.name = ? AND s.status = 'פעיל'
    `).get(cls);
    const ordered = db.prepare(`
      SELECT COUNT(DISTINCT bo.student_id) c FROM book_orders bo
      JOIN students s ON bo.student_id = s.id
      JOIN classes c ON s.class_id = c.id
      WHERE bo.year_label=? AND c.name=?
    `).get(year, cls);
    stats[cls] = { students: students?.c || 0, ordered: ordered?.c || 0 };
  }

  res.render("books/index", { year, years, classes, stats });
});

// ============ רשימת תלמידים לכיתה + סימון הזמנות ============
router.get("/class", (req, res) => {
  const { year, class_name } = req.query;
  if (!year || !class_name) return res.redirect("/books");

  const catalog = db.prepare(
    "SELECT * FROM book_catalog WHERE year_label=? AND class_name=? ORDER BY sort_order, id"
  ).all(year, class_name);

  // שליפת כל הכיתות עם השם הזה (כולל מקבילות)
  const classes = db.prepare(
    "SELECT id, name, parallel FROM classes WHERE name=? ORDER BY parallel"
  ).all(class_name);

  const students = [];
  for (const cls of classes) {
    const clsStudents = db.prepare(`
      SELECT s.id, s.first_name, s.last_name, f.last_name AS family_last, '${cls.parallel || ""}' AS parallel
      FROM students s
      LEFT JOIN families f ON s.family_id = f.id
      WHERE s.class_id = ? AND s.status = 'פעיל'
      ORDER BY s.last_name, s.first_name
    `).all(cls.id);
    students.push(...clsStudents);
  }

  // שליפת הזמנות קיימות
  const ordersMap = {};
  const orders = db.prepare(`
    SELECT bo.student_id, bo.catalog_id FROM book_orders bo WHERE bo.year_label=?
  `).all(year);
  for (const o of orders) {
    if (!ordersMap[o.student_id]) ordersMap[o.student_id] = new Set();
    ordersMap[o.student_id].add(o.catalog_id);
  }

  res.render("books/class-orders", { year, class_name, catalog, students, ordersMap });
});

// ============ שמירת הזמנות לכיתה (batch save) ============
router.post("/class/save", (req, res) => {
  const { year, class_name, orders } = req.body;
  if (!year || !class_name) return res.redirect("/books");

  // קבל את רשימת התלמידים בכיתה
  const classes = db.prepare("SELECT id FROM classes WHERE name=?").all(class_name);
  const studentIds = [];
  for (const cls of classes) {
    const ids = db.prepare("SELECT id FROM students WHERE class_id=? AND status='פעיל'").all(cls.id);
    studentIds.push(...ids.map(s => s.id));
  }

  const catalog = db.prepare("SELECT id FROM book_catalog WHERE year_label=? AND class_name=?").all(year, class_name);
  const catalogIds = catalog.map(c => c.id);

  // מחיקת הזמנות קיימות לתלמידים אלו ולשנה זו
  for (const sid of studentIds) {
    for (const cid of catalogIds) {
      db.prepare("DELETE FROM book_orders WHERE year_label=? AND student_id=? AND catalog_id=?").run(year, sid, cid);
    }
  }

  // הכנסת ההזמנות החדשות
  const now = new Date().toISOString();
  const ordersData = orders ? (Array.isArray(orders) ? orders : [orders]) : [];
  for (const key of ordersData) {
    const [sid, cid] = key.split("_").map(Number);
    if (studentIds.includes(sid) && catalogIds.includes(cid)) {
      db.prepare(
        "INSERT OR REPLACE INTO book_orders (year_label, student_id, catalog_id, ordered, created_at) VALUES (?,?,?,1,?)"
      ).run(year, sid, cid, now);
    }
  }

  res.redirect(`/books/class?year=${encodeURIComponent(year)}&class_name=${encodeURIComponent(class_name)}&saved=1`);
});

// ============ דוח לפי כיתה לאקסל ============
router.get("/report/class", async (req, res) => {
  const { year, class_name } = req.query;
  if (!year || !class_name) return res.redirect("/books");

  const catalog = db.prepare(
    "SELECT * FROM book_catalog WHERE year_label=? AND class_name=? ORDER BY sort_order, id"
  ).all(year, class_name);

  const classes = db.prepare("SELECT id, parallel FROM classes WHERE name=?").all(class_name);
  const students = [];
  for (const cls of classes) {
    const ss = db.prepare(`
      SELECT s.id, s.first_name, s.last_name, f.last_name AS family_last
      FROM students s LEFT JOIN families f ON s.family_id=f.id
      WHERE s.class_id=? AND s.status='פעיל' ORDER BY s.last_name, s.first_name
    `).all(cls.id);
    students.push(...ss);
  }

  const orders = db.prepare(`
    SELECT student_id, catalog_id FROM book_orders WHERE year_label=?
  `).all(year);
  const ordersSet = new Set(orders.map(o => `${o.student_id}_${o.catalog_id}`));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`${class_name} ${year}`, { views: [{ rightToLeft: true }] });

  // כותרת
  ws.mergeCells(1, 1, 1, catalog.length + 3);
  const t1 = ws.getCell(1, 1);
  t1.value = "תלמוד תורה החדש";
  t1.font = { size: 14, bold: true, color: { argb: "FF2C5F7C" } };
  t1.alignment = { horizontal: "right" };
  ws.getRow(1).height = 22;

  ws.mergeCells(2, 1, 2, catalog.length + 3);
  ws.getCell(2, 1).value = `הזמנת ספרים ${year} — ${class_name}`;
  ws.getCell(2, 1).font = { size: 12, bold: true };
  ws.getCell(2, 1).alignment = { horizontal: "right" };

  ws.addRow([]);

  // כותרת עמודות
  const headerRow = ws.addRow(["שם התלמיד", "שם משפחה", ...catalog.map(c => c.item_name), "סה\"כ ₪"]);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C5F7C" } };
    cell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "thin" } };
  });
  headerRow.height = 40;

  // נתוני תלמידים
  let totalAll = 0;
  for (const s of students) {
    const itemOrdered = catalog.map(c => ordersSet.has(`${s.id}_${c.id}`) ? "✓" : "");
    const total = catalog.reduce((sum, c) => sum + (ordersSet.has(`${s.id}_${c.id}`) ? c.price : 0), 0);
    totalAll += total;
    const row = ws.addRow([s.first_name, s.last_name || s.family_last, ...itemOrdered, total > 0 ? total : ""]);
    row.alignment = { horizontal: "right" };
  }

  // שורת סיכום
  const sumRow = ws.addRow(["", "סה\"כ", ...catalog.map(() => ""), totalAll]);
  sumRow.font = { bold: true };

  // רוחב עמודות
  ws.getColumn(1).width = 14;
  ws.getColumn(2).width = 16;
  catalog.forEach((_, i) => { ws.getColumn(i + 3).width = 18; });
  ws.getColumn(catalog.length + 3).width = 12;

  // לוגו
  if (fs.existsSync(LOGO_PATH)) {
    try {
      const imgId = wb.addImage({ filename: LOGO_PATH, extension: "jpeg" });
      ws.addImage(imgId, { tl: { col: catalog.length + 2, row: 0 }, ext: { width: 65, height: 57 } });
    } catch (e) {}
  }

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`ספרים-${class_name}-${year}.xlsx`)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res);
  res.end();
});

// ============ דוח חיובים למשפחות לאקסל ============
router.get("/report/families", async (req, res) => {
  const { year } = req.query;
  if (!year) return res.redirect("/books");

  const families = db.prepare(`
    SELECT DISTINCT f.id, f.last_name, f.father_name, f.home_phone, f.father_mobile
    FROM families f
    JOIN students s ON s.family_id = f.id
    JOIN book_orders bo ON bo.student_id = s.id
    WHERE bo.year_label = ?
    ORDER BY f.last_name
  `).all(year);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("חיובים", { views: [{ rightToLeft: true }] });

  // כותרת
  ws.mergeCells(1, 1, 1, 7);
  ws.getCell(1, 1).value = "תלמוד תורה החדש";
  ws.getCell(1, 1).font = { size: 14, bold: true, color: { argb: "FF2C5F7C" } };
  ws.getCell(1, 1).alignment = { horizontal: "right" };
  ws.getRow(1).height = 22;
  ws.mergeCells(2, 1, 2, 7);
  ws.getCell(2, 1).value = `חיובי הזמנת ספרים ${year}`;
  ws.getCell(2, 1).font = { size: 12, bold: true };
  ws.getCell(2, 1).alignment = { horizontal: "right" };
  ws.addRow([]);

  const headerRow = ws.addRow(["שם משפחה", "שם האב", "טלפון", "ילדים שהזמינו", "פירוט", "סה\"כ ₪", "שולם"]);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C5F7C" } };
    cell.alignment = { horizontal: "right" };
  });

  let grandTotal = 0;
  for (const fam of families) {
    const students = db.prepare(`
      SELECT s.first_name, s.last_name, c.name AS class_name FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      WHERE s.family_id = ?
    `).all(fam.id);

    const items = db.prepare(`
      SELECT bc.item_name, bc.price, s.first_name
      FROM book_orders bo
      JOIN book_catalog bc ON bo.catalog_id = bc.id
      JOIN students s ON bo.student_id = s.id
      WHERE bo.year_label = ? AND s.family_id = ?
      ORDER BY s.first_name, bc.class_name, bc.sort_order
    `).all(year, fam.id);

    const total = items.reduce((sum, i) => sum + i.price, 0);
    grandTotal += total;

    const childrenStr = students.map(s => `${s.first_name} (${s.class_name || ""})`).join(", ");
    const detailStr = items.map(i => `${i.first_name}: ${i.item_name}`).join("\n");

    const row = ws.addRow([fam.last_name, fam.father_name || "", fam.father_mobile || fam.home_phone || "", childrenStr, detailStr, total, ""]);
    row.getCell(5).alignment = { wrapText: true };
    row.height = Math.max(20, items.length * 14);
  }

  ws.addRow(["", "", "", "", "סה\"כ כולל", grandTotal, ""]).font = { bold: true };

  [15, 18, 14, 30, 45, 12, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  if (fs.existsSync(LOGO_PATH)) {
    try {
      const imgId = wb.addImage({ filename: LOGO_PATH, extension: "jpeg" });
      ws.addImage(imgId, { tl: { col: 6, row: 0 }, ext: { width: 65, height: 57 } });
    } catch (e) {}
  }

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`חיובים-ספרים-${year}.xlsx`)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res);
  res.end();
});

// ============ מכתב להורים (הדפסה) ============
router.get("/letter", (req, res) => {
  const { year, class_name, family_id } = req.query;
  if (!year) return res.redirect("/books");

  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || year;

  if (family_id) {
    // מכתב למשפחה ספציפית
    const family = db.prepare("SELECT * FROM families WHERE id=?").get(family_id);
    const students = db.prepare("SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.family_id=? AND s.status='פעיל'").all(family_id);
    const letterData = students.map(s => {
      const catalog = db.prepare("SELECT * FROM book_catalog WHERE year_label=? AND class_name=? ORDER BY sort_order").all(year, s.class_name);
      const orders = db.prepare("SELECT catalog_id FROM book_orders WHERE year_label=? AND student_id=?").all(year, s.id);
      const orderSet = new Set(orders.map(o => o.catalog_id));
      const items = catalog.filter(c => orderSet.has(c.id));
      const total = items.reduce((sum, c) => sum + c.price, 0);
      return { student: s, items, total };
    }).filter(d => d.items.length > 0);
    return res.render("books/letter", { year, family, letterData, class_name: null });
  }

  if (class_name) {
    // מכתבים לכל משפחות הכיתה
    const classes = db.prepare("SELECT id FROM classes WHERE name=?").all(class_name);
    const studentIds = [];
    for (const cls of classes) {
      studentIds.push(...db.prepare("SELECT id FROM students WHERE class_id=? AND status='פעיל'").all(cls.id).map(s => s.id));
    }
    const familyIds = db.prepare(`
      SELECT DISTINCT s.family_id FROM students s
      JOIN book_orders bo ON bo.student_id = s.id
      WHERE bo.year_label=? AND s.family_id IS NOT NULL AND s.id IN (${studentIds.map(() => "?").join(",")})
    `).all(year, ...studentIds).map(r => r.family_id);

    const allLetterData = [];
    for (const fid of familyIds) {
      const family = db.prepare("SELECT * FROM families WHERE id=?").get(fid);
      const students = db.prepare("SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.family_id=? AND s.status='פעיל'").all(fid);
      const letterData = students.map(s => {
        const catalog = db.prepare("SELECT * FROM book_catalog WHERE year_label=? AND class_name=? ORDER BY sort_order").all(year, s.class_name);
        const orders = db.prepare("SELECT catalog_id FROM book_orders WHERE year_label=? AND student_id=?").all(year, s.id);
        const orderSet = new Set(orders.map(o => o.catalog_id));
        const items = catalog.filter(c => orderSet.has(c.id));
        const total = items.reduce((sum, c) => sum + c.price, 0);
        return { student: s, items, total };
      }).filter(d => d.items.length > 0);
      if (letterData.length > 0) allLetterData.push({ family, letterData });
    }
    return res.render("books/letter-all", { year, class_name, allLetterData });
  }

  res.redirect("/books");
});

// ============ ניהול קטלוג ============
router.get("/catalog", (req, res) => {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;
  const catalog = db.prepare("SELECT * FROM book_catalog WHERE year_label=? ORDER BY class_name, sort_order, id").all(year);
  res.render("books/catalog", { year, years, catalog });
});

router.post("/catalog", (req, res) => {
  const { year_label, class_name, item_name, publisher, price, is_mandatory } = req.body;
  db.prepare(
    "INSERT INTO book_catalog (year_label, class_name, item_name, publisher, price, is_mandatory) VALUES (?,?,?,?,?,?)"
  ).run(year_label, class_name, item_name, publisher || "", parseFloat(price) || 0, is_mandatory === "on" ? 1 : 0);
  res.redirect(`/books/catalog?year=${encodeURIComponent(year_label)}`);
});

router.delete("/catalog/:id", (req, res) => {
  const year = db.prepare("SELECT year_label FROM book_catalog WHERE id=?").get(req.params.id)?.year_label;
  db.prepare("DELETE FROM book_catalog WHERE id=?").run(req.params.id);
  res.redirect(`/books/catalog?year=${encodeURIComponent(year || "")}`);
});

module.exports = router;
