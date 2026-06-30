const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const fs = require("fs");
const { buildDbFromSeed } = require("./buildDb");

const dbPath = path.join(__dirname, "data", "talmud-tora.db");

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
  console.log("קובץ מסד הנתונים לא נמצא - בונה אוטומטית מ-seed.json...");
  buildDbFromSeed();
  db = tryOpenAndCheck();
} else {
  try {
    db = tryOpenAndCheck();
  } catch (err) {
    console.warn(`קובץ מסד הנתונים פגום (${err.message}) - בונה מחדש אוטומטית מ-seed.json...`);
    try {
      buildDbFromSeed();
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

// WAL מאפשר קריאה וכתיבה בו-זמנית ממספר חיבורים/בקשות,
// כך שכל המשתמשים רואים מיידית עדכונים של משתמשים אחרים
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

// סגירה נקייה בעת עצירת השרת - מבטיחה checkpoint תקין של ה-WAL
function cleanShutdown() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    db.close();
  } catch (e) {
    // מתעלם משגיאות סגירה
  }
  process.exit(0);
}
process.on("SIGINT", cleanShutdown);
process.on("SIGTERM", cleanShutdown);

module.exports = db;
