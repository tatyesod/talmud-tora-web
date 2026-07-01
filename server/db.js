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
