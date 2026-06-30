const express = require("express");
const router = express.Router();
const db = require("../db");
const { buildOrderBy } = require("../sortHelper");

router.get("/", (req, res) => {
  const { q, category, status } = req.query;
  let sql = "SELECT * FROM suppliers WHERE 1=1";
  const params = [];
  if (q) {
    sql += " AND (name LIKE ? OR contact_person LIKE ? OR phone LIKE ? OR email LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }
  if (status) {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " " + buildOrderBy(
    req,
    { name: "name", category: "category", contact_person: "contact_person", phone: "phone", status: "status" },
    "ORDER BY name"
  );
  const suppliers = db.prepare(sql).all(...params);
  const categories = db.prepare("SELECT DISTINCT category FROM suppliers WHERE category IS NOT NULL ORDER BY category").all();

  res.render("suppliers/list", {
    suppliers, categories, q: q || "", category: category || "", status: status || "",
    sort: req.query.sort || "", dir: req.query.dir || "",
  });
});

router.get("/new", (req, res) => {
  res.render("suppliers/form", { supplier: {}, mode: "new" });
});

const SUPPLIER_FIELDS = ["name", "category", "contact_person", "phone", "email", "address", "notes", "status"];

router.post("/", (req, res) => {
  const body = req.body;
  const cols = SUPPLIER_FIELDS.filter((c) => c in body);
  const values = cols.map((c) => (body[c] === "" ? null : body[c]));
  const info = db
    .prepare(`INSERT INTO suppliers (${cols.join(",")}, created_at) VALUES (${cols.map(() => "?").join(",")}, ?)`)
    .run(...values, new Date().toISOString());
  res.redirect(`/suppliers/${info.lastInsertRowid}`);
});

router.get("/:id", (req, res) => {
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!supplier) return res.status(404).render("404");
  const hd = require("../hebrewDate");
  const expenses = db
    .prepare("SELECT * FROM expenses WHERE supplier_id = ? ORDER BY expense_date DESC")
    .all(req.params.id)
    .map((e) => ({ ...e, expense_date_str: hd.serialToGregorianString(e.expense_date) }));
  const totalSpent = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  res.render("suppliers/view", { supplier, expenses, totalSpent });
});

router.get("/:id/edit", (req, res) => {
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!supplier) return res.status(404).render("404");
  res.render("suppliers/form", { supplier, mode: "edit" });
});

router.put("/:id", (req, res) => {
  const body = req.body;
  const cols = SUPPLIER_FIELDS.filter((c) => c in body);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => (body[c] === "" ? null : body[c]));
  values.push(req.params.id);
  db.prepare(`UPDATE suppliers SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect(`/suppliers/${req.params.id}`);
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM suppliers WHERE id = ?").run(req.params.id);
  res.redirect("/suppliers");
});

module.exports = router;
