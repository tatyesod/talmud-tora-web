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

// ============ הזמנות מספקים ============

router.get("/orders", (req, res) => {
  const { status, mine } = req.query;
  let sql = `
    SELECT o.*, s.name AS supplier_name, s.email AS supplier_email,
           u.display_name AS creator_name, a.display_name AS approver_name
    FROM supplier_orders o
    JOIN suppliers s ON o.supplier_id = s.id
    LEFT JOIN users u ON o.created_by = u.id
    LEFT JOIN users a ON o.approved_by = a.id
    WHERE 1=1
  `;
  const params = [];
  if (status) {
    sql += " AND o.status = ?";
    params.push(status);
  }
  if (mine === "1") {
    sql += " AND o.created_by = ?";
    params.push(req.currentUser.id);
  }
  sql += " ORDER BY o.created_at DESC";
  const orders = db.prepare(sql).all(...params).map((o) => ({
    ...o,
    created_at_str: o.created_at ? new Date(o.created_at).toLocaleDateString("he-IL") : "",
  }));
  res.render("suppliers/orders-list", { orders, status: status || "", mine: mine || "" });
});

router.get("/orders/new", (req, res) => {
  const suppliers = db.prepare("SELECT id, name, email FROM suppliers WHERE status = 'פעיל' ORDER BY name").all();
  const preselectedSupplierId = req.query.supplier_id || "";
  res.render("suppliers/order-form", { suppliers, preselectedSupplierId });
});

