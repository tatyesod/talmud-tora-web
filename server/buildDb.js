// בונה מחדש את server/data/talmud-tora.db מתוך server/data/seed.json
// קובץ JSON (טקסט) עמיד הרבה יותר בהעברה מקובץ בינארי - מאפשר לשחזר
// תמיד מסד נתונים תקין גם אם קובץ ה-.db עצמו נפגם בדרך (אנטי-וירוס/ענן/zip)
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

function unlinkWithRetry(filePath, attempts = 20, delayMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      // ב-Windows קבצים שזה עתה נסגרו עלולים להישאר נעולים זמנית (EBUSY/EPERM)
      // ע"י אנטי-וירוס/Windows Search וכו' - ממתינים מעט וננסה שוב
      const until = Date.now() + delayMs;
      while (Date.now() < until) {
        /* busy-wait סינכרוני קצר */
      }
    }
  }
}

function buildDbFromSeed() {
  const dataDir = path.join(__dirname, "data");
  const dbPath = path.join(dataDir, "talmud-tora.db");
  const seedPath = path.join(dataDir, "seed.json");

  if (!fs.existsSync(seedPath)) {
    throw new Error(`קובץ seed.json לא נמצא ב-${seedPath}`);
  }

  // מנקה קובץ קודם (כולל שאריות WAL) אם קיים, עם ניסיונות חוזרים למקרה של נעילה זמנית
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    unlinkWithRetry(f);
  }

  const seed = JSON.parse(fs.readFileSync(seedPath, "utf-8"));
  const db = new DatabaseSync(dbPath);

  db.exec("PRAGMA foreign_keys = OFF;");
  db.exec("BEGIN TRANSACTION;");
  try {
    for (const sql of seed.schema) {
      db.exec(sql + ";");
    }

    for (const [table, rows] of Object.entries(seed.tables)) {
      if (rows.length === 0) continue;
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => "?").join(",");
      const stmt = db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${placeholders})`);
      for (const row of rows) {
        stmt.run(...cols.map((c) => row[c]));
      }
    }

    if (seed.indexes) {
      for (const sql of seed.indexes) {
        db.exec(sql + ";");
      }
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    db.close();
    throw err;
  }

  db.close();
  console.log(`מסד הנתונים נבנה מחדש מ-seed.json (${Object.keys(seed.tables).length} טבלאות)`);
}

module.exports = { buildDbFromSeed };

if (require.main === module) {
  buildDbFromSeed();
}
