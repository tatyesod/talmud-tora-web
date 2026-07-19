const express = require("express");
const router = express.Router();
const db = require("../db");
const ExcelJS = require("exceljs");
const path = require("path");
const fs = require("fs");
const hd = require("../hebrewDate");

const LOGO_PATH = path.join(__dirname, "..", "public", "images", "logo-reports.jpg");

// כיתות שיש בהן הזמנת ספרים בפועל - "עדיין לא נכנסו", "מכינה א'" ו"מכינה ב'"
// לא כלולות (אין בהן הזמנת ספרים).
const BOOK_GRADE_OPTIONS = [
  "כיתה א'", "כיתה ב'", "כיתה ג'", "כיתה ד'",
  "כיתה ה'", "כיתה ו'", "כיתה ז'", "כיתה ח'",
];

// מסנכרן את קטלוג ההזמנה (book_catalog, לכל השנים) מתוך הקטלוג (book_prices +
// book_price_grades) - מקור האמת היחיד. מוסיף פריטים חדשים, מעדכן מחיר/הוצאה
// של קיימים (כדי שהשם תמיד יהיה זהה אות-באות בין הקטלוג למלאי), וגם מנקה
// שורות שכבר לא משויכות לאותה כיתה - אבל ורק אם אין עליהן הזמנה אמיתית (כדי
// לא לפגוע בהזמנות קיימות). זה מה ששומר את הקטלוג מסונכרן אוטומטית עם השיוך
// בלי להשאיר "עמודות מיותרות" תקועות בהזמנת הספרים של הכיתות.
// בנוי לביצועים: כל הנתונים נשלפים בכמה שאילתות מרוכזות (לא שאילתה בודדת לכל
// פריט), והכתיבות רצות בטרנזקציה אחת - כדי שהריצה (על כל טעינת מלאי) תהיה מהירה.
function syncCatalogFromPrices() {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog").all().map((r) => r.year_label);
  const currentYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value;
  if (currentYear && !years.includes(currentYear)) years.push(currentYear);

  const assignments = db.prepare(`
    SELECT bp.id, bp.item_name, bp.publisher, bp.price, bpg.class_name
    FROM book_prices bp
    JOIN book_price_grades bpg ON bpg.book_price_id = bp.id
  `).all();

  // שולפים בבת אחת את כל שורות הקטלוג הקיימות (לשנים הרלוונטיות), לבדיקת
  // "קיים? מחיר/הוצאה זהים?" מהיר במפה, במקום שאילתה נפרדת לכל שילוב
  const existingRows = years.length
    ? db.prepare(`SELECT id, year_label, class_name, item_name, price, publisher FROM book_catalog WHERE year_label IN (${years.map(() => "?").join(",")})`).all(...years)
    : [];
  const existingMap = new Map();
  existingRows.forEach((r) => existingMap.set(`${r.year_label}|${r.class_name}|${r.item_name}`, r));

  const insertStmt = db.prepare("INSERT INTO book_catalog (year_label, class_name, item_name, publisher, price, sort_order) VALUES (?,?,?,?,?,0)");
  const updateStmt = db.prepare("UPDATE book_catalog SET price = ?, publisher = ? WHERE id = ?");

  let added = 0, updated = 0;
  db.exec("BEGIN TRANSACTION");
  try {
    years.forEach((year) => {
      assignments.forEach((a) => {
        const existing = existingMap.get(`${year}|${a.class_name}|${a.item_name}`);
        if (existing) {
          if (existing.price !== a.price || existing.publisher !== a.publisher) {
            updateStmt.run(a.price, a.publisher, existing.id);
            updated++;
          }
        } else {
          insertStmt.run(year, a.class_name, a.item_name, a.publisher, a.price);
          added++;
        }
      });
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  // ניקוי שוטף: מוחקים שורות קטלוג של ספר שכבר לא משויך לאותה כיתה - אבל
  // ורק אם אין עליהן שום הזמנה אמיתית (זה בדיוק מה שגורם ל"עמודות מיותרות"
  // כשמשנים שיוך ב"שיוך ספר לכיתה" - בלי הניקוי הזה, השורה הישנה נשארת
  // תקועה בקטלוג לנצח). שורות עם הזמנה אמיתית לא נמחקות - ימשיכו להופיע
  // בבדיקת ההתאמות לבדיקה ידנית, כדי לא לאבד הזמנה בטעות.
  // שולפים גם את ספירת ההזמנות של כולן בבת אחת (במקום שאילתה נפרדת לכל שורה).
  let removed = 0, keptWithOrders = 0;
  const orphanRows = db.prepare(`
    SELECT bc.id FROM book_catalog bc
    JOIN book_prices bp ON TRIM(bp.item_name) = TRIM(bc.item_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM book_price_grades bpg WHERE bpg.book_price_id = bp.id AND bpg.class_name = bc.class_name
    )
  `).all();
  if (orphanRows.length) {
    const orphanIds = orphanRows.map((r) => r.id);
    const orderCounts = db.prepare(
      `SELECT catalog_id, COUNT(*) c FROM book_orders WHERE catalog_id IN (${orphanIds.map(() => "?").join(",")}) GROUP BY catalog_id`
    ).all(...orphanIds);
    const orderCountMap = new Map(orderCounts.map((r) => [r.catalog_id, r.c]));
    const deleteStmt = db.prepare("DELETE FROM book_catalog WHERE id = ?");
    db.exec("BEGIN TRANSACTION");
    try {
      orphanRows.forEach((row) => {
        if (!orderCountMap.has(row.id)) {
          deleteStmt.run(row.id);
          removed++;
        } else {
          keptWithOrders++;
        }
      });
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  return { added, updated, removed, keptWithOrders };
}

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
    SELECT s.id, s.first_name, s.last_name, s.family_id, f.last_name AS family_last,
           f.father_name, f.street, f.house_number, f.city
    FROM students s LEFT JOIN families f ON s.family_id=f.id
    WHERE s.class_id=? AND s.status='פעיל' ORDER BY s.last_name, s.first_name
  `).all(class_id);

  const orders = db.prepare("SELECT student_id, catalog_id FROM book_orders WHERE year_label=?").all(year);
  const ordersMap = {};
  orders.forEach(o => {
    if (!ordersMap[o.student_id]) ordersMap[o.student_id] = new Set();
    ordersMap[o.student_id].add(o.catalog_id);
  });

  res.render("books/class-orders", { year, cls, catalog, students, ordersMap, saved: req.query.saved || "", creditCreated: parseInt(req.query.creditCreated, 10) || 0, creditAmount: parseFloat(req.query.creditAmount) || 0 });
});

// ============ שמירת הזמנות ============
router.post("/class/save", (req, res) => {
  const { year, class_id, orders } = req.body;
  if (!year || !class_id) return res.redirect("/books");

  const cls = db.prepare("SELECT * FROM classes WHERE id=?").get(class_id);
  if (!cls) return res.redirect("/books");

  const studentIds = db.prepare("SELECT id, first_name, last_name, family_id FROM students WHERE class_id=? AND status='פעיל'").all(class_id);
  const catalog = db.prepare("SELECT id, item_name, price FROM book_catalog WHERE year_label=? AND class_name=?").all(year, cls.name);
  const catalogIds = catalog.map(c => c.id);
  const priceById = {};
  catalog.forEach(c => { priceById[c.id] = c.price; });

  // מצב "לפני" - כדי לזהות מי איבד הזמנה (ולא רק מי קיבל הזמנה חדשה)
  const oldOrders = db.prepare(
    `SELECT student_id, catalog_id FROM book_orders WHERE year_label=? AND student_id IN (${studentIds.map(() => "?").join(",") || "NULL"})`
  ).all(year, ...studentIds.map(s => s.id));
  const oldMap = {};
  oldOrders.forEach(o => {
    if (!oldMap[o.student_id]) oldMap[o.student_id] = new Set();
    oldMap[o.student_id].add(o.catalog_id);
  });

  for (const s of studentIds) {
    for (const cid of catalogIds) {
      db.prepare("DELETE FROM book_orders WHERE year_label=? AND student_id=? AND catalog_id=?").run(year, s.id, cid);
    }
  }

  const now = new Date().toISOString();
  const ordersData = orders ? (Array.isArray(orders) ? orders : [orders]) : [];
  const newMap = {};
  const studentIdList = studentIds.map(s => s.id);
  for (const key of ordersData) {
    const [sid, cid] = key.split("_").map(Number);
    if (studentIdList.includes(sid) && catalogIds.includes(cid)) {
      db.prepare("INSERT OR REPLACE INTO book_orders (year_label, student_id, catalog_id, ordered, created_at) VALUES (?,?,?,1,?)").run(year, sid, cid, now);
      if (!newMap[sid]) newMap[sid] = new Set();
      newMap[sid].add(cid);
    }
  }

  // תשלום תלוי תמיד בסימון ההזמנה: כשמבטלים ספר לתלמיד, לא נוגעים כאן בתשלומים
  // בכלל - ה"סה"כ לתשלום" של המשפחה כבר יורד ממילא (מחושב לפי ההזמנות הנוכחיות),
  // כך שאם המשפחה כבר שילמה על הספר שבוטל, תיווצר אוטומטית "יתרת זכות" (תוצג בכחול
  // במסך התשלומים) - סימן שמגיע להם החזר. ההחזר בפועל נרשם במסך התשלומים עצמו
  // (כפתור ייעודי ליד יתרת הזכות), ולא כאן - כדי שלא "נאפס" תשלום לפני שבאמת הוחזר.
  let affectedCount = 0;
  let affectedTotal = 0;
  for (const s of studentIds) {
    const before = oldMap[s.id] || new Set();
    const after = newMap[s.id] || new Set();
    const removedIds = [...before].filter((cid) => !after.has(cid));
    if (removedIds.length === 0 || !s.family_id) continue;
    const removedTotal = removedIds.reduce((sum, cid) => sum + (priceById[cid] || 0), 0);
    if (removedTotal <= 0) continue;
    affectedCount++;
    affectedTotal += removedTotal;
  }

  res.redirect(`/books/class?year=${encodeURIComponent(year)}&class_id=${class_id}&saved=1${affectedCount > 0 ? "&creditCreated=" + affectedCount + "&creditAmount=" + affectedTotal : ""}`);
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
    WHERE s.family_id IN (
      SELECT s2.family_id FROM students s2 JOIN book_orders bo ON bo.student_id=s2.id WHERE bo.year_label=?
      UNION
      SELECT s3.family_id FROM students s3 JOIN book_order_extras e ON e.student_id=s3.id WHERE e.year_label=?
    )
    ORDER BY f.last_name
  `).all(year, year);

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
    const extras = db.prepare(`
      SELECT e.item_name, e.price, s.first_name, c.name||' '||COALESCE(c.parallel,'') AS class_label
      FROM book_order_extras e JOIN students s ON e.student_id=s.id LEFT JOIN classes c ON s.class_id=c.id
      WHERE e.year_label=? AND s.family_id=? ORDER BY s.first_name, e.item_name
    `).all(year, fam.id);
    const allItems = [...items, ...extras];

    const total = allItems.reduce((s, i) => s + (i.price || 0), 0);
    grandTotal += total;
    const paidRow = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM book_payments WHERE year_label=? AND family_id=?").get(year, fam.id);
    const paid = paidRow.s;
    grandPaid += paid;
    const childClass = [...new Set(allItems.map(i => `${i.first_name} (${(i.class_label || "").trim()})`))].join(", ");
    const detail = allItems.map(i => `${i.item_name} — ${i.price}₪`).join("\n");
    const row = ws.addRow([fam.last_name, fam.father_name || "", fam.father_mobile || fam.home_phone || "", childClass, detail, total, paid, Math.round((total - paid) * 100) / 100]);
    row.getCell(5).alignment = { wrapText: true };
    row.height = Math.max(18, allItems.length * 14);
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
    SELECT DISTINCT f.id, f.last_name, f.father_name, f.home_phone, f.father_mobile,
           f.street, f.house_number, f.city
    FROM families f JOIN students s ON s.family_id=f.id
    LEFT JOIN classes c ON s.class_id=c.id
    WHERE s.family_id IN (
      SELECT s2.family_id FROM students s2 JOIN book_orders bo ON bo.student_id=s2.id WHERE bo.year_label=?
      UNION
      SELECT s3.family_id FROM students s3 JOIN book_order_extras e ON e.student_id=s3.id WHERE e.year_label=?
    ) ${branch ? "AND c.branch=?" : ""}
    ORDER BY f.last_name
  `).all(...(branch ? [year, year, branch] : [year, year]));

  const familiesData = families.map((fam) => {
    const items = db.prepare(`
      SELECT bc.item_name, bc.price, s.first_name, c.name||' '||COALESCE(c.parallel,'') AS class_label
      FROM book_orders bo JOIN book_catalog bc ON bo.catalog_id=bc.id
      JOIN students s ON bo.student_id=s.id LEFT JOIN classes c ON s.class_id=c.id
      WHERE bo.year_label=? AND s.family_id=? ORDER BY s.first_name, bc.sort_order
    `).all(year, fam.id);
    const extras = db.prepare(`
      SELECT e.item_name, e.price, s.first_name, c.name||' '||COALESCE(c.parallel,'') AS class_label
      FROM book_order_extras e JOIN students s ON e.student_id=s.id LEFT JOIN classes c ON s.class_id=c.id
      WHERE e.year_label=? AND s.family_id=? ORDER BY s.first_name, e.item_name
    `).all(year, fam.id);
    const allItems = [...items, ...extras];
    const total = allItems.reduce((s, i) => s + (i.price || 0), 0);
    const childClass = [...new Set(allItems.map(i => `${i.first_name} (${(i.class_label || "").trim()})`))].join(", ");

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
  res.redirect(`/books/payments?year=${encodeURIComponent(year)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}#fam-${family_id}`);
});

router.post("/payments/:id/delete", (req, res) => {
  const payment = db.prepare("SELECT * FROM book_payments WHERE id=?").get(req.params.id);
  db.prepare("DELETE FROM book_payments WHERE id=?").run(req.params.id);
  const { year, branch } = req.query;
  const y = year || (payment ? payment.year_label : "");
  const anchor = payment ? `#fam-${payment.family_id}` : "";
  res.redirect(`/books/payments?year=${encodeURIComponent(y)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}${anchor}`);
});

// אישור החזר בפועל למשפחה על יתרת זכות שנוצרה עקב ביטול הזמנה -
// מוסיף רשומת קיזוז שמאפסת בדיוק את יתרת הזכות הנוכחית (ולא סתם סכום קבוע),
// כדי שהחישוב יהיה נכון גם אם בינתיים היו עוד שינויים.
router.post("/payments/settle-credit", (req, res) => {
  const { year, family_id, branch } = req.body;
  if (year && family_id) {
    const family = db.prepare("SELECT last_name FROM families WHERE id=?").get(family_id);
    // מחשבים מחדש את היתרה הנוכחית בדיוק כמו שמסך התשלומים מחשב, כדי לאפס בדיוק אליה
    const items = db.prepare(`
      SELECT bc.price FROM book_orders bo JOIN book_catalog bc ON bo.catalog_id=bc.id
      JOIN students s ON bo.student_id=s.id WHERE bo.year_label=? AND s.family_id=?
    `).all(year, family_id);
    const extras = db.prepare(`
      SELECT e.price FROM book_order_extras e JOIN students s ON e.student_id=s.id
      WHERE e.year_label=? AND s.family_id=?
    `).all(year, family_id);
    const total = [...items, ...extras].reduce((s, i) => s + (i.price || 0), 0);
    const paidSoFar = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM book_payments WHERE year_label=? AND family_id=?").get(year, family_id).s;
    const credit = paidSoFar - total; // חיובי = יש יתרת זכות לקוזז
    if (credit > 0) {
      db.prepare(`
        INSERT INTO book_payments (year_label, family_id, amount, method, payment_date, notes, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(
        year, family_id, -credit, "אישור החזר ללקוח", new Date().toISOString().slice(0, 10),
        `אושר והוחזר בפועל ללקוח סך ${credit.toLocaleString()} ₪ (יתרת זכות ${family ? "- משפחת " + family.last_name : ""})`,
        req.currentUser.id, new Date().toISOString()
      );
    }
  }
  res.redirect(`/books/payments?year=${encodeURIComponent(year)}${branch ? `&branch=${encodeURIComponent(branch)}` : ""}#fam-${family_id}`);
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
    const students = db.prepare("SELECT s.*, c.name AS class_name, c.parallel AS class_parallel FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.family_id=? AND s.status='פעיל'").all(family_id);
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
      const students = db.prepare("SELECT s.*, c.name AS class_name, c.parallel AS class_parallel FROM students s LEFT JOIN classes c ON s.class_id=c.id WHERE s.family_id=? AND s.status='פעיל'").all(fid);
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
// ============ קטלוג ============
// ============ קטלוג ומחירון - עמוד מאוחד ============
router.get("/catalog-and-prices", (req, res) => {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;
  const catalog = db.prepare("SELECT * FROM book_catalog WHERE year_label=? ORDER BY class_name, sort_order, id").all(year);
  const grouped = {};
  catalog.forEach(c => { if (!grouped[c.class_name]) grouped[c.class_name] = []; grouped[c.class_name].push(c); });
  res.render("books/catalog-and-prices", { year, years, grouped });
});

// נתיבים ישנים - הפניה לעמוד המאוחד (למקרה של סימניות שמורות)
router.get("/catalog", (req, res) => {
  res.redirect(`/books/catalog-and-prices${req.query.year ? "?year=" + encodeURIComponent(req.query.year) : ""}`);
});
router.get("/prices", (req, res) => {
  res.redirect("/books/catalog-and-prices");
});

// ============ חידוש ספרים / הזמנות נוספות ============
router.get("/renewals", (req, res) => {
  const { year, class_id, summary_branch } = req.query;
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || 'תשפ"ז';
  const activeYear = year || defaultYear;
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  let students = [];
  if (class_id) {
    students = db.prepare("SELECT s.id, s.first_name, s.last_name, f.last_name AS family_last FROM students s LEFT JOIN families f ON s.family_id=f.id WHERE s.class_id=? AND s.status='פעיל' ORDER BY s.last_name, s.first_name").all(class_id);
  }
  const prices = db.prepare("SELECT * FROM book_prices ORDER BY item_name").all();
  const extras = class_id ? db.prepare(`SELECT e.*, s.first_name, s.last_name FROM book_order_extras e JOIN students s ON e.student_id=s.id WHERE e.year_label=? AND s.class_id=? ORDER BY s.last_name, e.item_name`).all(activeYear, class_id) : [];

  // סיכום כללי לכל הכיתות/סניפים - לצורך הזמנת ספרים מהמו"ל
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map((r) => r.branch);
  let summarySql = `
    SELECT e.item_name, COUNT(*) AS quantity, SUM(e.price) AS total_price
    FROM book_order_extras e
    JOIN students s ON e.student_id = s.id
    LEFT JOIN classes c ON s.class_id = c.id
    WHERE e.year_label = ?
  `;
  const summaryParams = [activeYear];
  if (summary_branch) {
    summarySql += " AND c.branch = ?";
    summaryParams.push(summary_branch);
  }
  summarySql += " GROUP BY e.item_name ORDER BY quantity DESC, e.item_name";
  const summaryRows = db.prepare(summarySql).all(...summaryParams);
  const summaryTotalQty = summaryRows.reduce((s, r) => s + r.quantity, 0);
  const summaryTotalPrice = summaryRows.reduce((s, r) => s + (r.total_price || 0), 0);

  res.render("books/renewals", {
    year: activeYear, classes, class_id: class_id||'', students, prices, extras, error: req.query.error||'',
    branches, summaryBranch: summary_branch || '', summaryRows, summaryTotalQty, summaryTotalPrice,
  });
});

router.get("/renewals/summary/export", async (req, res) => {
  const { year, summary_branch } = req.query;
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || 'תשפ"ז';
  const activeYear = year || defaultYear;

  let sql = `
    SELECT e.item_name, COUNT(*) AS quantity, SUM(e.price) AS total_price
    FROM book_order_extras e
    JOIN students s ON e.student_id = s.id
    LEFT JOIN classes c ON s.class_id = c.id
    WHERE e.year_label = ?
  `;
  const params = [activeYear];
  if (summary_branch) {
    sql += " AND c.branch = ?";
    params.push(summary_branch);
  }
  sql += " GROUP BY e.item_name ORDER BY quantity DESC, e.item_name";
  const rows = db.prepare(sql).all(...params);

  const branchLabel = summary_branch || "כל הסניפים";
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("סיכום חידושים", { views: [{ rightToLeft: true }] });
  addExcelHeader(wb, ws, "", `סיכום חידושי ספרים להזמנה — ${activeYear} — ${branchLabel}`, rows.length + 3);
  addLogo(wb, ws, rows.length + 2, 0);

  const headerRow = ws.addRow(["ספר", "כמות להזמנה", "סה\"כ ₪"]);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C5F7C" } };
    cell.alignment = { horizontal: "right", vertical: "middle" };
  });

  let totalQty = 0, totalPrice = 0;
  rows.forEach((r) => {
    ws.addRow([r.item_name, r.quantity, r.total_price || 0]).alignment = { horizontal: "right" };
    totalQty += r.quantity;
    totalPrice += r.total_price || 0;
  });
  const sr = ws.addRow(["סה\"כ", totalQty, totalPrice]);
  sr.font = { bold: true };
  sr.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF4F8" } }; });

  ws.getColumn(1).width = 30;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 14;

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`סיכום-חידושים-${activeYear}-${branchLabel}.xlsx`)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
});

router.post("/renewals", (req, res) => {
  const { year, student_id, item_name, price, notes } = req.body;
  const class_id = req.body.class_id;
  if (!student_id || !item_name || !String(item_name).trim() || price === undefined || price === '' || isNaN(parseFloat(price))) {
    return res.redirect(`/books/renewals?year=${encodeURIComponent(year)}&class_id=${class_id}&error=1`);
  }
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

// ============ מלאי ספרים לפי סניף ============
// ============ בדיקה מקיפה: אילו ספרים בקטלוג/חידושים לא מוצאים התאמה מדויקת ============
// ============ קטלוג ספרים - מקור האמת: שם, הוצאה, מחיר, כיתה (הסניפים נגזרים אוטומטית) ============
router.get("/catalog-manage", (req, res) => {
  const books = db.prepare("SELECT * FROM book_prices ORDER BY item_name").all();
  const assignments = db.prepare("SELECT book_price_id, class_name FROM book_price_grades").all();
  const gradesByBook = {};
  assignments.forEach((a) => {
    if (!gradesByBook[a.book_price_id]) gradesByBook[a.book_price_id] = [];
    gradesByBook[a.book_price_id].push(a.class_name);
  });
  books.forEach((b) => { b.assignedGrades = gradesByBook[b.id] || []; });

  res.render("books/catalog-manage", {
    books, gradeOptions: BOOK_GRADE_OPTIONS,
    saved: req.query.saved === "1", added: parseInt(req.query.added, 10) || 0,
  });
});

router.post("/catalog-manage/save", (req, res) => {
  let ids = req.body.book_price_id || [];
  let itemNames = req.body.item_name || [];
  let publishers = req.body.publisher || [];
  let prices = req.body.price || [];
  let notesArr = req.body.notes || [];
  if (!Array.isArray(ids)) ids = [ids];
  if (!Array.isArray(itemNames)) itemNames = [itemNames];
  if (!Array.isArray(publishers)) publishers = [publishers];
  if (!Array.isArray(prices)) prices = [prices];
  if (!Array.isArray(notesArr)) notesArr = [notesArr];

  const updateBook = db.prepare("UPDATE book_prices SET item_name=?, publisher=?, price=?, notes=?, updated_at=? WHERE id=?");
  const deleteGrades = db.prepare("DELETE FROM book_price_grades WHERE book_price_id = ?");
  const insertGrade = db.prepare("INSERT OR IGNORE INTO book_price_grades (book_price_id, class_name) VALUES (?, ?)");
  const now = new Date().toISOString();

  ids.forEach((id, i) => {
    updateBook.run(
      (itemNames[i] || "").trim() || "ללא שם", (publishers[i] || "").trim() || null,
      parseFloat(prices[i]) || 0, (notesArr[i] || "").trim() || null, now, id
    );
    let selectedGrades = req.body["grades_" + i] || [];
    if (!Array.isArray(selectedGrades)) selectedGrades = [selectedGrades];
    deleteGrades.run(id);
    selectedGrades.forEach((g) => insertGrade.run(id, g));
  });

  syncCatalogFromPrices();

  res.redirect("/books/catalog-manage?saved=1");
});

router.post("/catalog-manage/add", (req, res) => {
  let itemNames = req.body.item_name || [];
  let publishers = req.body.publisher || [];
  let prices = req.body.price || [];
  let notesArr = req.body.notes || [];
  if (!Array.isArray(itemNames)) itemNames = [itemNames];
  if (!Array.isArray(publishers)) publishers = [publishers];
  if (!Array.isArray(prices)) prices = [prices];
  if (!Array.isArray(notesArr)) notesArr = [notesArr];

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO book_prices (item_name, publisher, price, notes, updated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(item_name) DO UPDATE SET price=excluded.price, publisher=excluded.publisher, notes=excluded.notes, updated_at=excluded.updated_at
  `);
  const findId = db.prepare("SELECT id FROM book_prices WHERE item_name = ?");
  const insertGrade = db.prepare("INSERT OR IGNORE INTO book_price_grades (book_price_id, class_name) VALUES (?, ?)");
  let added = 0;
  itemNames.forEach((name, i) => {
    const trimmedName = (name || "").trim();
    if (!trimmedName) return;
    const numPrice = parseFloat(prices[i]) || 0;
    insert.run(trimmedName, (publishers[i] || "").trim(), numPrice, (notesArr[i] || "").trim() || null, now);
    const bookId = findId.get(trimmedName)?.id;
    let selectedGrades = req.body["grades_" + i] || [];
    if (!Array.isArray(selectedGrades)) selectedGrades = [selectedGrades];
    if (bookId) selectedGrades.forEach((g) => insertGrade.run(bookId, g));
    added++;
  });

  syncCatalogFromPrices();

  res.redirect(`/books/catalog-manage?added=${added}`);
});

// מנרמל שם ספר לצורך השוואת דמיון - מסיר סוגריים, גרשיים, ניקוד-פיסוק,
// ומצמצם לרשימת מילים לצורך בדיקת הכלה
function normalizeForSimilarity(name) {
  return name
    .replace(/\([^)]*\)/g, " ") // מסיר תוכן בסוגריים כמו "(כרוך)"
    .replace(/["'׳״]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
// שני שמות נחשבים "כפול אפשרי" רק אם **כל** המילים של השם הקצר מופיעות
// (כולן!) בשם הארוך - לא סתם רוב המילים. זה בדיוק ההבדל בין הבדל של מילת
// תיאור (כרוך, לתלמידים - עדיין נחשב כפול) לבין הבדל של מזהה חלק/כיתה
// אמיתי (חלק 1 מול חלק 2, כיתות א-ג מול ד-ז, סדר מועד מול סדר קדשים - אלה
// ספרים/מוצרים שונים לגמרי, לא כפילות). **מחיר שונה משמעותית** (מעל 15%)
// גם לא נחשב כפול - זה סימן חזק ששתי המהדורות שונות בכוונה (למשל עם/בלי
// פירוש מהרש"א), גם אם השם עצמו לא תמיד מציין את זה במפורש.
function isContainedDuplicate(a, b, priceA, priceB) {
  if (priceA != null && priceB != null && priceA > 0 && priceB > 0) {
    const priceDiffRatio = Math.abs(priceA - priceB) / Math.max(priceA, priceB);
    if (priceDiffRatio > 0.15) return false;
  }

  const wordsA = normalizeForSimilarity(a).split(" ").filter(Boolean);
  const wordsB = normalizeForSimilarity(b).split(" ").filter(Boolean);
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
  const longerSet = new Set(wordsA.length <= wordsB.length ? wordsB : wordsA);
  return shorter.every((w) => longerSet.has(w));
}

// ============ בדיקת בריאות מלאה - לפני הוצאת הזמנה אמיתית לספק ============
// ============ דוח תלמידים שלא הזמינו כלל ספרים (מחולק לפי כיתות) ============
function getStudentsWithNoOrders(year) {
  return db.prepare(`
    SELECT s.id, s.first_name, s.last_name, c.name AS class_name, c.parallel AS class_parallel, c.branch,
           f.father_name, f.home_phone, f.father_mobile, f.mother_mobile
    FROM students s
    JOIN classes c ON s.class_id = c.id
    LEFT JOIN families f ON s.family_id = f.id
    WHERE s.status = 'פעיל'
      AND c.name IN (${BOOK_GRADE_OPTIONS.map(() => "?").join(",")})
      AND NOT EXISTS (
        SELECT 1 FROM book_orders bo
        JOIN book_catalog bc ON bo.catalog_id = bc.id
        WHERE bo.student_id = s.id AND bc.year_label = ?
      )
    ORDER BY c.name, c.parallel, s.last_name, s.first_name
  `).all(...BOOK_GRADE_OPTIONS, year);
}

router.get("/reports/no-orders", (req, res) => {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;
  const students = getStudentsWithNoOrders(year);

  const grouped = {};
  students.forEach((s) => {
    const key = `${s.class_name}${s.class_parallel ? " " + s.class_parallel : ""}${s.branch ? " (" + s.branch + ")" : ""}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(s);
  });

  res.render("books/no-orders-report", { year, years, grouped, total: students.length });
});

router.get("/reports/no-orders/export", async (req, res) => {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;
  const students = getStudentsWithNoOrders(year);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("לא הזמינו ספרים");
  ws.views = [{ rightToLeft: true }];
  ws.columns = [
    { header: "כיתה", key: "class", width: 20 },
    { header: "שם התלמיד", key: "name", width: 22 },
    { header: "שם האב", key: "father", width: 20 },
    { header: "טלפון בית", key: "home_phone", width: 14 },
    { header: "נייד אב", key: "father_mobile", width: 14 },
    { header: "נייד אם", key: "mother_mobile", width: 14 },
  ];
  ws.getRow(1).font = { bold: true };
  students.forEach((s) => {
    ws.addRow({
      class: `${s.class_name}${s.class_parallel ? " " + s.class_parallel : ""}${s.branch ? " (" + s.branch + ")" : ""}`,
      name: `${s.first_name} ${s.last_name}`,
      father: s.father_name || "",
      home_phone: s.home_phone || "",
      father_mobile: s.father_mobile || "",
      mother_mobile: s.mother_mobile || "",
    });
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="לא-הזמינו-ספרים-${year}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

router.get("/inventory/health-check", (req, res) => {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;

  // 1) סה"כ הזמנות בפועל לשנה זו - מספר גולמי לבדיקת עין מול מה שאתה זוכר/מצפה
  const totalOrders = db.prepare(`
    SELECT COUNT(*) c FROM book_orders bo
    JOIN book_catalog bc ON bo.catalog_id = bc.id
    WHERE bc.year_label = ?
  `).get(year).c;
  const totalExtras = db.prepare("SELECT COUNT(*) c FROM book_order_extras WHERE year_label = ?").get(year).c;

  // 2) כפילות ממש בקטלוג (אותו שם, אותה כיתה, אותה שנה - יותר משורה אחת)
  const duplicateCatalogRows = db.prepare(`
    SELECT class_name, item_name, COUNT(*) AS row_count, GROUP_CONCAT(id) AS ids
    FROM book_catalog WHERE year_label = ?
    GROUP BY class_name, item_name HAVING COUNT(*) > 1
  `).all(year).map((r) => {
    const ids = r.ids.split(",").map(Number);
    const orderCounts = ids.map((cid) => ({
      catalog_id: cid,
      order_count: db.prepare("SELECT COUNT(*) c FROM book_orders WHERE catalog_id = ?").get(cid).c,
    }));
    return { class_name: r.class_name, item_name: r.item_name, rows: orderCounts };
  });

  // 3) ספרים בכיתה שכבר לא משויכת, עם הזמנות אמיתיות (ממתין להחלטה ידנית)
  const allPriceNames = db.prepare("SELECT item_name FROM book_prices").all().map(r => r.item_name);
  const orphanedWithOrders = db.prepare(`
    SELECT bc.id AS catalog_id, bc.item_name, bc.class_name, COUNT(bo.student_id) AS order_count, c.id AS class_id
    FROM book_catalog bc
    JOIN book_orders bo ON bo.catalog_id = bc.id
    JOIN book_prices bp ON TRIM(bp.item_name) = TRIM(bc.item_name)
    LEFT JOIN classes c ON c.name = bc.class_name
    WHERE bc.year_label = ?
      AND NOT EXISTS (SELECT 1 FROM book_price_grades bpg WHERE bpg.book_price_id = bp.id AND bpg.class_name = bc.class_name)
    GROUP BY bc.id
  `).all(year);

  // 4) שמות בקטלוג/חידושים שלא תואמים לאף רשומה במחירון (הזמנות "אבודות" מבחינת המלאי)
  const catalogMismatches = db.prepare(`
    SELECT DISTINCT bc.item_name, bc.class_name, COUNT(bo.student_id) AS order_count
    FROM book_catalog bc
    LEFT JOIN book_orders bo ON bo.catalog_id = bc.id AND bo.year_label = bc.year_label
    WHERE bc.year_label = ? GROUP BY bc.item_name, bc.class_name
  `).all(year).filter(r => !allPriceNames.includes(r.item_name));
  const extrasMismatches = db.prepare(`
    SELECT item_name, COUNT(*) AS order_count FROM book_order_extras WHERE year_label = ? GROUP BY item_name
  `).all(year).filter(r => !allPriceNames.includes(r.item_name));

  // 5) ספר משויך לכיתה (דרך שיוך ספר לכיתה) אבל אין לו בכלל שורת קטלוג לשנה
  // הזו - יכול לקרות אם הסנכרון לא הספיק לרוץ. "חסר" הפוך מ"עודף".
  const missingCatalogEntries = db.prepare(`
    SELECT bp.item_name, bpg.class_name
    FROM book_price_grades bpg
    JOIN book_prices bp ON bp.id = bpg.book_price_id
    WHERE NOT EXISTS (
      SELECT 1 FROM book_catalog bc WHERE bc.year_label = ? AND bc.class_name = bpg.class_name AND TRIM(bc.item_name) = TRIM(bp.item_name)
    )
  `).all(year);

  // 6) סיכום לפי כיתה - כמה ספרים שונים, כמה הזמנות סה"כ, כמה תלמידים פעילים
  // - כדי לתפוס בעין כיתה עם מעט מדי הזמנות ביחס למספר התלמידים בה (חשד לעמודות חסרות)
  const perClassSummary = db.prepare(`
    SELECT bc.class_name,
      COUNT(DISTINCT bc.item_name) AS book_count,
      (SELECT COUNT(*) FROM book_orders bo JOIN book_catalog bc2 ON bo.catalog_id = bc2.id WHERE bc2.class_name = bc.class_name AND bc2.year_label = ?) AS total_orders
    FROM book_catalog bc
    WHERE bc.year_label = ?
    GROUP BY bc.class_name
  `).all(year, year).map((row) => {
    const studentCount = db.prepare(`
      SELECT COUNT(*) c FROM students s LEFT JOIN classes c ON s.class_id = c.id
      WHERE c.name = ? AND s.status = 'פעיל'
    `).get(row.class_name).c;
    return { ...row, student_count: studentCount };
  });

  // 7) ספרים כפולים אפשריים במחירון (שמות שונים, אבל ככל הנראה אותו ספר בפועל)
  function normalizeForSimilarity(name) {
    return name.replace(/\([^)]*\)/g, " ").replace(/["'׳״]/g, "").replace(/\s+/g, " ").trim();
  }
  function isContainedDuplicate(a, b, priceA, priceB) {
    if (priceA != null && priceB != null && priceA > 0 && priceB > 0) {
      const priceDiffRatio = Math.abs(priceA - priceB) / Math.max(priceA, priceB);
      if (priceDiffRatio > 0.15) return false;
    }
    const wordsA = normalizeForSimilarity(a).split(" ").filter(Boolean);
    const wordsB = normalizeForSimilarity(b).split(" ").filter(Boolean);
    if (wordsA.length === 0 || wordsB.length === 0) return false;
    const shorter = wordsA.length <= wordsB.length ? wordsA : wordsB;
    const longerSet = new Set(wordsA.length <= wordsB.length ? wordsB : wordsA);
    return shorter.every((w) => longerSet.has(w));
  }
  const allPrices = db.prepare("SELECT id, item_name, publisher, price FROM book_prices ORDER BY item_name").all();
  const possibleDuplicates = [];
  const seen = new Set();
  for (let i = 0; i < allPrices.length; i++) {
    for (let j = i + 1; j < allPrices.length; j++) {
      const a = allPrices[i], b = allPrices[j];
      if (isContainedDuplicate(a.item_name, b.item_name, a.price, b.price)) {
        const key = [a.id, b.id].sort().join("-");
        if (seen.has(key)) continue;
        seen.add(key);
        possibleDuplicates.push({ a, b });
      }
    }
  }

  const issueCount = duplicateCatalogRows.length + orphanedWithOrders.length + catalogMismatches.length
    + extrasMismatches.length + missingCatalogEntries.length + possibleDuplicates.length;

  res.render("books/inventory-health-check", {
    year, years, totalOrders, totalExtras, duplicateCatalogRows, orphanedWithOrders,
    catalogMismatches, extrasMismatches, missingCatalogEntries, perClassSummary,
    possibleDuplicates, issueCount,
  });
});

router.get("/inventory/diagnostics", (req, res) => {
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;

  const allPrices = db.prepare("SELECT id, item_name, publisher, price FROM book_prices ORDER BY item_name").all();
  const allPriceNames = allPrices.map(r => r.item_name);
  const priceNamesTrimmed = new Set(allPriceNames.map(n => n.trim()));

  // ספרי קטלוג (הזמנות רגילות) לשנה זו שאין להם התאמה מדויקת במחירון
  const catalogMismatches = db.prepare(`
    SELECT DISTINCT bc.item_name, bc.class_name, bc.publisher, bc.price, COUNT(bo.student_id) AS order_count
    FROM book_catalog bc
    LEFT JOIN book_orders bo ON bo.catalog_id = bc.id AND bo.year_label = bc.year_label
    WHERE bc.year_label = ?
    GROUP BY bc.item_name, bc.class_name
  `).all(year).filter(r => !allPriceNames.includes(r.item_name)).map(r => ({
    ...r,
    closeMatch: priceNamesTrimmed.has(r.item_name.trim()) ? "(רק רווחים מיותרים - זוהה ותוקן אוטומטית)" : "",
  }));

  // חידושים (book_order_extras) לשנה זו שאין להם התאמה מדויקת במחירון
  const extrasMismatches = db.prepare(`
    SELECT item_name, price, COUNT(*) AS order_count
    FROM book_order_extras
    WHERE year_label = ?
    GROUP BY item_name
  `).all(year).filter(r => !allPriceNames.includes(r.item_name)).map(r => ({
    ...r,
    closeMatch: priceNamesTrimmed.has(r.item_name.trim()) ? "(רק רווחים מיותרים - זוהה ותוקן אוטומטית)" : "",
  }));

  // ספרים כפולים אפשריים במחירון עצמו - שני שמות שונים, אבל דומים מאוד
  // (למשל "משנה ברורה חלק ו'" מול "משנה ברורה חלק ו' (כרוך)") - כל אחד בפני
  // עצמו נמצא במחירון (לכן לא נתפס כ"אי-התאמה"), אבל ההזמנות מתפצלות ביניהם.
  const possibleDuplicates = [];
  const seen = new Set();
  for (let i = 0; i < allPrices.length; i++) {
    for (let j = i + 1; j < allPrices.length; j++) {
      const a = allPrices[i], b = allPrices[j];
      if (isContainedDuplicate(a.item_name, b.item_name, a.price, b.price)) {
        const key = [a.id, b.id].sort().join("-");
        if (seen.has(key)) continue;
        seen.add(key);
        possibleDuplicates.push({ a, b });
      }
    }
  }

  // כפילויות ממש בתוך קטלוג ההזמנה עצמו - אותו שם ספר מופיע יותר מפעם אחת
  // עבור אותה כיתה ואותה שנה (יכול לקרות למשל אחרי מיזוג במחירון, אם שתי
  // רשומות שונות התכנסו לאותו שם, אבל שתי שורות הקטלוג בפועל לא אוחדו).
  // זה גורם להזמנות להתפצל בין שתי שורות קטלוג עם אותו שם, ולעמוד ההזמנה
  // של הכיתה להראות את הספר פעמיים.
  const duplicateCatalogRows = db.prepare(`
    SELECT class_name, item_name, COUNT(*) AS row_count, GROUP_CONCAT(id) AS ids
    FROM book_catalog
    WHERE year_label = ?
    GROUP BY class_name, item_name
    HAVING COUNT(*) > 1
  `).all(year).map((r) => {
    const ids = r.ids.split(",").map(Number);
    const orderCounts = ids.map((cid) => ({
      catalog_id: cid,
      order_count: db.prepare("SELECT COUNT(*) c FROM book_orders WHERE catalog_id = ?").get(cid).c,
    }));
    return { class_name: r.class_name, item_name: r.item_name, rows: orderCounts };
  });

  // ספר בקטלוג של כיתה מסוימת, כשהספר כבר לא משויך לכיתה הזו (דרך "שיוך ספר
  // לכיתה") - אבל יש עליו הזמנה אמיתית! המערכת לא מוחקת שורות כאלה לבד (כדי
  // לא לאבד הזמנה של תלמיד), אז זו החלטה שרק המשרד יכול לקבל: להשאיר את
  // הכיתה הזו משויכת (אם זה בעצם נכון), או לטפל בהזמנה הספציפית ידנית.
  const orphanedWithOrders = db.prepare(`
    SELECT bc.id AS catalog_id, bc.item_name, bc.class_name, COUNT(bo.student_id) AS order_count,
           c.id AS class_id
    FROM book_catalog bc
    JOIN book_orders bo ON bo.catalog_id = bc.id
    JOIN book_prices bp ON TRIM(bp.item_name) = TRIM(bc.item_name)
    LEFT JOIN classes c ON c.name = bc.class_name
    WHERE bc.year_label = ?
      AND NOT EXISTS (
        SELECT 1 FROM book_price_grades bpg WHERE bpg.book_price_id = bp.id AND bpg.class_name = bc.class_name
      )
    GROUP BY bc.id
  `).all(year);

  res.render("books/inventory-diagnostics", { years, year, catalogMismatches, extrasMismatches, allPriceNames, possibleDuplicates, duplicateCatalogRows, orphanedWithOrders });
});

// "השאר את הספר משויך לכיתה הזו" - מוסיף את הכיתה בחזרה לשיוך של הספר,
// כדי שהזמנה קיימת שכבר יש עליה תישאר תקינה והגיונית (הספר יופיע שוב
// כרשמי בעמוד ההזמנה של אותה כיתה, ויתעדכן גם בקטלוג לשאר השנים/כיתות).
router.post("/inventory/diagnostics/keep-class-assignment", (req, res) => {
  const { item_name, class_name, year: yr } = req.body;
  const book = db.prepare("SELECT id FROM book_prices WHERE TRIM(item_name) = TRIM(?)").get(item_name);
  if (book) {
    db.prepare("INSERT OR IGNORE INTO book_price_grades (book_price_id, class_name) VALUES (?, ?)").run(book.id, class_name);
  }
  res.redirect(`/books/inventory/diagnostics?year=${encodeURIComponent(yr || "")}`);
});

// איחוד שורות קטלוג כפולות (אותו שם, אותה כיתה, אותה שנה) - מעבירים את כל
// ההזמנות משורת הקטלוג הכפולה לשורה השורדת, ומוחקים את הכפולה.
router.post("/inventory/diagnostics/merge-catalog-rows", (req, res) => {
  const { keep_catalog_id, year: yr } = req.body;
  let removeIds = req.body.remove_catalog_id || [];
  if (!Array.isArray(removeIds)) removeIds = [removeIds];
  db.exec("BEGIN TRANSACTION");
  try {
    removeIds.forEach((removeId) => {
      db.prepare("UPDATE book_orders SET catalog_id = ? WHERE catalog_id = ?").run(keep_catalog_id, removeId);
      db.prepare("DELETE FROM book_catalog WHERE id = ?").run(removeId);
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  res.redirect(`/books/inventory/diagnostics?year=${encodeURIComponent(yr || "")}`);
});

// מיזוג שני ספרים כפולים למחירון אחד: משנים את כל ההזמנות/חידושים שהיו
// תחת השם שנמחק לשם השורד, מעבירים שיוכי כיתה, מסכמים מלאי בפועל (לא
// מוחקים כמות אמיתית!) - ומוחקים את הרשומה הכפולה.
router.post("/inventory/diagnostics/merge-books", (req, res) => {
  const { keep_id, remove_id, year: yr } = req.body;
  const keep = db.prepare("SELECT * FROM book_prices WHERE id = ?").get(keep_id);
  const remove = db.prepare("SELECT * FROM book_prices WHERE id = ?").get(remove_id);
  if (!keep || !remove || keep.id === remove.id) {
    return res.redirect(`/books/inventory/diagnostics?year=${encodeURIComponent(yr || "")}`);
  }

  db.exec("BEGIN TRANSACTION");
  try {
    // 1) מעבירים כל הזמנה/חידוש שהיה בשם שנמחק, לשם השורד
    db.prepare("UPDATE book_catalog SET item_name = ? WHERE TRIM(item_name) = TRIM(?)").run(keep.item_name, remove.item_name);
    db.prepare("UPDATE book_order_extras SET item_name = ? WHERE TRIM(item_name) = TRIM(?)").run(keep.item_name, remove.item_name);

    // 1ב) השינוי לעיל עלול ליצור שתי שורות קטלוג זהות (אותה כיתה+שנה+שם) -
    // מאחדים מיד: מעבירים את כל ההזמנות לשורה הראשונה שנוצרה, ומוחקים את השאר,
    // כדי שהספר לא יופיע כפול בעמוד ההזמנה של הכיתה.
    const dupGroups = db.prepare(`
      SELECT class_name, item_name, GROUP_CONCAT(id) AS ids FROM book_catalog
      WHERE TRIM(item_name) = TRIM(?)
      GROUP BY class_name, item_name
      HAVING COUNT(*) > 1
    `).all(keep.item_name);
    dupGroups.forEach((g) => {
      const ids = g.ids.split(",").map(Number).sort((x, y) => x - y);
      const survivorId = ids[0];
      ids.slice(1).forEach((dupId) => {
        db.prepare("UPDATE book_orders SET catalog_id = ? WHERE catalog_id = ?").run(survivorId, dupId);
        db.prepare("DELETE FROM book_catalog WHERE id = ?").run(dupId);
      });
    });

    // 2) מעבירים שיוכי כיתה שלא כבר קיימים אצל השורד
    const removeGrades = db.prepare("SELECT class_name FROM book_price_grades WHERE book_price_id = ?").all(remove_id);
    const insertGrade = db.prepare("INSERT OR IGNORE INTO book_price_grades (book_price_id, class_name) VALUES (?, ?)");
    removeGrades.forEach((g) => insertGrade.run(keep_id, g.class_name));
    db.prepare("DELETE FROM book_price_grades WHERE book_price_id = ?").run(remove_id);

    // 3) מסכמים מלאי בפועל (לא מאבדים כמות אמיתית שנספרה) - לכל סניף בנפרד
    const removeStocks = db.prepare("SELECT * FROM book_inventory WHERE book_price_id = ?").all(remove_id);
    removeStocks.forEach((s) => {
      const existing = db.prepare("SELECT * FROM book_inventory WHERE book_price_id = ? AND branch = ?").get(keep_id, s.branch);
      if (existing) {
        db.prepare("UPDATE book_inventory SET current_stock = ? WHERE id = ?").run(existing.current_stock + s.current_stock, existing.id);
      } else {
        db.prepare("INSERT INTO book_inventory (book_price_id, branch, current_stock, extra_quantity, updated_at) VALUES (?,?,?,?,?)")
          .run(keep_id, s.branch, s.current_stock, s.extra_quantity, new Date().toISOString());
      }
    });
    db.prepare("DELETE FROM book_inventory WHERE book_price_id = ?").run(remove_id);

    // 4) מוחקים את הרשומה הכפולה מהמחירון
    db.prepare("DELETE FROM book_prices WHERE id = ?").run(remove_id);

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  res.redirect(`/books/inventory/diagnostics?year=${encodeURIComponent(yr || "")}`);
});


// פתרון אי-התאמה: "זה בעצם הספר X מהמחירון" - משנים את שם פריט הקטלוג
// (בכל השנים) כך שיתאים בדיוק למחירון. לא נוגעים בהזמנות עצמן (הן מקושרות
// ל-catalog_id, לא לשם), רק בטקסט השם.
router.post("/inventory/diagnostics/rename-catalog", (req, res) => {
  const { old_name, new_name, year: yr } = req.body;
  if (old_name && new_name) {
    db.prepare("UPDATE book_catalog SET item_name = ? WHERE item_name = ?").run(new_name, old_name);
  }
  res.redirect(`/books/inventory/diagnostics?year=${encodeURIComponent(yr || "")}`);
});

router.post("/inventory/diagnostics/rename-extra", (req, res) => {
  const { old_name, new_name, year: yr } = req.body;
  if (old_name && new_name) {
    db.prepare("UPDATE book_order_extras SET item_name = ? WHERE item_name = ?").run(new_name, old_name);
  }
  res.redirect(`/books/inventory/diagnostics?year=${encodeURIComponent(yr || "")}`);
});

// פתרון אי-התאמה: "זה ספר חדש - תוסיף אותו למחירון בשם הזה בדיוק" - יוצר
// רשומת מחירון חדשה עם השם המדויק שכבר בשימוש בקטלוג/בחידוש, ומעתיק מחיר
// והוצאה מהרשומה הקיימת. אם יש class_name (מקטלוג) - משייך גם לכיתה הזו מיד.
router.post("/inventory/diagnostics/add-as-new", (req, res) => {
  const { item_name, publisher, price, class_name, year: yr } = req.body;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO book_prices (item_name, publisher, price, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(item_name) DO NOTHING
  `).run(item_name, publisher || "", parseFloat(price) || 0, now);
  if (class_name) {
    const bookId = db.prepare("SELECT id FROM book_prices WHERE item_name = ?").get(item_name)?.id;
    if (bookId) db.prepare("INSERT OR IGNORE INTO book_price_grades (book_price_id, class_name) VALUES (?, ?)").run(bookId, class_name);
  }
  syncCatalogFromPrices();
  res.redirect(`/books/inventory/diagnostics?year=${encodeURIComponent(yr || "")}`);
});

router.get("/inventory", (req, res) => {
  const classBranches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL AND branch<>'' ORDER BY branch").all().map(r => r.branch);
  const ALL_BRANCHES = ["סוקולוב", "נפחא", "בן פתחיה"];
  const branches = Array.from(new Set([...ALL_BRANCHES, ...classBranches]));
  const branch = req.query.branch || branches[0] || "";
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;

  // מסנכרנים שם/מחיר/הוצאה בין הקטלוג לקטלוג ההזמנה בכל טעינה - כך שכל שינוי
  // במחירון מתעדכן אוטומטית בלי פעולה נוספת.
  syncCatalogFromPrices();

  const items = db.prepare(`
    SELECT bp.id AS book_price_id, bp.item_name, bp.publisher, bp.notes, bp.price,
           COALESCE(bi.current_stock, 0) AS current_stock,
           COALESCE(bi.extra_quantity, 5) AS extra_quantity,
           (
             (SELECT COUNT(*) FROM book_orders bo
              JOIN book_catalog bc ON bo.catalog_id = bc.id AND TRIM(bc.item_name) = TRIM(bp.item_name) AND bc.year_label = ?
              JOIN students s ON bo.student_id = s.id
              LEFT JOIN classes c ON s.class_id = c.id
              WHERE COALESCE(c.branch, s.branch) = ?)
             +
             (SELECT COUNT(*) FROM book_order_extras e
              JOIN students s2 ON e.student_id = s2.id
              LEFT JOIN classes c2 ON s2.class_id = c2.id
              WHERE TRIM(e.item_name) = TRIM(bp.item_name) AND e.year_label = ? AND COALESCE(c2.branch, s2.branch) = ?)
           ) AS ordered_count
    FROM book_prices bp
    LEFT JOIN book_inventory bi ON bi.book_price_id = bp.id AND bi.branch = ?
    WHERE EXISTS (
      SELECT 1 FROM book_price_grades bpg
      JOIN classes cx ON cx.name = bpg.class_name AND cx.branch = ?
      WHERE bpg.book_price_id = bp.id
    )
    ORDER BY bp.item_name
  `).all(year, branch, year, branch, branch, branch).map((it) => ({
    ...it,
    to_order: it.ordered_count + it.extra_quantity - it.current_stock,
  }));

  res.render("books/inventory", {
    branches, branch, years, year, items,
    saved: req.query.saved === "1", added: parseInt(req.query.added, 10) || 0,
  });
});

router.get("/inventory/print", (req, res) => {
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL AND branch<>'' ORDER BY branch").all().map(r => r.branch);
  const branch = req.query.branch || branches[0] || "";
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;

  const items = db.prepare(`
    SELECT bp.item_name, bp.publisher, bp.notes,
           COALESCE(bi.current_stock, 0) AS current_stock,
           COALESCE(bi.extra_quantity, 5) AS extra_quantity,
           (
             (SELECT COUNT(*) FROM book_orders bo
              JOIN book_catalog bc ON bo.catalog_id = bc.id AND TRIM(bc.item_name) = TRIM(bp.item_name) AND bc.year_label = ?
              JOIN students s ON bo.student_id = s.id
              LEFT JOIN classes c ON s.class_id = c.id
              WHERE COALESCE(c.branch, s.branch) = ?)
             +
             (SELECT COUNT(*) FROM book_order_extras e
              JOIN students s2 ON e.student_id = s2.id
              LEFT JOIN classes c2 ON s2.class_id = c2.id
              WHERE TRIM(e.item_name) = TRIM(bp.item_name) AND e.year_label = ? AND COALESCE(c2.branch, s2.branch) = ?)
           ) AS ordered_count
    FROM book_prices bp
    LEFT JOIN book_inventory bi ON bi.book_price_id = bp.id AND bi.branch = ?
    WHERE EXISTS (
      SELECT 1 FROM book_price_grades bpg
      JOIN classes cx ON cx.name = bpg.class_name AND cx.branch = ?
      WHERE bpg.book_price_id = bp.id
    )
    ORDER BY bp.item_name
  `).all(year, branch, year, branch, branch, branch).map((it) => ({
    ...it,
    to_order: Math.max(0, it.ordered_count + it.extra_quantity - it.current_stock),
  }));

  const headers = ["ספר", "הוצאה", "הערות", "מלאי לפי המערכת", "כמות להזמנה", "ספירה בפועל (למילוי ידני)"];
  const rows = items.map(it => [it.item_name, it.publisher || "", it.notes || "", it.current_stock, it.to_order, ""]);

  res.render("reports/print-view", { title: `דוח ספירת מלאי ספרים${branch ? " - " + branch : ""}`, headers, rows });
});

router.post("/inventory/save", (req, res) => {
  const { branch, year } = req.body;
  let ids = req.body.book_price_id || [];
  let currentStocks = req.body.current_stock || [];
  let extraQuantities = req.body.extra_quantity || [];
  if (!Array.isArray(ids)) ids = [ids];
  if (!Array.isArray(currentStocks)) currentStocks = [currentStocks];
  if (!Array.isArray(extraQuantities)) extraQuantities = [extraQuantities];

  const upsert = db.prepare(`
    INSERT INTO book_inventory (book_price_id, branch, current_stock, extra_quantity, updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(book_price_id, branch) DO UPDATE SET
      current_stock = excluded.current_stock,
      extra_quantity = excluded.extra_quantity,
      updated_at = excluded.updated_at
  `);
  const now = new Date().toISOString();
  ids.forEach((id, i) => {
    upsert.run(id, branch, parseInt(currentStocks[i], 10) || 0, parseInt(extraQuantities[i], 10) || 0, now);
  });

  res.redirect(`/books/inventory?branch=${encodeURIComponent(branch)}&year=${encodeURIComponent(year || "")}&saved=1`);
});

// ============ הזמנת ספרים מהספק - חישוב אוטומטי: הוזמן בפועל + תוספת פחות מלאי נוכחי ============
router.get("/inventory/order", (req, res) => {
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL AND branch<>'' ORDER BY branch").all().map(r => r.branch);
  const branch = req.query.branch || branches[0] || "";
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;

  const rows = db.prepare(`
    SELECT bp.item_name, bp.publisher, bp.price,
           COALESCE(bi.current_stock, 0) AS current_stock,
           COALESCE(bi.extra_quantity, 5) AS extra_quantity,
           (
             (SELECT COUNT(*) FROM book_orders bo
              JOIN book_catalog bc ON bo.catalog_id = bc.id AND TRIM(bc.item_name) = TRIM(bp.item_name) AND bc.year_label = ?
              JOIN students s ON bo.student_id = s.id
              LEFT JOIN classes c ON s.class_id = c.id
              WHERE COALESCE(c.branch, s.branch) = ?)
             +
             (SELECT COUNT(*) FROM book_order_extras e
              JOIN students s2 ON e.student_id = s2.id
              LEFT JOIN classes c2 ON s2.class_id = c2.id
              WHERE TRIM(e.item_name) = TRIM(bp.item_name) AND e.year_label = ? AND COALESCE(c2.branch, s2.branch) = ?)
           ) AS ordered_count
    FROM book_prices bp
    LEFT JOIN book_inventory bi ON bi.book_price_id = bp.id AND bi.branch = ?
    WHERE EXISTS (
      SELECT 1 FROM book_price_grades bpg
      JOIN classes cx ON cx.name = bpg.class_name AND cx.branch = ?
      WHERE bpg.book_price_id = bp.id
    )
    ORDER BY bp.item_name
  `).all(year, branch, year, branch, branch, branch)
    .map((r) => ({ ...r, to_order: r.ordered_count + r.extra_quantity - r.current_stock }))
    .filter((r) => r.to_order > 0);

  const grandQty = rows.reduce((s, r) => s + r.to_order, 0);

  res.render("books/inventory-order", { branches, branch, years, year, rows, grandQty });
});

// כתובות אספקה לפי סניף - מוצג בטופס ההזמנה הסופי לספק
const DELIVERY_ADDRESS_BY_BRANCH = {
  "סוקולוב": "סוקולוב 5 בני ברק",
  "נפחא": "יצחק נפחא 7 בני ברק",
  "בן פתחיה": "בן פתחיה 8 בני ברק",
};

router.get("/inventory/order/export-pdf", (req, res) => {
  const { branch } = req.query;
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;

  const rows = db.prepare(`
    SELECT bp.item_name, bp.publisher,
           COALESCE(bi.current_stock, 0) AS current_stock,
           COALESCE(bi.extra_quantity, 5) AS extra_quantity,
           (
             (SELECT COUNT(*) FROM book_orders bo
              JOIN book_catalog bc ON bo.catalog_id = bc.id AND TRIM(bc.item_name) = TRIM(bp.item_name) AND bc.year_label = ?
              JOIN students s ON bo.student_id = s.id
              LEFT JOIN classes c ON s.class_id = c.id
              WHERE COALESCE(c.branch, s.branch) = ?)
             +
             (SELECT COUNT(*) FROM book_order_extras e
              JOIN students s2 ON e.student_id = s2.id
              LEFT JOIN classes c2 ON s2.class_id = c2.id
              WHERE TRIM(e.item_name) = TRIM(bp.item_name) AND e.year_label = ? AND COALESCE(c2.branch, s2.branch) = ?)
           ) AS ordered_count
    FROM book_prices bp
    LEFT JOIN book_inventory bi ON bi.book_price_id = bp.id AND bi.branch = ?
    WHERE EXISTS (
      SELECT 1 FROM book_price_grades bpg
      JOIN classes cx ON cx.name = bpg.class_name AND cx.branch = ?
      WHERE bpg.book_price_id = bp.id
    )
    ORDER BY bp.item_name
  `).all(year, branch, year, branch, branch, branch)
    .map((r) => ({ ...r, to_order: r.ordered_count + r.extra_quantity - r.current_stock }))
    .filter((r) => r.to_order > 0);

  const grandQty = rows.reduce((s, r) => s + r.to_order, 0);
  const today = hd.serialToHebrewString(hd.todayAccessSerial());
  const deliveryAddress = DELIVERY_ADDRESS_BY_BRANCH[branch] || `${branch || ""} בני ברק`;

  res.render("books/order-final", { branch, rows, grandQty, today, deliveryAddress });
});

router.get("/inventory/order/export", async (req, res) => {
  const { branch } = req.query;
  const years = db.prepare("SELECT DISTINCT year_label FROM book_catalog ORDER BY year_label DESC").all().map(r => r.year_label);
  const defaultYear = db.prepare("SELECT value FROM settings WHERE key='current_hebrew_year'").get()?.value || years[0] || 'תשפ"ז';
  const year = req.query.year || defaultYear;

  const rows = db.prepare(`
    SELECT bp.item_name, bp.publisher,
           COALESCE(bi.current_stock, 0) AS current_stock,
           COALESCE(bi.extra_quantity, 5) AS extra_quantity,
           (
             (SELECT COUNT(*) FROM book_orders bo
              JOIN book_catalog bc ON bo.catalog_id = bc.id AND TRIM(bc.item_name) = TRIM(bp.item_name) AND bc.year_label = ?
              JOIN students s ON bo.student_id = s.id
              LEFT JOIN classes c ON s.class_id = c.id
              WHERE COALESCE(c.branch, s.branch) = ?)
             +
             (SELECT COUNT(*) FROM book_order_extras e
              JOIN students s2 ON e.student_id = s2.id
              LEFT JOIN classes c2 ON s2.class_id = c2.id
              WHERE TRIM(e.item_name) = TRIM(bp.item_name) AND e.year_label = ? AND COALESCE(c2.branch, s2.branch) = ?)
           ) AS ordered_count
    FROM book_prices bp
    LEFT JOIN book_inventory bi ON bi.book_price_id = bp.id AND bi.branch = ?
    WHERE EXISTS (
      SELECT 1 FROM book_price_grades bpg
      JOIN classes cx ON cx.name = bpg.class_name AND cx.branch = ?
      WHERE bpg.book_price_id = bp.id
    )
    ORDER BY bp.item_name
  `).all(year, branch, year, branch, branch, branch)
    .map((r) => ({ ...r, to_order: r.ordered_count + r.extra_quantity - r.current_stock }))
    .filter((r) => r.to_order > 0);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("הזמנה מהספק", { views: [{ rightToLeft: true }] });
  addExcelHeader(wb, ws, "", `הזמנת ספרים מהספק - סניף ${branch}`, rows.length + 4);
  addLogo(wb, ws, rows.length + 3, 0);

  const hr = ws.addRow(["ספר", "הוצאה", "כמות"]);
  hr.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2C5F7C" } };
    cell.alignment = { horizontal: "right" };
  });

  let grandQty = 0;
  rows.forEach((r) => {
    ws.addRow([r.item_name, r.publisher || "", r.to_order]).alignment = { horizontal: "right" };
    grandQty += r.to_order;
  });
  const sr = ws.addRow(["סה\"כ", "", grandQty]);
  sr.font = { bold: true };
  sr.eachCell((cell) => { cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF4F8" } }; });

  [32, 20, 12].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`הזמנה-מהספק-${branch}.xlsx`)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res); res.end();
});

module.exports = router;

// ============ מחירון בסיס ============
