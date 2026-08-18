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
  const users = db.prepare("SELECT id, username, display_name, force_password_change, created_at, role FROM users ORDER BY id").all();
  res.render("users/list", { deleteError: req.query.deleteError === "1", users });
});

router.get("/new", (req, res) => {
  res.render("users/form", { mode: "new" });
});

router.post("/", (req, res) => {
  const { username, password, display_name, role, exclude_from_consult } = req.body;
  if (!username || !password) return res.redirect("/users/new");
  // רק "maintenance" מתקבל כתפקיד; כל ערך אחר הופך למשתמש רגיל, כדי שלא
  // ייכתב לשדה תפקיד שרירותי שהשער לא מכיר
  const safeRole = role === "maintenance" ? "maintenance" : null;
  try {
    db.prepare(`INSERT INTO users (username, password_hash, display_name, created_at, role, exclude_from_consult)
      VALUES (?,?,?,?,?,?)`).run(
      username.trim(), hashPassword(password), display_name || username.trim(),
      new Date().toISOString(), safeRole, exclude_from_consult === "on" ? 1 : 0
    );
  } catch (e) {
    return res.render("users/form", { mode: "new", error: "שם המשתמש כבר תפוס" });
  }
  res.redirect("/users");
});

router.get("/:id/edit", (req, res) => {
  const user = db.prepare("SELECT id, username, display_name, force_password_change, role, exclude_from_consult FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).render("404");
  res.render("users/form", { mode: "edit", editUser: user });
});

router.put("/:id", (req, res) => {
  const { display_name, password, force_password_change, role, exclude_from_consult } = req.body;
  const safeRole = role === "maintenance" ? "maintenance" : null;
  // הגנה: מנהל לא יכול להפוך את עצמו לתחזוקן ולנעול את עצמו מחוץ למערכת
  const isSelf = parseInt(req.params.id, 10) === req.currentUser.id;
  const target = db.prepare("SELECT is_admin FROM users WHERE id = ?").get(req.params.id);
  const roleToSet = (isSelf || (target && target.is_admin)) ? null : safeRole;
  // תחזוקן לא מנהל את הסיסמה שלו, ולכן "חייב לשנות סיסמה" תמיד כבוי אצלו
  const forceFlag = roleToSet === "maintenance" ? 0 : (force_password_change === "on" ? 1 : 0);
  db.prepare(`UPDATE users SET display_name = ?, force_password_change = ?, role = ?,
    exclude_from_consult = ? WHERE id = ?`).run(
    display_name, forceFlag, roleToSet, exclude_from_consult === "on" ? 1 : 0, req.params.id
  );
  if (password && password.trim()) {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), req.params.id);
  }
  res.redirect("/users");
});

router.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id) || id === req.currentUser.id) return res.redirect("/users");

  // כל הטבלאות שמצביעות על המשתמש חייבות להתנקות לפניו. אכיפת המפתחות
  // הזרים דלוקה, ולכן ניסיון למחוק משתמש שיש לו רשומת נוכחות או משימה
  // נכשל ב-FOREIGN KEY constraint - וזה מה שהופיע כ"שגיאת שרת פנימית".
  // נוכחות קיימת לכל מי שהתחבר אי פעם, ולכן זה נכשל כמעט תמיד.
  //
  // מה נמחק ומה נשמר: הודעות ונוכחות נמחקות - הן חסרות ערך בלי המשתמש.
  // משימות ובקשות תחזוקה נשמרות והשיוך שלהן מתאפס בלבד, כדי לא לאבד
  // היסטוריית עבודה בגלל מחיקת עובד שעזב.
  const tx = () => {
    db.prepare("DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?").run(id, id);
    db.prepare("DELETE FROM user_presence WHERE user_id = ?").run(id);
    db.prepare("UPDATE tasks SET user_id = NULL WHERE user_id = ?").run(id);
    // העמודות האלה נוספו ב-ALTER TABLE בלי מפתח זר, אך איפוסן מונע שיוך
    // תלוי-באוויר שיציג מזהה של משתמש שאינו קיים
    db.prepare("UPDATE maintenance_requests SET reported_by_user_id = NULL WHERE reported_by_user_id = ?").run(id);
    db.prepare("UPDATE maintenance_requests SET updated_by_user_id = NULL WHERE updated_by_user_id = ?").run(id);
    db.prepare("UPDATE maintenance_media SET uploaded_by_user_id = NULL WHERE uploaded_by_user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  };

  db.exec("BEGIN");
  try {
    tx();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("מחיקת משתמש נכשלה:", e.message);
    return res.redirect("/users?deleteError=1");
  }
  res.redirect("/users");
});

module.exports = router;
