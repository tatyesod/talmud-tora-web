const express = require("express");
const router = express.Router();
const db = require("../db");

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("he-IL", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
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
      body: lastMsg ? (lastMsg.body.length > 35 ? lastMsg.body.slice(0, 35) + "..." : lastMsg.body) : null,
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

router.post("/:userId", (req, res) => {
  const { body } = req.body;
  if (body && body.trim()) {
    db.prepare("INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?,?,?,?)").run(
      req.currentUser.id, req.params.userId, body.trim(), new Date().toISOString()
    );
  }
  res.redirect(`/messages/${req.params.userId}`);
});

module.exports = router;
