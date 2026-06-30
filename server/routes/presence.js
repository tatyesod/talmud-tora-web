const express = require("express");
const router = express.Router();
const db = require("../db");

const ONLINE_THRESHOLD_MS = 90 * 1000; // נחשב "אונליין" אם נראה ב-90 שניות האחרונות

router.post("/ping", (req, res) => {
  db.prepare(
    "INSERT INTO user_presence (user_id, last_seen) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen"
  ).run(req.currentUser.id, new Date().toISOString());
  res.json({ ok: true });
});

router.get("/list", (req, res) => {
  const rows = db
    .prepare(`
      SELECT u.id, u.username, u.display_name, p.last_seen
      FROM users u
      LEFT JOIN user_presence p ON p.user_id = u.id
      ORDER BY u.display_name
    `)
    .all();
  const now = Date.now();
  const result = rows.map((r) => ({
    id: r.id,
    name: r.display_name || r.username,
    online: r.last_seen ? now - new Date(r.last_seen).getTime() < ONLINE_THRESHOLD_MS : false,
  }));
  res.json(result);
});

module.exports = router;
