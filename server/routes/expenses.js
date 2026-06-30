const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");

router.get("/", (req, res) => {
  const { supplier_id, paid } = req.query;
  let sql = `
    SELECT e.*, s.name AS supplier_name FROM expenses e
    LEFT JOIN suppliers s ON e.supplier_id = s.id WHERE 1=1
  `;
  const params = [];
  if (supplier_id) {
    sql += " AND e.supplier_id = ?";
    params.push(supplier_id);
  }
  if (paid) {
    sql += " AND e.paid = ?";
    params.push(paid === "כן" ? 1 : 0);
  }
  sql += " ORDER BY e.expense_date DESC";
  const expenses = db.prepare(sql).all(...params).map((e) => ({
    ...e,
    expense_date_str: hd.serialToGregorianString(e.expense_date),
  }));

  const totalAll = expenses.reduce((sum, e) => sum + (e.amount || 0), 0);
  const totalUnpaid = expenses.filter((e) => !e.paid).reduce((sum, e) => sum + (e.amount || 0), 0);

  const bySupplier = db
    .prepare(`
      SELECT s.id, s.name, COALESCE(SUM(e.amount),0) AS total, COUNT(e.id) AS count
      FROM suppliers s LEFT JOIN expenses e ON e.supplier_id = s.id
      GROUP BY s.id ORDER BY total DESC
    `)
    .all();

  const suppliers = db.prepare("SELECT id, name FROM suppliers ORDER BY name").all();

  res.render("expenses/list", {
    expenses, totalAll, totalUnpaid, bySupplier, suppliers,
    supplier_id: supplier_id || "", paid: paid || "",
  });
});

router.get("/new", (req, res) => {
  const suppliers = db.prepare("SELECT id, name FROM suppliers ORDER BY name").all();
  res.render("expenses/form", { expense: {}, mode: "new", suppliers });
});

const EXPENSE_FIELDS = ["supplier_id", "description", "amount", "expense_date", "category", "paid", "invoice_number", "notes"];

function normalize(col, value) {
  if (value === undefined || value === "") return null;
  if (col === "expense_date") return hd.gregorianStringToSerial(value);
  if (col === "paid") return value === "on" || value === "1" ? 1 : 0;
  return value;
}

router.post("/", (req, res) => {
  const body = req.body;
  const cols = EXPENSE_FIELDS.filter((c) => c === "paid" || c in body);
  const values = cols.map((c) => normalize(c, body[c]));
  db.prepare(`INSERT INTO expenses (${cols.join(",")}, created_at) VALUES (${cols.map(() => "?").join(",")}, ?)`).run(
    ...values, new Date().toISOString()
  );
  res.redirect("/expenses");
});

router.get("/:id/edit", (req, res) => {
  const expense = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!expense) return res.status(404).render("404");
  const suppliers = db.prepare("SELECT id, name FROM suppliers ORDER BY name").all();
  res.render("expenses/form", {
    expense: { ...expense, expense_date: hd.serialToInputDate(expense.expense_date) },
    mode: "edit", suppliers,
  });
});

router.put("/:id", (req, res) => {
  const body = req.body;
  const cols = EXPENSE_FIELDS.filter((c) => c === "paid" || c in body);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => normalize(c, body[c]));
  values.push(req.params.id);
  db.prepare(`UPDATE expenses SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect("/expenses");
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id);
  res.redirect("/expenses");
});

module.exports = router;
