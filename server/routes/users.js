const express = require("express");
const router = express.Router();
const db = require("../db");
const { hashPassword } = require("../auth");

const PROFILE_FIELDS = ["display_name", "full_name", "role_title", "phone", "email"];

router.get("/profile", (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.currentUser.id);
  res.render("users/profile", { profileUser: user, success: req.query.saved });
});

router.post("/profile", (req, res) => {
  const body = req.body;
  const cols = PROFILE_FIELDS.filter((c) => c in body);
  const values = cols.map((c) => (body[c] === "" ? null : body[c]));
  if (body.new_password && body.new_password.trim()) {
    const { hashPassword } = require("../auth");
    const allCols = [...cols, "password_hash"];
    const allVals = [...values, hashPassword(body.new_password.trim()), req.currentUser.id];
    db.prepare(`UPDATE users SET ${allCols.map(c => `${c} = ?`).join(", ")} WHERE id = ?`).run(...allVals);
  } else {
    values.push(req.currentUser.id);
    db.prepare(`UPDATE users SET ${cols.map(c => `${c} = ?`).join(", ")} WHERE id = ?`).run(...values);
  }
  res.redirect("/users/profile?saved=1");
});

router.get("/", (req, res) => {
  const users = db.prepare("SELECT id, username, display_name, created_at FROM users ORDER BY id").all();
  res.render("users/list", { users });
});

router.get("/new", (req, res) => {
  res.render("users/form", { mode: "new" });
});

router.post("/", (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password) return res.redirect("/users/new");
  try {
    db.prepare("INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?,?,?,?)").run(
      username.trim(), hashPassword(password), display_name || username.trim(), new Date().toISOString()
    );
  } catch (e) {
    return res.render("users/form", { mode: "new", error: "שם המשתמש כבר תפוס" });
  }
  res.redirect("/users");
});

router.get("/:id/edit", (req, res) => {
  const user = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).render("404");
  res.render("users/form", { mode: "edit", editUser: user });
});

router.put("/:id", (req, res) => {
  const { display_name, password } = req.body;
  db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(display_name, req.params.id);
  if (password && password.trim()) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), req.params.id);
  }
  res.redirect("/users");
});

router.delete("/:id", (req, res) => {
  if (parseInt(req.params.id) === req.currentUser.id) {
    return res.redirect("/users");
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.redirect("/users");
});

module.exports = router;
