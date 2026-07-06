const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");
const { buildDbFromSeed } = require("./buildDb");

// בסביבת Render עם Persistent Disk — נתונים נשמרים ב-/var/data
// בסביבה מקומית — נשמרים בתיקיית server/data הרגילה
const DATA_DIR = process.env.RENDER_PERSISTENT_DIR
  ? process.env.RENDER_PERSISTENT_DIR
  : path.join(__dirname, "data");

// וידוא שהתיקייה קיימת (חשוב בהרצה ראשונה על דיסק חדש)
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const dbPath = path.join(DATA_DIR, "talmud-tora.db");

// seed.json תמיד בתוך הקוד (server/data) — משמש כגיבוי לשחזור
const seedPath = path.join(__dirname, "data", "seed.json");

function tryOpenAndCheck() {
  const conn = new DatabaseSync(dbPath);
  const check = conn.prepare("PRAGMA integrity_check;").get();
  if (!check || check.integrity_check !== "ok") {
    conn.close();
    throw new Error("integrity_check failed: " + JSON.stringify(check));
  }
  return conn;
}

let db;
if (!fs.existsSync(dbPath)) {
  console.log(`קובץ מסד הנתונים לא נמצא ב-${dbPath} - בונה אוטומטית מ-seed.json...`);
  buildDbFromSeed(dbPath);
  db = tryOpenAndCheck();
} else {
  try {
    db = tryOpenAndCheck();
    console.log(`מסד הנתונים נטען מ-${dbPath}`);
  } catch (err) {
    console.warn(`קובץ מסד הנתונים פגום (${err.message}) - בונה מחדש אוטומטית מ-seed.json...`);
    try {
      buildDbFromSeed(dbPath);
      db = tryOpenAndCheck();
    } catch (rebuildErr) {
      console.error(`
שגיאה: לא ניתן לבנות מחדש את מסד הנתונים (${rebuildErr.message}).
ודאו שהקובץ server/data/seed.json קיים ותקין, או הריצו: node server/buildDb.js
`);
      process.exit(1);
    }
  }
}

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

