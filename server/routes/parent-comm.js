const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");

// ============ שליחת מייל קבוצתי להורים ============
router.get("/", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("parent-comm/compose", { classes, emails: null, classLabel: null });
});

router.get("/emails", (req, res) => {
  const classId = req.query.class_id;
  let sql = `
    SELECT DISTINCT f.father_email, f.mother_email, c.name AS class_name, c.parallel
    FROM students s
    LEFT JOIN families f ON s.family_id = f.id
    LEFT JOIN classes c ON s.class_id = c.id
    WHERE s.status = 'פעיל'
  `;
  const params = [];
  let classLabel = "כל ההורים";
  if (classId) {
    sql += " AND s.class_id = ?";
    params.push(classId);
    const cls = db.prepare("SELECT name, parallel FROM classes WHERE id = ?").get(classId);
    classLabel = cls ? cls.name + (cls.parallel ? " (" + cls.parallel + ")" : "") : "כיתה נבחרת";
  }
  const rows = db.prepare(sql).all(...params);
  const emails = [];
  rows.forEach((r) => {
    if (r.father_email) emails.push(r.father_email);
    if (r.mother_email) emails.push(r.mother_email);
  });
  const uniqueEmails = [...new Set(emails)];

  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("parent-comm/compose", { classes, emails: uniqueEmails, classLabel, selectedClassId: classId || "" });
});

// ============ פניות הורים ============
router.get("/requests", (req, res) => {
  const { status } = req.query;
  let sql = `
    SELECT pr.*, f.last_name AS family_last_name, s.first_name, s.last_name
    FROM parent_requests pr
    LEFT JOIN families f ON pr.family_id = f.id
    LEFT JOIN students s ON pr.student_id = s.id
    WHERE 1=1
  `;
  const params = [];
  if (status) {
    sql += " AND pr.status = ?";
    params.push(status);
  }
  sql += " ORDER BY pr.created_at DESC";
  const requests = db.prepare(sql).all(...params).map((r) => ({
    ...r,
    created_at_str: r.created_at ? new Date(r.created_at).toLocaleDateString("he-IL") : "",
  }));
  res.render("parent-comm/requests", { requests, status: status || "" });
});

router.get("/requests/new", (req, res) => {
  const families = db.prepare("SELECT id, last_name FROM families ORDER BY last_name").all();
  res.render("parent-comm/request-form", { families });
});

router.post("/requests", (req, res) => {
  const { family_id, subject, body } = req.body;
  db.prepare(
    "INSERT INTO parent_requests (family_id, subject, body, status, created_at) VALUES (?,?,?,?,?)"
  ).run(family_id || null, subject, body, "פתוח", new Date().toISOString());
  res.redirect("/parent-comm/requests");
});

router.get("/requests/:id", (req, res) => {
  const request = db.prepare(`
    SELECT pr.*, f.last_name AS family_last_name, f.father_email, f.mother_email
    FROM parent_requests pr LEFT JOIN families f ON pr.family_id = f.id
    WHERE pr.id = ?
  `).get(req.params.id);
  if (!request) return res.status(404).render("404");
  res.render("parent-comm/request-view", { request });
});

router.put("/requests/:id", (req, res) => {
  const { status, response } = req.body;
  const resolvedAt = status === "סגור" ? new Date().toISOString() : null;
  db.prepare("UPDATE parent_requests SET status = ?, response = ?, resolved_at = ? WHERE id = ?").run(
    status, response || null, resolvedAt, req.params.id
  );
  res.redirect(`/parent-comm/requests/${req.params.id}`);
});

module.exports = router;
