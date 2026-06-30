const express = require("express");
const router = express.Router();
const db = require("../db");
const { calcAllFamiliesTuition } = require("../tuitionCalc");

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
