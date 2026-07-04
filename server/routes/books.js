const express = require("express");
const router = express.Router();
const db = require("../db");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");

const LOGO_PATH = path.join(__dirname, "..", "public", "images", "logo-reports.jpg");

// ===== עזר: כיתות ספציפיות (שם + מקבילה) לפי שם =====
function getSpecificClasses(className) {
  return db.prepare("SELECT id, name, parallel FROM classes WHERE name=? ORDER BY parallel").all(className);
}

// ===== עזר: לוגו ל-Excel =====
function addLogo(wb, ws, col, row) {
  if (fs.existsSync(LOGO_PATH)) {
    try {
      const imgId = wb.addImage({ filename: LOGO_PATH, extension: "jpeg" });
      ws.addImage(imgId, { tl: { col, row }, ext: { width: 65, height: 57 } });
    } catch (e) {}
  }
}

// ===== עזר: כותרת Excel =====
function addExcelHeader(wb, ws, title, subtitle, totalCols) {
  ws.mergeCells(1, 1, 1, totalCols);
  const t = ws.getCell(1, 1);
  t.value = "תלמוד תורה החדש"; t.font = { size: 14, bold: true, color: { argb: "FF2C5F7C" } };
  t.alignment = { horizontal: "right" }; ws.getRow(1).height = 22;
  ws.mergeCells(2, 1, 2, totalCols);
  const s = ws.getCell(2, 1);
  s.value = subtitle; s.font = { size: 11, bold: true }; s.alignment = { horizontal: "right" };
  ws.addRow([]);
}

// ============ דף ראשי ============
router.get("/", (req, res) => {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;
  const branch = req.query.branch || "";

  // סניפים קיימים
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r => r.branch);

  // כיתות ספציפיות מהקטלוג — עם סינון סניף
  const classNames = db.prepare("SELECT DISTINCT class_name FROM book_catalog WHERE year_label=? ORDER BY class_name").all(year).map(r => r.class_name);

  const specificClasses = [];
  for (const cn of classNames) {
    let sql = "SELECT id, name, parallel, branch FROM classes WHERE name=?";
    const params = [cn];
    if (branch) { sql += " AND branch=?"; params.push(branch); }
    sql += " ORDER BY parallel";
    const cls = db.prepare(sql).all(...params);
    if (cls.length === 0 && !branch) {
      specificClasses.push({ id: null, name: cn, parallel: null, display: cn, branch: null });
    } else {
      cls.forEach(c => specificClasses.push({ ...c, display: c.name + (c.parallel ? " " + c.parallel : "") }));
    }
  }

  // סטטיסטיקה
  const stats = {};
  for (const cls of specificClasses) {
    if (!cls.id) continue;
    const students = db.prepare("SELECT COUNT(*) c FROM students WHERE class_id=? AND status='פעיל'").get(cls.id);
    const ordered = db.prepare(`
      SELECT COUNT(DISTINCT bo.student_id) c FROM book_orders bo
      JOIN students s ON bo.student_id=s.id
      WHERE bo.year_label=? AND s.class_id=?
    `).get(year, cls.id);
    stats[cls.id] = { students: students?.c || 0, ordered: ordered?.c || 0 };
  }

  res.render("books/index", { year, years, specificClasses, stats, branches, branch });
});

