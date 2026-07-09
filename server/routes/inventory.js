const express = require("express");
const router = express.Router();
const db = require("../db");

// ============ מלאי וציוד ============
router.get("/", (req, res) => {
  const items = db
    .prepare(`
      SELECT i.*, c.name AS class_name, c.parallel FROM inventory_items i
      LEFT JOIN classes c ON i.class_id = c.id ORDER BY i.name
    `)
    .all();
  const openRequests = db
    .prepare(`
      SELECT COUNT(*) c FROM maintenance_requests WHERE status != 'סגור'
    `)
    .get().c;
  res.render("inventory/list", { items, openRequests });
});

router.get("/print", (req, res) => {
  const items = db
    .prepare(`
      SELECT i.*, c.name AS class_name, c.parallel FROM inventory_items i
      LEFT JOIN classes c ON i.class_id = c.id ORDER BY i.name
    `)
    .all();
  const headers = ["פריט", "כיתה/מיקום", "כמות לפי המערכת", "מצב", "הערות", "ספירה בפועל (למילוי ידני)"];
  const rows = items.map(i => [
    i.name,
    i.class_name ? i.class_name + (i.parallel ? " (" + i.parallel + ")" : "") : (i.location || ""),
    i.quantity != null ? i.quantity : "",
    i.condition || "",
    i.notes || "",
    "",
  ]);
  res.render("reports/print-view", { title: "דוח ספירת מלאי וציוד", headers, rows });
});

router.get("/new", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("inventory/form", { item: {}, mode: "new", classes });
});

const ITEM_FIELDS = ["name", "class_id", "location", "quantity", "condition", "notes"];

router.post("/", (req, res) => {
  const body = req.body;
  const cols = ITEM_FIELDS.filter((c) => c in body);
  const values = cols.map((c) => (body[c] === "" ? null : body[c]));
  db.prepare(`INSERT INTO inventory_items (${cols.join(",")}, updated_at) VALUES (${cols.map(() => "?").join(",")}, ?)`).run(
    ...values, new Date().toISOString()
  );
  res.redirect("/inventory");
});

router.get("/:id/edit", (req, res) => {
  const item = db.prepare("SELECT * FROM inventory_items WHERE id = ?").get(req.params.id);
  if (!item) return res.status(404).render("404");
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("inventory/form", { item, mode: "edit", classes });
});

router.put("/:id", (req, res) => {
  const body = req.body;
  const cols = ITEM_FIELDS.filter((c) => c in body);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => (body[c] === "" ? null : body[c]));
  values.push(new Date().toISOString(), req.params.id);
  db.prepare(`UPDATE inventory_items SET ${setClause}, updated_at = ? WHERE id = ?`).run(...values);
  res.redirect("/inventory");
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM inventory_items WHERE id = ?").run(req.params.id);
  res.redirect("/inventory");
});

// ============ בקשות תחזוקה ============
router.get("/maintenance", (req, res) => {
  const { status, branch } = req.query;
  let sql = `
    SELECT m.*, c.name AS class_name, c.parallel, u.display_name AS reporter_name,
           COALESCE(m.branch, c.branch) AS effective_branch
    FROM maintenance_requests m
    LEFT JOIN classes c ON m.class_id = c.id
    LEFT JOIN users u ON m.reported_by_user_id = u.id
    WHERE 1=1
  `;
  const params = [];
  if (status) {
    sql += " AND m.status = ?";
    params.push(status);
  }
  if (branch) {
    sql += " AND COALESCE(m.branch, c.branch) = ?";
    params.push(branch);
  }
  sql += " ORDER BY m.created_at DESC";
  const requests = db.prepare(sql).all(...params).map((r) => ({
    ...r,
    created_at_str: r.created_at ? new Date(r.created_at).toLocaleDateString("he-IL") : "",
  }));
  res.render("inventory/maintenance-list", { requests, status: status || "", branch: branch || "" });
});

router.get("/maintenance/print", (req, res) => {
  const { status, branch } = req.query;
  let sql = `
    SELECT m.*, c.name AS class_name, c.parallel, u.display_name AS reporter_name,
           COALESCE(m.branch, c.branch) AS effective_branch
    FROM maintenance_requests m
    LEFT JOIN classes c ON m.class_id = c.id
    LEFT JOIN users u ON m.reported_by_user_id = u.id
    WHERE 1=1
  `;
  const params = [];
  if (status) {
    sql += " AND m.status = ?";
    params.push(status);
  }
  if (branch) {
    sql += " AND COALESCE(m.branch, c.branch) = ?";
    params.push(branch);
  }
  sql += " ORDER BY m.created_at DESC";
  const requests = db.prepare(sql).all(...params);
  const headers = ["תאריך", "סניף", "תיאור", "מיקום", "דווח ע\"י", "סטטוס"];
  const rows = requests.map((r) => [
    r.created_at ? new Date(r.created_at).toLocaleDateString("he-IL") : "",
    r.effective_branch || "כללי",
    r.description || "",
    r.class_name ? r.class_name + (r.parallel ? " (" + r.parallel + ")" : "") : (r.location || ""),
    r.reporter_name || "",
    r.status || "",
  ]);
  const title = "בקשות תחזוקה ותיקונים" + (branch ? " - סניף " + branch : " - כל הסניפים");
  res.render("reports/print-view", { title, headers, rows });
});

router.get("/maintenance/new", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("inventory/maintenance-form", { classes });
});

router.post("/maintenance", (req, res) => {
  const { description, class_id, location, branch } = req.body;
  db.prepare(
    "INSERT INTO maintenance_requests (description, class_id, location, branch, status, reported_by_user_id, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(description, class_id || null, location || null, branch || null, "פתוח", req.currentUser.id, new Date().toISOString());
  res.redirect("/inventory/maintenance");
});

router.put("/maintenance/:id", (req, res) => {
  const { status, notes } = req.body;
  const resolvedAt = status === "סגור" ? new Date().toISOString() : null;
  db.prepare("UPDATE maintenance_requests SET status = ?, notes = ?, resolved_at = ? WHERE id = ?").run(
    status, notes || null, resolvedAt, req.params.id
  );
  res.redirect("/inventory/maintenance");
});

module.exports = router;
