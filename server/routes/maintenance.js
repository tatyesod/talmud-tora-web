const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");

function getMaintenanceEmail() {
  // מושכים ישירות מהכרטיס האישי של משה זילברשלג (התחזוקן) - כדי שלא
  // נצטרך להזין את המייל פעמיים, ושזה יתעדכן אוטומטית אם המייל שלו ישתנה
  const teacher = db.prepare(`
    SELECT email FROM teachers WHERE first_name = 'משה' AND last_name = 'זילברשלג' AND email IS NOT NULL AND email != ''
  `).get();
  if (teacher && teacher.email) return teacher.email;
  // גיבוי - אם לא נמצא (למשל שם שונה בכרטיס), נופלים לערך שהוזן ידנית
  return db.prepare("SELECT value FROM settings WHERE key = 'maintenance_email'").get()?.value || "";
}

// ============ טופס דיווח תקלת תחזוקה ============
router.get("/report", (req, res) => {
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL AND branch != '' ORDER BY branch").all().map((r) => r.branch);
  const maintenanceEmail = getMaintenanceEmail();
  res.render("maintenance/report", { branches, maintenanceEmail, saved: req.query.saved === "1" });
});

router.post("/report", (req, res) => {
  const { branch, location, description, urgency, reporter_name } = req.body;
  if (!description || !description.trim()) return res.redirect("/maintenance/report");
  db.prepare(`
    INSERT INTO maintenance_requests (branch, location, description, urgency, reporter_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(branch || null, (location || "").trim() || null, description.trim(), urgency || null, (reporter_name || "").trim() || null, new Date().toISOString());
  res.redirect("/maintenance/report?saved=1");
});

// ============ יומן דיווחי תחזוקה (למעקב המשרד בלבד) ============
router.get("/", (req, res) => {
  const requests = db.prepare("SELECT * FROM maintenance_requests ORDER BY created_at DESC").all()
    .map((r) => ({ ...r, created_at_heb: hd.anyDateToHebrewString(r.created_at) }));
  const maintenanceEmail = getMaintenanceEmail();
  res.render("maintenance/log", { requests, maintenanceEmail });
});

// ============ עדכון כתובת המייל של התחזוקן ============
router.post("/settings/email", (req, res) => {
  const { maintenance_email } = req.body;
  const value = (maintenance_email || "").trim();
  const existing = db.prepare("SELECT key FROM settings WHERE key = 'maintenance_email'").get();
  if (existing) db.prepare("UPDATE settings SET value = ? WHERE key = 'maintenance_email'").run(value);
  else db.prepare("INSERT INTO settings (key, value) VALUES ('maintenance_email', ?)").run(value);
  res.redirect("/maintenance/report?saved=1");
});

module.exports = router;