// ============ הזנת הזמנות לכיתה ספציפית ============
router.get("/class", (req, res) => {
  const { year, class_id } = req.query;
  if (!year || !class_id) return res.redirect("/books");

  const cls = db.prepare("SELECT * FROM classes WHERE id=?").get(class_id);
  if (!cls) return res.redirect("/books");

  const catalog = db.prepare(
    "SELECT * FROM book_catalog WHERE year_label=? AND class_name=? ORDER BY sort_order, id"
  ).all(year, cls.name);

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, f.last_name AS family_last
    FROM students s LEFT JOIN families f ON s.family_id=f.id
    WHERE s.class_id=? AND s.status='פעיל' ORDER BY s.last_name, s.first_name
  `).all(class_id);

  const orders = db.prepare("SELECT student_id, catalog_id FROM book_orders WHERE year_label=?").all(year);
  const ordersMap = {};
  orders.forEach(o => {
    if (!ordersMap[o.student_id]) ordersMap[o.student_id] = new Set();
    ordersMap[o.student_id].add(o.catalog_id);
  });

  res.render("books/class-orders", { year, cls, catalog, students, ordersMap, saved: req.query.saved || "" });
});

// ============ שמירת הזמנות ============
router.post("/class/save", (req, res) => {
  const { year, class_id, orders } = req.body;
  if (!year || !class_id) return res.redirect("/books");

  const cls = db.prepare("SELECT * FROM classes WHERE id=?").get(class_id);
  if (!cls) return res.redirect("/books");

  const studentIds = db.prepare("SELECT id FROM students WHERE class_id=? AND status='פעיל'").all(class_id).map(s => s.id);
  const catalogIds = db.prepare("SELECT id FROM book_catalog WHERE year_label=? AND class_name=?").all(year, cls.name).map(c => c.id);

  for (const sid of studentIds) {
    for (const cid of catalogIds) {
      db.prepare("DELETE FROM book_orders WHERE year_label=? AND student_id=? AND catalog_id=?").run(year, sid, cid);
    }
  }

  const now = new Date().toISOString();
  const ordersData = orders ? (Array.isArray(orders) ? orders : [orders]) : [];
  for (const key of ordersData) {
    const [sid, cid] = key.split("_").map(Number);
    if (studentIds.includes(sid) && catalogIds.includes(cid)) {
      db.prepare("INSERT OR REPLACE INTO book_orders (year_label, student_id, catalog_id, ordered, created_at) VALUES (?,?,?,1,?)").run(year, sid, cid, now);
    }
  }

  res.redirect(`/books/class?year=${encodeURIComponent(year)}&class_id=${class_id}&saved=1`);
});

// ============ דוח כיתה ספציפית לאקסל ============
router.get("/report/class", async (req, res) => {
  const { year, class_id } = req.query;
  if (!year || !class_id) return res.redirect("/books");

  const cls = db.prepare("SELECT * FROM classes WHERE id=?").get(class_id);
  if (!cls) return res.redirect("/books");

  const display = cls.name + (cls.parallel ? " " + cls.parallel : "");
  const catalog = db.prepare("SELECT * FROM book_catalog WHERE year_label=? AND class_name=? ORDER BY sort_order, id").all(year, cls.name);
  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, f.last_name AS family_last
    FROM students s LEFT JOIN families f ON s.family_id=f.id
    WHERE s.class_id=? AND s.status='פעיל' ORDER BY s.last_name, s.first_name
  `).all(class_id);

  const orders = db.prepare("SELECT student_id, catalog_id FROM book_orders WHERE year_label=?").all(year);
  const ordersSet = new Set(orders.map(o => `${o.student_id}_${o.catalog_id}`));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(display, { views: [{ rightToLeft: true }] });

  addExcelHeader(wb, ws, "", `הזמנת ספרים ${year} — ${display}`, catalog.length + 3);
  addLogo(wb, ws, catalog.length + 2, 0);

  const headerRow = ws.addRow(["שם פרטי", "שם משפחה", ...catalog.map(c => c.item_name), "סה\"כ ₪"]);
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C5F7C" } };
    cell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
  });
  headerRow.height = 45;

  let grandTotal = 0;
  for (const s of students) {
    const items = catalog.map(c => ordersSet.has(`${s.id}_${c.id}`) ? "✓" : "");
    const total = catalog.reduce((sum, c) => sum + (ordersSet.has(`${s.id}_${c.id}`) ? c.price : 0), 0);
    grandTotal += total;
    const row = ws.addRow([s.first_name, s.last_name || s.family_last || "", ...items, total || ""]);
    row.alignment = { horizontal: "right" };
  }
  const sr = ws.addRow(["", "סה\"כ", ...catalog.map(() => ""), grandTotal]);
  sr.font = { bold: true };
  sr.eachCell(cell => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF4F8" } }; });

  ws.getColumn(1).width = 14; ws.getColumn(2).width = 16;
  catalog.forEach((_, i) => { ws.getColumn(i + 3).width = 18; });
  ws.getColumn(catalog.length + 3).width = 12;

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`ספרים-${display}-${year}.xlsx`)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
});