router.post("/orders", (req, res) => {
  const { supplier_id, description, amount, notes } = req.body;
  const info = db.prepare(`
    INSERT INTO supplier_orders (supplier_id, created_by, description, amount, notes, status, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    supplier_id, req.currentUser.id, description, amount ? parseFloat(amount) : null,
    notes || null, "ממתין לאישור", new Date().toISOString()
  );

  // הודעה למנהלים על הזמנה חדשה הממתינה לאישור
  const admins = db.prepare("SELECT id FROM users WHERE is_admin = 1 AND id != ?").all(req.currentUser.id);
  const supplier = db.prepare("SELECT name FROM suppliers WHERE id = ?").get(supplier_id);
  const notifyBody = `📦 הזמנה חדשה ממתינה לאישור: ${supplier ? supplier.name : ""} — ${description}`;
  admins.forEach((a) => {
    db.prepare("INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?,?,?,?)").run(
      req.currentUser.id, a.id, notifyBody, new Date().toISOString()
    );
  });

  res.redirect(`/suppliers/orders/${info.lastInsertRowid}`);
});

router.get("/orders/:orderId", (req, res) => {
  const order = db.prepare(`
    SELECT o.*, s.name AS supplier_name, s.email AS supplier_email, s.phone AS supplier_phone,
           u.display_name AS creator_name, a.display_name AS approver_name
    FROM supplier_orders o
    JOIN suppliers s ON o.supplier_id = s.id
    LEFT JOIN users u ON o.created_by = u.id
    LEFT JOIN users a ON o.approved_by = a.id
    WHERE o.id = ?
  `).get(req.params.orderId);
  if (!order) return res.status(404).render("404");

  const mailSubject = encodeURIComponent(`הזמנה - תלמוד תורה החדש`);
  const mailBody = encodeURIComponent(`שלום,\n\nברצוננו להזמין:\n${order.description}\n\n${order.notes || ""}\n\nתודה.`);
  const mailtoLink = order.supplier_email
    ? `mailto:${order.supplier_email}?subject=${mailSubject}&body=${mailBody}`
    : null;

  res.render("suppliers/order-view", { order, mailtoLink });
});

router.post("/orders/:orderId/approve", (req, res) => {
  const order = db.prepare("SELECT * FROM supplier_orders WHERE id = ?").get(req.params.orderId);
  if (!order) return res.status(404).render("404");
  db.prepare("UPDATE supplier_orders SET status = 'אושר', approved_by = ?, approved_at = ? WHERE id = ?").run(
    req.currentUser.id, new Date().toISOString(), req.params.orderId
  );
  if (order.created_by !== req.currentUser.id) {
    const supplier = db.prepare("SELECT name FROM suppliers WHERE id = ?").get(order.supplier_id);
    db.prepare("INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?,?,?,?)").run(
      req.currentUser.id, order.created_by,
      `✅ ההזמנה שלך אושרה: ${supplier ? supplier.name : ""} — ${order.description}. אפשר לשלוח לספק.`,
      new Date().toISOString()
    );
  }
  res.redirect(req.get("Referer") || "/");
});

router.post("/orders/:orderId/reject", (req, res) => {
  const order = db.prepare("SELECT * FROM supplier_orders WHERE id = ?").get(req.params.orderId);
  if (!order) return res.status(404).render("404");
  const { rejection_reason } = req.body;
  db.prepare("UPDATE supplier_orders SET status = 'נדחה', approved_by = ?, approved_at = ?, rejection_reason = ? WHERE id = ?").run(
    req.currentUser.id, new Date().toISOString(), rejection_reason || null, req.params.orderId
  );
  if (order.created_by !== req.currentUser.id) {
    const supplier = db.prepare("SELECT name FROM suppliers WHERE id = ?").get(order.supplier_id);
    db.prepare("INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?,?,?,?)").run(
      req.currentUser.id, order.created_by,
      `❌ ההזמנה שלך נדחתה: ${supplier ? supplier.name : ""} — ${order.description}.${rejection_reason ? " סיבה: " + rejection_reason : ""}`,
      new Date().toISOString()
    );
  }
  res.redirect(req.get("Referer") || "/");
});

router.post("/orders/:orderId/dismiss", (req, res) => {
  db.prepare("UPDATE supplier_orders SET dismissed_by_creator = 1 WHERE id = ? AND created_by = ?").run(
    req.params.orderId, req.currentUser.id
  );
  res.redirect(req.get("Referer") || "/");
});

router.post("/orders/:orderId/mark-sent", (req, res) => {
  db.prepare("UPDATE supplier_orders SET status = 'נשלח לספק', sent_at = ? WHERE id = ?").run(
    new Date().toISOString(), req.params.orderId
  );
  res.redirect(req.get("Referer") || `/suppliers/orders/${req.params.orderId}`);
});

router.delete("/orders/:orderId", (req, res) => {
  db.prepare("DELETE FROM supplier_orders WHERE id = ?").run(req.params.orderId);
  res.redirect("/suppliers/orders");
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

// ============ מלאי ספק - פריטים, אנשי קשר, מלאי לפי סניף ============
router.get("/:id/inventory", (req, res) => {
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!supplier) return res.status(404).render("404");

  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL AND branch<>'' ORDER BY branch").all().map(r => r.branch);
  const branch = req.query.branch || branches[0] || "";

  const items = db.prepare(`
    SELECT si.*, COALESCE(sii.current_stock,0) AS current_stock, COALESCE(sii.desired_stock,0) AS desired_stock
    FROM supplier_items si
    LEFT JOIN supplier_item_inventory sii ON sii.supplier_item_id = si.id AND sii.branch = ?
    WHERE si.supplier_id = ?
    ORDER BY si.category, si.item_name
  `).all(branch, req.params.id);

  const categories = db.prepare("SELECT DISTINCT category FROM supplier_items WHERE category IS NOT NULL AND category<>'' ORDER BY category").all().map(r => r.category);
  const contacts = db.prepare("SELECT * FROM supplier_contacts WHERE supplier_id = ? ORDER BY contact_name").all(req.params.id);

  res.render("suppliers/inventory", { supplier, branches, branch, items, categories, contacts, saved: req.query.saved === "1" });
});

router.post("/:id/items", (req, res) => {
  const { item_name, category, price, notes } = req.body;
  db.prepare("INSERT INTO supplier_items (supplier_id, item_name, category, price, notes, created_at) VALUES (?,?,?,?,?,?)").run(
    req.params.id, item_name, category || null, parseFloat(price) || 0, notes || null, new Date().toISOString()
  );
  res.redirect(`/suppliers/${req.params.id}/inventory?branch=${encodeURIComponent(req.query.branch || req.body.branch || "")}`);
});

router.delete("/items/:itemId", (req, res) => {
  const item = db.prepare("SELECT supplier_id FROM supplier_items WHERE id = ?").get(req.params.itemId);
  db.prepare("DELETE FROM supplier_item_inventory WHERE supplier_item_id = ?").run(req.params.itemId);
  db.prepare("DELETE FROM supplier_items WHERE id = ?").run(req.params.itemId);
  res.redirect(`/suppliers/${item ? item.supplier_id : ""}/inventory`);
});

router.post("/:id/inventory/save", (req, res) => {
  const { branch } = req.body;
  let ids = req.body.item_id || [];
  let currentStocks = req.body.current_stock || [];
  let desiredStocks = req.body.desired_stock || [];
  let itemNames = req.body.item_name || [];
  let categories = req.body.category || [];
  let prices = req.body.price || [];
  let notesArr = req.body.notes || [];
  if (!Array.isArray(ids)) ids = [ids];
  if (!Array.isArray(currentStocks)) currentStocks = [currentStocks];
  if (!Array.isArray(desiredStocks)) desiredStocks = [desiredStocks];
  if (!Array.isArray(itemNames)) itemNames = [itemNames];
  if (!Array.isArray(categories)) categories = [categories];
  if (!Array.isArray(prices)) prices = [prices];
  if (!Array.isArray(notesArr)) notesArr = [notesArr];

  const upsertStock = db.prepare(`
    INSERT INTO supplier_item_inventory (supplier_item_id, branch, current_stock, desired_stock, updated_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(supplier_item_id, branch) DO UPDATE SET
      current_stock = excluded.current_stock, desired_stock = excluded.desired_stock, updated_at = excluded.updated_at
  `);
  const updateItem = db.prepare(`UPDATE supplier_items SET item_name=?, category=?, price=?, notes=? WHERE id=? AND supplier_id=?`);
  const now = new Date().toISOString();
  ids.forEach((id, i) => {
    upsertStock.run(id, branch, parseInt(currentStocks[i], 10) || 0, parseInt(desiredStocks[i], 10) || 0, now);
    if (itemNames[i] !== undefined) {
      updateItem.run(
        (itemNames[i] || "").trim() || "ללא שם", (categories[i] || "").trim() || null,
        parseFloat(prices[i]) || 0, (notesArr[i] || "").trim() || null, id, req.params.id
      );
    }
  });

  res.redirect(`/suppliers/${req.params.id}/inventory?branch=${encodeURIComponent(branch)}&saved=1`);
});

router.post("/:id/contacts", (req, res) => {
  const { contact_name, phone } = req.body;
  db.prepare("INSERT INTO supplier_contacts (supplier_id, contact_name, phone, created_at) VALUES (?,?,?,?)").run(
    req.params.id, contact_name, phone || null, new Date().toISOString()
  );
  res.redirect(`/suppliers/${req.params.id}/inventory`);
});

router.delete("/contacts/:contactId", (req, res) => {
  const contact = db.prepare("SELECT supplier_id FROM supplier_contacts WHERE id = ?").get(req.params.contactId);
  db.prepare("DELETE FROM supplier_contacts WHERE id = ?").run(req.params.contactId);
  res.redirect(`/suppliers/${contact ? contact.supplier_id : ""}/inventory`);
});

// ============ הזמנה מסודרת מהספק - לפי סניף, כולל בחירת איש קשר ============
router.get("/:id/order", (req, res) => {
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!supplier) return res.status(404).render("404");

  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL AND branch<>'' ORDER BY branch").all().map(r => r.branch);
  const branch = req.query.branch || branches[0] || "";

  const rows = db.prepare(`
    SELECT si.item_name, si.category, si.price,
           COALESCE(sii.current_stock,0) AS current_stock, COALESCE(sii.desired_stock,0) AS desired_stock
    FROM supplier_items si
    LEFT JOIN supplier_item_inventory sii ON sii.supplier_item_id = si.id AND sii.branch = ?
    WHERE si.supplier_id = ? AND COALESCE(sii.desired_stock,0) > COALESCE(sii.current_stock,0)
    ORDER BY si.category, si.item_name
  `).all(branch, req.params.id).map(r => ({ ...r, to_order: r.desired_stock - r.current_stock, line_total: (r.desired_stock - r.current_stock) * r.price }));

  const contacts = db.prepare("SELECT * FROM supplier_contacts WHERE supplier_id = ? ORDER BY contact_name").all(req.params.id);
  const grandTotal = rows.reduce((s, r) => s + r.line_total, 0);
  const grandQty = rows.reduce((s, r) => s + r.to_order, 0);

  res.render("suppliers/order", { supplier, branches, branch, rows, contacts, grandTotal, grandQty });
});

router.get("/:id/order/print", (req, res) => {
  const supplier = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!supplier) return res.status(404).render("404");
  const { branch, contact_id } = req.query;

  const rows = db.prepare(`
    SELECT si.item_name, si.category,
           COALESCE(sii.current_stock,0) AS current_stock, COALESCE(sii.desired_stock,0) AS desired_stock
    FROM supplier_items si
    LEFT JOIN supplier_item_inventory sii ON sii.supplier_item_id = si.id AND sii.branch = ?
    WHERE si.supplier_id = ? AND COALESCE(sii.desired_stock,0) > COALESCE(sii.current_stock,0)
    ORDER BY si.category, si.item_name
  `).all(branch || "", req.params.id).map(r => ({ ...r, to_order: r.desired_stock - r.current_stock }));

  const contact = contact_id ? db.prepare("SELECT * FROM supplier_contacts WHERE id = ?").get(contact_id) : null;
  const today = new Date().toLocaleDateString("he-IL");

  res.render("suppliers/order-print", { supplier, branch, rows, contact, today });
});

module.exports = router;
