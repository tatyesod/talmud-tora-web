const express = require("express");
const router = express.Router();
const db = require("../db");
const { calcAllFamiliesTuition } = require("../tuitionCalc");
const ExcelJS = require("exceljs");
const fs = require("fs");
const hd = require("../hebrewDate");
const path = require("path");

const LOGO_PATH = path.join(__dirname, "..", "public", "images", "logo-reports.jpg");
const LOGO_EXT = "jpeg";

async function sendWorkbook(res, filename, sheetName, reportTitle, headerRow, dataRows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "מערכת ניהול תלמוד תורה החדש";
  const ws = wb.addWorksheet(sheetName, { views: [{ rightToLeft: true }] });

  const lastCol = headerRow.length;

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

  if (fs.existsSync(LOGO_PATH)) {
    try {
      const imageId = wb.addImage({ filename: LOGO_PATH, extension: LOGO_EXT });
      ws.addImage(imageId, { tl: { col: lastCol - 1, row: 0 }, ext: { width: 68, height: 59 } });
    } catch (e) {
      // אם הוספת התמונה נכשלת, ממשיכים בלי לוגו (לא קריטי)
    }
  }

  ws.addRow([]);

  const headerRowIdx = 5;
  const headerExcelRow = ws.getRow(headerRowIdx);
  headerRow.forEach((h, i) => { headerExcelRow.getCell(i + 1).value = h; });
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

router.get("/", (req, res) => {
  const categories = db.prepare("SELECT * FROM categories ORDER BY id").all();
  const discounts = db
    .prepare(`
      SELECT d.*, dt.name AS type_name FROM discounts d
      LEFT JOIN discount_types dt ON d.discount_type_id = dt.id
      ORDER BY d.siblings_count
    `)
    .all();
  const classesByCategory = db
    .prepare(`
      SELECT cat.id, cat.name, cat.price,
        GROUP_CONCAT(c.name || COALESCE(' (' || c.parallel || ')',''), ', ') AS class_names,
        (SELECT COUNT(*) FROM students s WHERE s.class_id IN (
            SELECT id FROM classes WHERE category_id = cat.id
          ) AND s.status='פעיל') AS active_students
      FROM categories cat
      LEFT JOIN classes c ON c.category_id = cat.id
      GROUP BY cat.id
    `)
    .all();

  const familiesTuition = calcAllFamiliesTuition();
  const grandTotal = familiesTuition.reduce((sum, f) => sum + f.netTotal, 0);

  res.render("tuition/list", { categories, discounts, classesByCategory, familiesTuition, grandTotal });
});

// --- ייצוא חישוב שכר לימוד לפי משפחה לאקסל ---
router.get("/export", async (req, res) => {
  const familiesTuition = calcAllFamiliesTuition();
  const header = ["משפחה", "אב", "מס' ילדים", "סכום מלא", "הנחה", "סכום לתשלום"];
  const data = familiesTuition.map((f) => [
    f.last_name || "",
    f.father_name || "",
    f.activeCount,
    f.grossTotal,
    `${f.discountPercent}%${f.discountAmount ? ` (-${f.discountAmount} ₪)` : ""}`,
    f.netTotal,
  ]);
  await sendWorkbook(res, "חישוב שכר לימוד לפי משפחה.xlsx", "שכר לימוד", "חישוב שכר לימוד לפי משפחה", header, data);
});

// ============ קטגוריות שכר לימוד - עריכה ============
router.get("/categories/new", (req, res) => {
  const allClasses = db.prepare("SELECT id, name, parallel, category_id FROM classes ORDER BY name, parallel").all();
  res.render("tuition/category-form", { category: {}, mode: "new", allClasses, selectedClassIds: [] });
});

router.post("/categories", (req, res) => {
  const { name, price } = req.body;
  let classIds = req.body.class_ids || [];
  if (!Array.isArray(classIds)) classIds = [classIds];
  const info = db.prepare("INSERT INTO categories (name, price) VALUES (?,?)").run(name, price ? parseFloat(price) : null);
  const categoryId = info.lastInsertRowid;
  if (classIds.length > 0) {
    const stmt = db.prepare("UPDATE classes SET category_id = ? WHERE id = ?");
    classIds.forEach((id) => stmt.run(categoryId, id));
  }
  res.redirect("/tuition");
});

router.get("/categories/:id/edit", (req, res) => {
  const category = db.prepare("SELECT * FROM categories WHERE id = ?").get(req.params.id);
  if (!category) return res.status(404).render("404");
  const allClasses = db.prepare("SELECT id, name, parallel, category_id FROM classes ORDER BY name, parallel").all();
  const selectedClassIds = allClasses.filter((c) => String(c.category_id) === String(req.params.id)).map((c) => c.id);
  res.render("tuition/category-form", { category, mode: "edit", allClasses, selectedClassIds });
});

router.put("/categories/:id", (req, res) => {
  const { name, price } = req.body;
  let classIds = req.body.class_ids || [];
  if (!Array.isArray(classIds)) classIds = [classIds];
  db.prepare("UPDATE categories SET name = ?, price = ? WHERE id = ?").run(
    name, price ? parseFloat(price) : null, req.params.id
  );
  // מסיר כיתות שלא נבחרו יותר מהקטגוריה, ומשייך את הכיתות שנבחרו
  db.prepare("UPDATE classes SET category_id = NULL WHERE category_id = ?").run(req.params.id);
  if (classIds.length > 0) {
    const stmt = db.prepare("UPDATE classes SET category_id = ? WHERE id = ?");
    classIds.forEach((id) => stmt.run(req.params.id, id));
  }
  res.redirect("/tuition");
});

router.delete("/categories/:id", (req, res) => {
  db.prepare("DELETE FROM categories WHERE id = ?").run(req.params.id);
  res.redirect("/tuition");
});

// ============ הנחות - עריכה ============
router.get("/discounts/new", (req, res) => {
  const discountTypes = db.prepare("SELECT * FROM discount_types ORDER BY id").all();
  res.render("tuition/discount-form", { discount: {}, mode: "new", discountTypes });
});

router.post("/discounts", (req, res) => {
  const { siblings_count, discount_type_id, discount_type_name, amount } = req.body;
  db.prepare(
    "INSERT INTO discounts (siblings_count, discount_type_id, discount_type_name, amount) VALUES (?,?,?,?)"
  ).run(
    siblings_count ? parseInt(siblings_count) : null,
    discount_type_id || null,
    discount_type_name || null,
    amount ? parseFloat(amount) : null
  );
  res.redirect("/tuition");
});

router.get("/discounts/:id/edit", (req, res) => {
  const discount = db.prepare("SELECT * FROM discounts WHERE id = ?").get(req.params.id);
  if (!discount) return res.status(404).render("404");
  const discountTypes = db.prepare("SELECT * FROM discount_types ORDER BY id").all();
  res.render("tuition/discount-form", { discount, mode: "edit", discountTypes });
});

router.put("/discounts/:id", (req, res) => {
  const { siblings_count, discount_type_id, discount_type_name, amount } = req.body;
  db.prepare(
    "UPDATE discounts SET siblings_count=?, discount_type_id=?, discount_type_name=?, amount=? WHERE id=?"
  ).run(
    siblings_count ? parseInt(siblings_count) : null,
    discount_type_id || null,
    discount_type_name || null,
    amount ? parseFloat(amount) : null,
    req.params.id
  );
  res.redirect("/tuition");
});

router.delete("/discounts/:id", (req, res) => {
  db.prepare("DELETE FROM discounts WHERE id = ?").run(req.params.id);
  res.redirect("/tuition");
});

module.exports = router;
