const express = require("express");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// הגדרת multer להעלאת קבצים מצורפים בצ'אט (תמונות/מסמכים)
const DATA_DIR = process.env.RENDER_PERSISTENT_DIR || path.join(__dirname, "..");
const uploadDir = path.join(DATA_DIR, "uploads", "messages");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = Buffer.from(file.originalname, "latin1").toString("utf8");
    cb(null, `${req.currentUser.id}_${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB מקסימום
  fileFilter: (req, file, cb) => {
    const allowed = [".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".xls", ".xlsx"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("he-IL", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", timeZone: "Asia/Jerusalem" });
}

router.get("/recent/json", (req, res) => {
  const myId = req.currentUser.id;

  // כל המשתמשים האחרים + הודעה אחרונה עם כל אחד
  const otherUsers = db.prepare("SELECT id, username, display_name FROM users WHERE id != ? ORDER BY display_name").all(myId);

  const result = otherUsers.map((u) => {
    const lastMsg = db.prepare(`
      SELECT * FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(myId, u.id, u.id, myId);

    const unreadCount = db.prepare(
      "SELECT COUNT(*) c FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL"
    ).get(u.id, myId).c;

    return {
      otherId: u.id,
      otherName: u.display_name || u.username,
      body: lastMsg
        ? (lastMsg.body && lastMsg.body.length > 0
            ? (lastMsg.body.length > 35 ? lastMsg.body.slice(0, 35) + "..." : lastMsg.body)
            : (lastMsg.attachment_type === "image" ? "📷 תמונה" : lastMsg.attachment_path ? "📎 קובץ מצורף" : null))
        : null,
      mine: lastMsg ? lastMsg.sender_id === myId : false,
      unread: unreadCount > 0,
      unreadCount,
    };
  });

  res.json(result);
});

router.get("/", (req, res) => {
  const myId = req.currentUser.id;
  const otherUsers = db.prepare("SELECT id, username, display_name FROM users WHERE id != ? ORDER BY display_name").all(myId);

  const conversations = otherUsers.map((u) => {
    const lastMsg = db
      .prepare(`
        SELECT * FROM messages
        WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
        ORDER BY created_at DESC LIMIT 1
      `)
      .get(myId, u.id, u.id, myId);
    const unread = db
      .prepare("SELECT COUNT(*) c FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL")
      .get(u.id, myId).c;
    return {
      user: u,
      lastMsg: lastMsg ? { ...lastMsg, created_at_str: fmtTime(lastMsg.created_at) } : null,
      unread,
    };
  });

  res.render("messages/inbox", { conversations });
});

router.get("/:userId", (req, res) => {
  const myId = req.currentUser.id;
  const otherId = parseInt(req.params.userId);
  const otherUser = db.prepare("SELECT id, username, display_name FROM users WHERE id = ?").get(otherId);
  if (!otherUser) return res.status(404).render("404");

  db.prepare("UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL").run(
    new Date().toISOString(), otherId, myId
  );

  const thread = db
    .prepare(`
      SELECT * FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      ORDER BY created_at ASC
    `)
    .all(myId, otherId, otherId, myId)
    .map((m) => ({ ...m, created_at_str: fmtTime(m.created_at), mine: m.sender_id === myId }));

  res.render("messages/thread", { otherUser, thread });
});

router.post("/:userId", upload.single("attachment"), (req, res) => {
  const { body } = req.body;
  const hasText = body && body.trim();
  const file = req.file;

  if (hasText || file) {
    let attachmentPath = null, attachmentName = null, attachmentType = null;
    if (file) {
      attachmentPath = `/uploads/messages/${file.filename}`;
      attachmentName = Buffer.from(file.originalname, "latin1").toString("utf8");
      const ext = path.extname(attachmentName).toLowerCase();
      attachmentType = IMAGE_EXTS.includes(ext) ? "image" : "file";
    }
    db.prepare(`
      INSERT INTO messages (sender_id, recipient_id, body, created_at, attachment_path, attachment_name, attachment_type)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      req.currentUser.id, req.params.userId, hasText ? body.trim() : "", new Date().toISOString(),
      attachmentPath, attachmentName, attachmentType
    );
  }
  res.redirect(`/messages/${req.params.userId}`);
});

module.exports = router;