// ============ דוח חיובים למשפחות ============
router.get("/report/families", async (req, res) => {
  const { year } = req.query;
  if (!year) return res.redirect("/books");

  const families = db.prepare(`
    SELECT DISTINCT f.id, f.last_name, f.father_name, f.home_phone, f.father_mobile
    FROM families f JOIN students s ON s.family_id=f.id
    JOIN book_orders bo ON bo.student_id=s.id WHERE bo.year_label=? ORDER BY f.last_name
  `).all(year);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("חיובים", { views: [{ rightToLeft: true }] });
  addExcelHeader(wb, ws, "", `חיובי הזמנת ספרים ${year}`, 8);
  addLogo(wb, ws, 6, 0);

  const hr = ws.addRow(["שם משפחה", "שם האב", "טלפון", "ילד/כיתה", "ספרים שהוזמנו", "סה\"כ ₪", "שולם ₪", "יתרה ₪"]);
  hr.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C5F7C" } };
    cell.alignment = { horizontal: "right" };
  });

  let grandTotal = 0;
  let grandPaid = 0;
  for (const fam of families) {
    const items = db.prepare(`
      SELECT bc.item_name, bc.price, s.first_name, c.name||' '||COALESCE(c.parallel,'') AS class_label
      FROM book_orders bo JOIN book_catalog bc ON bo.catalog_id=bc.id
      JOIN students s ON bo.student_id=s.id LEFT JOIN classes c ON s.class_id=c.id
      WHERE bo.year_label=? AND s.family_id=? ORDER BY s.first_name, bc.sort_order
    `).all(year, fam.id);

    const total = items.reduce((s, i) => s + i.price, 0);
    grandTotal += total;
    const paidRow = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM book_payments WHERE year_label=? AND family_id=?").get(year, fam.id);
    const paid = paidRow.s;
    grandPaid += paid;
    const childClass = [...new Set(items.map(i => `${i.first_name} (${i.class_label.trim()})`))].join(", ");
    const detail = items.map(i => `${i.item_name} — ${i.price}₪`).join("\n");
    const row = ws.addRow([fam.last_name, fam.father_name || "", fam.father_mobile || fam.home_phone || "", childClass, detail, total, paid, Math.round((total - paid) * 100) / 100]);
    row.getCell(5).alignment = { wrapText: true };
    row.height = Math.max(18, items.length * 14);
    row.alignment = { horizontal: "right" };
  }
  const sr = ws.addRow(["", "", "", "", "סה\"כ כולל", grandTotal, grandPaid, Math.round((grandTotal - grandPaid) * 100) / 100]);
  sr.font = { bold: true };

  [15, 18, 14, 30, 50, 12, 12, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`חיובים-ספרים-${year}.xlsx`)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
});

// ============ תשלומים בפועל להזמנת ספרים ============
router.get("/payments", (req, res) => {
  const { year, branch } = req.query;
  if (!year) return res.redirect("/books");

  const families = db.prepare(`
    SELECT DISTINCT f.id, f.last_name, f.father_name, f.home_phone, f.father_mobile
    FROM families f JOIN students s ON s.family_id=f.id
    JOIN book_orders bo ON bo.student_id=s.id
    LEFT JOIN classes c ON s.class_id=c.id
    WHERE bo.year_label=? ${branch ? "AND c.branch=?" : ""}
    ORDER BY f.last_name
  `).all(...(branch ? [year, branch] : [year]));

  const familiesData = families.map((fam) => {
    const items = db.prepare(`
      SELECT bc.item_name, bc.price, s.first_name, c.name||' '||COALESCE(c.parallel,'') AS class_label
      FROM book_orders bo JOIN book_catalog bc ON bo.catalog_id=bc.id
      JOIN students s ON bo.student_id=s.id LEFT JOIN classes c ON s.class_id=c.id
      WHERE bo.year_label=? AND s.family_id=? ORDER BY s.first_name, bc.sort_order
    `).all(year, fam.id);
    const total = items.reduce((s, i) => s + i.price, 0);
    const childClass = [...new Set(items.map(i => `${i.first_name} (${(i.class_label || "").trim()})`))].join(", ");

    const payments = db.prepare(`
      SELECT * FROM book_payments WHERE year_label=? AND family_id=? ORDER BY payment_date, id
    `).all(year, fam.id);
    const paid = payments.reduce((s, p) => s + p.amount, 0);

    return { ...fam, childClass, total, payments, paid, balance: Math.round((total - paid) * 100) / 100 };
  });

  const grandTotal = familiesData.reduce((s, f) => s + f.total, 0);
  const grandPaid = familiesData.reduce((s, f) => s + f.paid, 0);

  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL AND branch<>'' ORDER BY branch").all().map(r => r.branch);

  res.render("books/payments", { year, branch: branch || "", branches, familiesData, grandTotal, grandPaid });
});

