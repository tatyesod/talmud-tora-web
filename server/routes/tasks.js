const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");

router.post("/", (req, res) => {
  const { title, notes, due_date } = req.body;
  if (!title || !title.trim()) return res.redirect("/");
  db.prepare(
    "INSERT INTO tasks (user_id, title, notes, due_date, done, created_at) VALUES (?,?,?,?,0,?)"
  ).run(
    req.currentUser.id,
    title.trim(),
    notes || null,
    due_date ? hd.gregorianStringToSerial(due_date) : null,
    new Date().toISOString()
  );
  res.redirect("/");
});

router.post("/:id/toggle", (req, res) => {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").get(req.params.id, req.currentUser.id);
  if (task) {
    db.prepare("UPDATE tasks SET done = ? WHERE id = ?").run(task.done ? 0 : 1, task.id);
  }
  res.redirect("/");
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?").run(req.params.id, req.currentUser.id);
  res.redirect("/");
});

module.exports = router;
