const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

// המדיה נשמרת על הדיסק הקבוע, לא בתוך תיקיית הקוד - אחרת כל פריסה מוחקת אותה
const MEDIA_DIR = path.join(
  process.env.RENDER_PERSISTENT_DIR || path.join(__dirname, ".."),
  "uploads", "maintenance"
);
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

// 12MB לקובץ. התמונות מוקטנות בדפדפן לפני ההעלאה והסרטון מוגבל ל-20 שניות
// באיכות מופחתת, ולכן זו תקרת ביטחון ולא הגודל הצפוי.
const MEDIA_MAX_BYTES = 12 * 1024 * 1024;
const MEDIA_ALLOWED = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov",
};

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    // שם הקובץ נבנה בשרת בלבד. שם מקורי מהמכשיר עלול להכיל תווי נתיב
    // ולשמש למעבר תיקיות, ולכן הוא נשמר במסד לתצוגה אך לא בשם הקובץ.
    filename: (req, file, cb) => {
      const ext = MEDIA_ALLOWED[file.mimetype] || ".bin";
      cb(null, `m${req.params.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: MEDIA_MAX_BYTES, files: 6 },
  fileFilter: (req, file, cb) => cb(null, !!MEDIA_ALLOWED[file.mimetype]),
});

const kindOf = (mime) => (String(mime).startsWith("video") ? "video" : "image");
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");

function getMaintenanceEmail() {
  // מושכים ישירות מהכרטיס האישי של משה זילברשלג (התחזוקן) - כדי שלא
  // נצטרך להזין את המייל פעמיים, ושזה יתעדכן אוטומטית אם המייל שלו ישתנה
  const teacher = db.prepare(`
    SELECT email FROM teachers WHERE first_name = 'משה' AND last_name = 'זילברשלג' AND email IS NOT NULL AND email != ''
  `).get();
  return teacher && teacher.email ? teacher.email : "";
}

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
           up.display_name AS updater_name,
           COALESCE(m.branch, c.branch) AS effective_branch
    FROM maintenance_requests m
    LEFT JOIN classes c ON m.class_id = c.id
    LEFT JOIN users u ON m.reported_by_user_id = u.id
    LEFT JOIN users up ON m.updated_by_user_id = up.id
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
  // סדר התצוגה: פתוח -> בטיפול -> במעקב -> סגור, ובתוך כל קבוצה החדש קודם.
  // הסגורים יורדים לתחתית ואינם נמחקים, כדי שתישאר היסטוריית תחזוקה שממנה
  // אפשר לזהות תקלות חוזרות באותו מקום.
  sql += ` ORDER BY CASE m.status
             WHEN 'פתוח' THEN 0 WHEN 'בטיפול' THEN 1
             WHEN 'במעקב' THEN 2 WHEN 'סגור' THEN 3 ELSE 4 END,
           m.created_at DESC`;
  const requests = db.prepare(sql).all(...params).map((r) => ({
    ...r,
    created_at_str: r.created_at ? hd.formatGregorian(r.created_at) : "",
    media: db.prepare(`SELECT id, kind, orig_name, size_bytes FROM maintenance_media
                        WHERE request_id = ? ORDER BY id`).all(r.id),
    // "מי עדכן ומתי" - מוצג גם למזכירות וגם לתחזוקן, כולל שעה
    updated_str: r.status_updated_at
      ? hd.formatGregorian(r.status_updated_at) + " " +
        new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false,
        }).format(new Date(r.status_updated_at))
      : "",
  }));
  // תצוגת התחזוקן: מסך מצומצם, בלי שליחת מייל ובלי תיבות סימון.
  // מנהל יכול לראות אותה בדיוק כמו שהוא רואה אותה, עם ?preview=maintenance -
  // אותה תבנית ואותו קוד, כדי שמה שהמנהל בודק יהיה מה שהתחזוקן מקבל.
  const isMaintenanceView =
    (req.currentUser && req.currentUser.role === "maintenance") ||
    (res.locals.isAdmin && req.query.preview === "maintenance");

  // בתצוגה מקדימה גם הכותרת תהיה שלו, אחרת המנהל רואה תפריט אחר מהתחזוקן.
  // החזרה למסך הרגיל היא דרך הקישור בפס הצהוב.
  if (isMaintenanceView) res.locals.isMaintenanceUser = true;

  // מי אפשר לשתף איתו: כל המשתמשים הרגילים (לא התחזוקן עצמו)
  const notifyUsers = db.prepare(`SELECT id, display_name, username FROM users
    WHERE (role IS NULL OR role <> 'maintenance') ORDER BY display_name`).all();

  res.render(isMaintenanceView ? "inventory/maintenance-worker" : "inventory/maintenance-list", {
    requests, status: status || "", branch: branch || "",
    maintenanceEmail: getMaintenanceEmail(), notifyUsers,
    isPreview: !!(res.locals.isAdmin && req.query.preview === "maintenance"),
  });
});

router.get("/maintenance/print", (req, res) => {
  const { status, branch } = req.query;
  let sql = `
    SELECT m.*, c.name AS class_name, c.parallel, u.display_name AS reporter_name,
           up.display_name AS updater_name,
           COALESCE(m.branch, c.branch) AS effective_branch
    FROM maintenance_requests m
    LEFT JOIN classes c ON m.class_id = c.id
    LEFT JOIN users u ON m.reported_by_user_id = u.id
    LEFT JOIN users up ON m.updated_by_user_id = up.id
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
  // ההדפסה מיועדת לעבודה שוטפת ולכן אינה כוללת בקשות סגורות. הן נשארות
  // במערכת ונראות במסך, אבל אין טעם להדפיס לתחזוקן מה שכבר טופל.
  // סינון מפורש לסטטוס "סגור" עדיין עובד, למי שרוצה להדפיס דווקא אותן.
  if (status !== "סגור") sql += " AND m.status <> 'סגור'";
  sql += ` ORDER BY CASE m.status
             WHEN 'פתוח' THEN 0 WHEN 'בטיפול' THEN 1
             WHEN 'במעקב' THEN 2 ELSE 3 END,
           m.created_at DESC`;
  const requests = db.prepare(sql).all(...params);
  const headers = ["תאריך", "סניף", "תיאור", "מיקום", "דווח ע\"י", "סטטוס"];
  const rows = requests.map((r) => [
    r.created_at ? hd.formatGregorian(r.created_at) : "",
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
  res.render("inventory/maintenance-form", { classes, maintenanceEmail: getMaintenanceEmail() });
});

router.post("/maintenance", (req, res) => {
  // הטופס עכשיו שולח כמה שורות בבת אחת (מערכים) - כל שורה נשמרת כרשומת
  // תחזוקה נפרדת, כדי שכל תיקון יעקוב אחרי הסטטוס שלו בנפרד
  let { description, class_id, location, branch, urgency } = req.body;
  if (!Array.isArray(description)) description = [description];
  if (!Array.isArray(class_id)) class_id = [class_id];
  if (!Array.isArray(location)) location = [location];
  if (!Array.isArray(branch)) branch = [branch];
  if (!Array.isArray(urgency)) urgency = [urgency];

  const insert = db.prepare(
    "INSERT INTO maintenance_requests (description, class_id, location, branch, urgency, status, reported_by_user_id, created_at) VALUES (?,?,?,?,?,?,?,?)"
  );
  const now = new Date().toISOString();
  description.forEach((desc, i) => {
    if (!desc || !desc.trim()) return;
    insert.run(
      desc.trim(),
      class_id[i] || null,
      location[i] || null,
      branch[i] || null,
      urgency[i] || null,
      "פתוח",
      req.currentUser.id,
      now
    );
  });
  res.redirect("/inventory/maintenance");
});

router.put("/maintenance/:id", (req, res) => {
  const { status, notes } = req.body;
  // "במעקב" אינו סיום טיפול, ולכן אינו מסמן תאריך סגירה
  const resolvedAt = status === "סגור" ? new Date().toISOString() : null;
  // מתעדים מי עדכן ומתי, כדי שיהיה ברור אם התחזוקן טיפל או שמזכיר שינה סטטוס
  db.prepare(`UPDATE maintenance_requests
    SET status = ?, notes = ?, resolved_at = ?, updated_by_user_id = ?, status_updated_at = ?
    WHERE id = ?`).run(
    status, notes || null, resolvedAt,
    req.currentUser ? req.currentUser.id : null, new Date().toISOString(),
    req.params.id
  );
  res.redirect("/inventory/maintenance");
});

// ============ תמונות וסרטונים לבקשת תחזוקה ============

// העלאה. ניתן לבחור משתמשים שיקבלו הודעה עם הקובץ המצורף - לצורך התייעצות.
router.post("/maintenance/:id/media", mediaUpload.array("media", 6), (req, res) => {
  const reqRow = db.prepare("SELECT id FROM maintenance_requests WHERE id = ?").get(req.params.id);
  if (!reqRow) return res.redirect("/inventory/maintenance");

  const files = req.files || [];
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO maintenance_media
    (request_id, kind, file_name, orig_name, mime, size_bytes, uploaded_by_user_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  for (const f of files) {
    ins.run(reqRow.id, kindOf(f.mimetype), f.filename,
            Buffer.from(f.originalname, "latin1").toString("utf8"),
            f.mimetype, f.size, req.currentUser ? req.currentUser.id : null, now);
  }

  // הודעה למשתמשים שנבחרו. הקובץ עצמו לא משוכפל - ההודעה מפנה לאותו קובץ,
  // כדי לא להכפיל את הנפח על דיסק של 1GB.
  let to = req.body.notify_user_id || [];
  if (!Array.isArray(to)) to = [to];
  to = to.map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
  if (to.length && files.length && req.currentUser) {
    const note = String(req.body.notify_body || "").trim() || "צורפו תמונות/סרטון לבקשת תחזוקה — נדרשת התייעצות";
    const body = `${note}\n\nבקשת תחזוקה #${reqRow.id}: /inventory/maintenance`;
    const msg = db.prepare(`INSERT INTO messages
      (sender_id, recipient_id, body, created_at, attachment_path, attachment_name, attachment_type)
      VALUES (?,?,?,?,?,?,?)`);
    for (const uid of to) {
      for (const f of files) {
        msg.run(req.currentUser.id, uid, body, now,
                path.join("maintenance", f.filename),
                Buffer.from(f.originalname, "latin1").toString("utf8"), f.mimetype);
      }
    }
  }

  const back = req.body.preview === "maintenance" ? "?preview=maintenance" : "";
  res.redirect("/inventory/maintenance" + back);
});

// הגשת הקובץ עצמו. שם הקובץ מגיע מהמסד ולא מהכתובת, ולכן אין דרך לבקש
// קובץ שרירותי מהדיסק דרך ../
router.get("/maintenance/media/:mediaId/file", (req, res) => {
  const m = db.prepare("SELECT file_name, mime, orig_name FROM maintenance_media WHERE id = ?").get(req.params.mediaId);
  if (!m) return res.status(404).end();
  const full = path.join(MEDIA_DIR, path.basename(m.file_name));
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader("Content-Type", m.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=86400");
  fs.createReadStream(full).pipe(res);
});

// מחיקה - משחררת מקום בדיסק בפועל, לא רק מסתירה
router.delete("/maintenance/media/:mediaId", (req, res) => {
  const m = db.prepare("SELECT file_name FROM maintenance_media WHERE id = ?").get(req.params.mediaId);
  if (m) {
    const full = path.join(MEDIA_DIR, path.basename(m.file_name));
    try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch (e) { /* הרשומה תימחק בכל מקרה */ }
    db.prepare("DELETE FROM maintenance_media WHERE id = ?").run(req.params.mediaId);
  }
  const back = req.body && req.body.preview === "maintenance" ? "?preview=maintenance" : "";
  res.redirect(req.get("referer") || "/inventory/maintenance" + back);
});

// ============ ניהול נפח המדיה ============
// ניהול הדיסק הוא פעולה של המשרד. השער מתיר לתחזוקן כל נתיב שמתחיל
// ב-/inventory/maintenance, ולכן צריך חסימה מפורשת כאן - אחרת הוא היה מגיע
// למסך הזה ויכול למחוק מדיה בכמות.
function blockMaintenanceRole(req, res, next) {
  if (req.currentUser && req.currentUser.role === "maintenance") {
    return res.redirect("/inventory/maintenance");
  }
  next();
}

router.get("/maintenance/media", blockMaintenanceRole, (req, res) => {
  const rows = db.prepare(`
    SELECT mm.*, m.description, m.status, COALESCE(m.branch, c.branch) AS branch,
           u.display_name AS uploader
    FROM maintenance_media mm
    LEFT JOIN maintenance_requests m ON mm.request_id = m.id
    LEFT JOIN classes c ON m.class_id = c.id
    LEFT JOIN users u ON mm.uploaded_by_user_id = u.id
    ORDER BY mm.size_bytes DESC
  `).all().map((r) => ({
    ...r,
    size_str: fmtSize(r.size_bytes || 0),
    date_str: r.created_at ? hd.formatGregorian(r.created_at) : "",
  }));
  const total = rows.reduce((s, r) => s + (r.size_bytes || 0), 0);
  const closed = rows.filter((r) => r.status === "סגור");
  res.render("inventory/maintenance-media", {
    rows,
    totalStr: fmtSize(total),
    totalBytes: total,
    videoCount: rows.filter((r) => r.kind === "video").length,
    imageCount: rows.filter((r) => r.kind === "image").length,
    closedCount: closed.length,
    closedStr: fmtSize(closed.reduce((s, r) => s + (r.size_bytes || 0), 0)),
  });
});

// מחיקה מרוכזת של מדיה מבקשות שנסגרו - זה מה שמשחרר מקום בפועל
router.post("/maintenance/media/purge-closed", blockMaintenanceRole, (req, res) => {
  const rows = db.prepare(`
    SELECT mm.id, mm.file_name FROM maintenance_media mm
    JOIN maintenance_requests m ON mm.request_id = m.id
    WHERE m.status = 'סגור'
  `).all();
  let freed = 0;
  const del = db.prepare("DELETE FROM maintenance_media WHERE id = ?");
  for (const r of rows) {
    const full = path.join(MEDIA_DIR, path.basename(r.file_name));
    try {
      if (fs.existsSync(full)) { freed += fs.statSync(full).size; fs.unlinkSync(full); }
    } catch (e) { /* ממשיכים - הרשומה נמחקת בכל מקרה */ }
    del.run(r.id);
  }
  console.log(`[מדיית תחזוקה] נמחקו ${rows.length} קבצים, שוחררו ${fmtSize(freed)}`);
  res.redirect("/inventory/maintenance/media");
});

module.exports = router;