// מיגרציות אוטומטיות — מוסיף עמודות חדשות אם עדיין לא קיימות
// (נדרש כשמסד הנתונים קיים מגרסה ישנה ולא נבנה מחדש)
const migrations = [
  "ALTER TABLE users ADD COLUMN force_password_change INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN full_name TEXT",
  "ALTER TABLE users ADD COLUMN role_title TEXT",
  "ALTER TABLE users ADD COLUMN phone TEXT",
  "ALTER TABLE users ADD COLUMN email TEXT",
  "ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0",
  "ALTER TABLE teachers ADD COLUMN spouse_birth_date INTEGER",
  "ALTER TABLE teacher_file ADD COLUMN file_path TEXT",
  "ALTER TABLE teacher_file ADD COLUMN file_name TEXT",
  "ALTER TABLE teachers ADD COLUMN children_count INTEGER",
  "ALTER TABLE teachers ADD COLUMN id_number_spouse TEXT",
  "ALTER TABLE teachers ADD COLUMN spouse_last_name TEXT",
  "ALTER TABLE teachers ADD COLUMN spouse_first_name TEXT",
  "ALTER TABLE teachers ADD COLUMN health_fund TEXT",
  "ALTER TABLE teachers ADD COLUMN email TEXT",
  "ALTER TABLE teachers ADD COLUMN children_count_total INTEGER",
  "ALTER TABLE teachers ADD COLUMN gender TEXT",
  "ALTER TABLE teachers ADD COLUMN branch TEXT",
  "ALTER TABLE families ADD COLUMN father_email TEXT",
  "ALTER TABLE families ADD COLUMN mother_email TEXT",
  // טבלאות ספרים - נוצרות אם לא קיימות
  `CREATE TABLE IF NOT EXISTS price_list (
    id INTEGER PRIMARY KEY,
    item_name TEXT NOT NULL UNIQUE,
    price REAL NOT NULL,
    publisher TEXT,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS shared_tasks (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    assigned_to INTEGER,
    assigned_label TEXT,
    done INTEGER DEFAULT 0,
    done_at TEXT,
    done_by INTEGER,
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS book_prices (
    id INTEGER PRIMARY KEY, item_name TEXT NOT NULL, publisher TEXT,
    price REAL NOT NULL DEFAULT 0, notes TEXT, updated_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_book_prices_name ON book_prices(item_name)`,
  `CREATE TABLE IF NOT EXISTS book_order_extras (
    id INTEGER PRIMARY KEY, year_label TEXT NOT NULL, student_id INTEGER NOT NULL,
    item_name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT,
    FOREIGN KEY(student_id) REFERENCES students(id)
  )`,
  `CREATE TABLE IF NOT EXISTS book_catalog (
    id INTEGER PRIMARY KEY, year_label TEXT NOT NULL, class_name TEXT NOT NULL,
    item_name TEXT NOT NULL, publisher TEXT, price REAL NOT NULL DEFAULT 0,
    is_mandatory INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS book_orders (
    id INTEGER PRIMARY KEY, year_label TEXT NOT NULL, student_id INTEGER NOT NULL,
    catalog_id INTEGER NOT NULL, ordered INTEGER DEFAULT 1, created_at TEXT,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(catalog_id) REFERENCES book_catalog(id),
    UNIQUE(year_label, student_id, catalog_id)
  )`,
  `CREATE TABLE IF NOT EXISTS book_payments (
    id INTEGER PRIMARY KEY, year_label TEXT NOT NULL, family_id INTEGER NOT NULL,
    amount REAL NOT NULL DEFAULT 0, method TEXT NOT NULL DEFAULT 'מזומן',
    payment_date TEXT, notes TEXT, created_by INTEGER, created_at TEXT,
    FOREIGN KEY(family_id) REFERENCES families(id)
  )`,
  "ALTER TABLE messages ADD COLUMN attachment_path TEXT",
  "ALTER TABLE messages ADD COLUMN attachment_name TEXT",
  "ALTER TABLE messages ADD COLUMN attachment_type TEXT",
  "ALTER TABLE messages ADD COLUMN reply_to_id INTEGER",
  "ALTER TABLE students ADD COLUMN updated_at TEXT",
  "ALTER TABLE families ADD COLUMN updated_at TEXT",
  "ALTER TABLE classes ADD COLUMN updated_at TEXT",
  "ALTER TABLE cohorts ADD COLUMN updated_at TEXT",
  "UPDATE students SET updated_at = datetime('now') WHERE updated_at IS NULL",
  "UPDATE families SET updated_at = datetime('now') WHERE updated_at IS NULL",
  "UPDATE classes SET updated_at = datetime('now') WHERE updated_at IS NULL",
  "UPDATE cohorts SET updated_at = datetime('now') WHERE updated_at IS NULL",
  "ALTER TABLE maintenance_requests ADD COLUMN branch TEXT",
  `CREATE TABLE IF NOT EXISTS teacher_monthly_reports (
    id INTEGER PRIMARY KEY,
    teacher_id INTEGER NOT NULL,
    month_label TEXT NOT NULL,
    submitted_date TEXT,
    file_path TEXT,
    file_name TEXT,
    notes TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS supplier_orders (
    id INTEGER PRIMARY KEY,
    supplier_id INTEGER NOT NULL,
    created_by INTEGER NOT NULL,
    description TEXT NOT NULL,
    amount REAL,
    notes TEXT,
    status TEXT DEFAULT 'ממתין לאישור',
    rejection_reason TEXT,
    approved_by INTEGER,
    approved_at TEXT,
    sent_at TEXT,
    created_at TEXT
  )`,
  "DELETE FROM messages WHERE sender_id = recipient_id",
  "DELETE FROM messages WHERE sender_id NOT IN (SELECT id FROM users) OR recipient_id NOT IN (SELECT id FROM users)",
];

for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (e) {
    // עמודה כבר קיימת — מתעלמים מהשגיאה
  }
}

// ניקוי חד-פעמי: השדה "מעבר לכיתה" התמלא בעבר אוטומטית בערך המקבילה הקיים,
// אבל הוחלט שברירת המחדל האמיתית תהיה ריק (ואז המערכת מניחה "אותה מקבילה").
// דגל ב-settings מבטיח שהניקוי הזה ירוץ פעם אחת בלבד, ולא ימחק ידנית ערכים
// שמנהל יגדיר בעתיד בכוונה.
try {
  const alreadyCleared = db.prepare("SELECT value FROM settings WHERE key = 'transfer_number_cleared_once'").get();
  if (!alreadyCleared) {
    db.exec("UPDATE classes SET transfer_number = NULL");
    db.prepare("INSERT INTO settings (key, value) VALUES ('transfer_number_cleared_once', '1')").run();
  }
} catch (e) {
  // אם טבלת settings עדיין לא קיימת בשלב הזה - מתעלמים, זה ירוץ בהפעלה הבאה
}

function cleanShutdown() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
  } catch (e) {}
  process.exit(0);
}
process.on("SIGINT", cleanShutdown);
process.on("SIGTERM", cleanShutdown);

module.exports = db;