router.post("/payments/add", (req, res) => {
  const { year, family_id, amount, method, payment_date, notes, branch } = req.body;
  const amt = parseFloat(amount);
  if (year && family_id && amt > 0) {
    db.prepare(`
      INSERT INTO book_payments (year_label, family_id, amount, method, payment_date, notes, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(year, family_id, amt, method || "מזומן", payment_date || null, notes || null, req.currentUser.id, new Date().toISOString());
  }
  res.redirect(`/books/payments?year=${encodeURIComponent(year)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`);
});

router.post("/payments/:id/delete", (req, res) => {
  const payment = db.prepare("SELECT * FROM book_payments WHERE id=?").get(req.params.id);
  db.prepare("DELETE FROM book_payments WHERE id=?").run(req.params.id);
  const { year, branch } = req.query;
  const y = year || (payment ? payment.year_label : "");
  res.redirect(`/books/payments?year=${encodeURIComponent(y)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}`);
});

// ============ מכתב הזמנה להורים (checkboxes ריקים) ============
router.get("/order-form", (req, res) => {
  const { year, class_id } = req.query;
  if (!year || !class_id) return res.redirect("/books");

  const cls = db.prepare("SELECT * FROM classes WHERE id=?").get(class_id);
  if (!cls) return res.redirect("/books");

  const catalog = db.prepare(
    "SELECT * FROM book_catalog WHERE year_label=? AND class_name=? ORDER BY sort_order, id"
  ).all(year, cls.name);

  const display = cls.name + (cls.parallel ? " " + cls.parallel : "");
  const total = catalog.reduce((s, c) => s + c.price, 0);

  res.render("books/order-form", { year, cls, display, catalog, total });
});

// ============ מכתב חיוב למשפחה ============
router.get("/letter", (req, res) => {
  const { year, class_id, family_id } = req.query;
  if (!year) return res.redirect("/books");

  if (family_id) {
    const family = db.prepare("SELECT * FROM families WHERE id=?").get(family_id);
    const students = db.prepare("SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.family_id=? AND s.status='פעיל'").all(family_id);
    const letterData = students.map(s => {
      const catalog = db.prepare("SELECT * FROM book_catalog WHERE year_label=? AND class_name=? ORDER BY sort_order").all(year, s.class_name);
      const orderSet = new Set(db.prepare("SELECT catalog_id FROM book_orders WHERE year_label=? AND student_id=?").all(year, s.id).map(o => o.catalog_id));
      const items = catalog.filter(c => orderSet.has(c.id));
      return { student: s, items, total: items.reduce((s, c) => s + c.price, 0) };
    }).filter(d => d.items.length > 0);
    return res.render("books/letter", { year, family, letterData });
  }

  if (class_id) {
    const cls = db.prepare("SELECT * FROM classes WHERE id=?").get(class_id);
    if (!cls) return res.redirect("/books");
    const studentIds = db.prepare("SELECT id, family_id FROM students WHERE class_id=? AND status='פעיל'").all(class_id);
    const famIds = [...new Set(studentIds.map(s => s.family_id).filter(Boolean))];
    const allLetterData = [];
    for (const fid of famIds) {
      const family = db.prepare("SELECT * FROM families WHERE id=?").get(fid);
      const students = db.prepare("SELECT s.*, c.name AS class_name FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.family_id=? AND s.status='פעיל'").all(fid);
      const letterData = students.map(s => {
        const catalog = db.prepare("SELECT * FROM book_catalog WHERE year_label=? AND class_name=? ORDER BY sort_order").all(year, s.class_name);
        const orderSet = new Set(db.prepare("SELECT catalog_id FROM book_orders WHERE year_label=? AND student_id=?").all(year, s.id).map(o => o.catalog_id));
        const items = catalog.filter(c => orderSet.has(c.id));
        return { student: s, items, total: items.reduce((s, c) => s + c.price, 0) };
      }).filter(d => d.items.length > 0);
      if (letterData.length > 0) allLetterData.push({ family, letterData });
    }
    return res.render("books/letter-all", { year, class_name: cls.name + " " + (cls.parallel || ""), allLetterData });
  }

  res.redirect("/books");
});

// ============ מחירון בסיס ============
router.get("/pricelist", (req, res) => {
  const items = db.prepare("SELECT * FROM price_list ORDER BY item_name").all();
  res.render("books/pricelist", { items, saved: req.query.saved || "" });
});

router.post("/pricelist", (req, res) => {
  const { item_name, price, publisher } = req.body;
  if (!item_name || !price) return res.redirect("/books/pricelist");
  db.prepare("INSERT OR REPLACE INTO price_list (item_name, price, publisher, updated_at) VALUES (?,?,?,?)").run(
    item_name, parseFloat(price), publisher || "", new Date().toISOString()
  );
  res.redirect("/books/pricelist?saved=1");
});

router.post("/pricelist/:id/update", (req, res) => {
  const { price, publisher } = req.body;
  const item = db.prepare("SELECT item_name FROM price_list WHERE id=?").get(req.params.id);
  if (!item) return res.redirect("/books/pricelist");
  db.prepare("UPDATE price_list SET price=?, publisher=?, updated_at=? WHERE id=?").run(
    parseFloat(price), publisher || "", new Date().toISOString(), req.params.id
  );
  // עדכון כל פריטי הקטלוג עם אותו שם
  db.prepare("UPDATE book_catalog SET price=? WHERE item_name LIKE ?").run(
    parseFloat(price), `%${item.item_name.substring(0, 8)}%`
  );
  res.redirect("/books/pricelist?saved=1");
});

router.delete("/pricelist/:id", (req, res) => {
  db.prepare("DELETE FROM price_list WHERE id=?").run(req.params.id);
  res.redirect("/books/pricelist");
});

// ============ קטלוג ============
router.get("/catalog", (req, res) => {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;
  const catalog = db.prepare("SELECT * FROM book_catalog WHERE year_label=? ORDER BY class_name, sort_order, id").all(year);
  const grouped = {};
  catalog.forEach(c => { if (!grouped[c.class_name]) grouped[c.class_name] = []; grouped[c.class_name].push(c); });
  res.render("books/catalog", { year, years, catalog, grouped });
});

router.post("/catalog", (req, res) => {
  const { year_label, class_name, item_name, publisher, price, is_mandatory } = req.body;
  db.prepare("INSERT INTO book_catalog (year_label, class_name, item_name, publisher, price, is_mandatory) VALUES (?,?,?,?,?,?)").run(year_label, class_name, item_name, publisher || "", parseFloat(price) || 0, is_mandatory === "on" ? 1 : 0);
  res.redirect(`/books/catalog?year=${encodeURIComponent(year_label)}`);
});

router.delete("/catalog/:id", (req, res) => {
  const row = db.prepare("SELECT year_label FROM book_catalog WHERE id=?").get(req.params.id);
  db.prepare("DELETE FROM book_catalog WHERE id=?").run(req.params.id);
  res.redirect(`/books/catalog?year=${encodeURIComponent(row?.year_label || "")}`);
});

router.put("/catalog/:id", (req, res) => {
  const { class_name, item_name, publisher, price, is_mandatory, year_label } = req.body;
  db.prepare(`
    UPDATE book_catalog SET class_name=?, item_name=?, publisher=?, price=?, is_mandatory=?
    WHERE id=?
  `).run(class_name, item_name, publisher || "", parseFloat(price) || 0, is_mandatory === "on" ? 1 : 0, req.params.id);
  res.redirect(`/books/catalog?year=${encodeURIComponent(year_label || "")}`);
});


// ============ מחירון בסיס ============
router.get("/prices", (req, res) => {
  const prices = db.prepare("SELECT * FROM book_prices ORDER BY item_name").all();
  res.render("books/prices", { prices, updated: req.query.updated || "" });
});

router.post("/prices", (req, res) => {
  const { item_name, publisher, price, notes } = req.body;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO book_prices (item_name, publisher, price, notes, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(item_name) DO UPDATE SET price=excluded.price, publisher=excluded.publisher, notes=excluded.notes, updated_at=excluded.updated_at").run(item_name, publisher||'', parseFloat(price)||0, notes||'', now);
  res.redirect("/books/prices");
});

// עדכון מחיר ומעדכן קטלוגים קשורים
router.put("/prices/:id", (req, res) => {
  const { price, publisher } = req.body;
  const row = db.prepare("SELECT * FROM book_prices WHERE id=?").get(req.params.id);
  if (!row) return res.redirect("/books/prices");
  const newPrice = parseFloat(price) || 0;
  db.prepare("UPDATE book_prices SET price=?, publisher=?, updated_at=? WHERE id=?").run(newPrice, publisher||row.publisher||'', new Date().toISOString(), req.params.id);
  // עדכון כל הקטלוגים עם שם זהה
  const updated = db.prepare("UPDATE book_catalog SET price=? WHERE item_name=?").run(newPrice, row.item_name);
  res.redirect("/books/prices?updated=" + updated.changes);
});

router.delete("/prices/:id", (req, res) => {
  db.prepare("DELETE FROM book_prices WHERE id=?").run(req.params.id);
  res.redirect("/books/prices");
});

// ============ חידוש ספרים / הזמנות נוספות ============
router.get("/renewals", (req, res) => {
  const { year, class_id } = req.query;
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || 'תשפ"ז';
  const activeYear = year || defaultYear;
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  let students = [];
  if (class_id) {
    students = db.prepare("SELECT s.id, s.first_name, s.last_name, f.last_name AS family_last FROM students s LEFT JOIN families f ON s.family_id=f.id WHERE s.class_id=? AND s.status='פעיל' ORDER BY s.last_name, s.first_name").all(class_id);
  }
  const prices = db.prepare("SELECT * FROM book_prices ORDER BY item_name").all();
  const extras = class_id ? db.prepare(`SELECT e.*, s.first_name, s.last_name FROM book_order_extras e JOIN students s ON e.student_id=s.id WHERE e.year_label=? AND s.class_id=? ORDER BY s.last_name, e.item_name`).all(activeYear, class_id) : [];
  res.render("books/renewals", { year: activeYear, classes, class_id: class_id||'', students, prices, extras });
});

router.post("/renewals", (req, res) => {
  const { year, student_id, item_name, price, notes } = req.body;
  const class_id = req.body.class_id;
  db.prepare("INSERT INTO book_order_extras (year_label, student_id, item_name, price, notes, created_at) VALUES (?,?,?,?,?,?)").run(year, student_id, item_name, parseFloat(price)||0, notes||'', new Date().toISOString());
  res.redirect(`/books/renewals?year=${encodeURIComponent(year)}&class_id=${class_id}`);
});

router.delete("/renewals/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM book_order_extras WHERE id=?").get(req.params.id);
  db.prepare("DELETE FROM book_order_extras WHERE id=?").run(req.params.id);
  const year = row?.year_label || '';
  const sid = db.prepare("SELECT class_id FROM students WHERE id=?").get(row?.student_id)?.class_id || '';
  res.redirect(`/books/renewals?year=${encodeURIComponent(year)}&class_id=${sid}`);
});

module.exports = router;

// ============ מחירון בסיס ============
