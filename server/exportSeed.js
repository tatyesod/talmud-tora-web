// מייצא את כל מסד הנתונים (סכמה + נתונים) לקובץ JSON אחד.
// קובץ טקסט עמיד הרבה יותר מקובץ .db בינארי בהעברה דרך zip/הורדה/אנטי-וירוס/ענן.
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

// תמיכה בנתיב דינמי (Render Persistent Disk)
const DATA_DIR = process.env.RENDER_PERSISTENT_DIR
  ? process.env.RENDER_PERSISTENT_DIR
  : path.join(__dirname, "data");

const dbPath = path.join(DATA_DIR, "talmud-tora.db");
// seed.json נשמר בתוך הקוד (server/data) — כדי שיעלה ל-GitHub כגיבוי בפעם הבאה שדוחפים עדכון
const outPath = path.join(__dirname, "data", "seed.json");
// וגם בדיסק הקבוע של Render (אם קיים) — כדי שהגיבוי ישרוד גם בלי git push,
// כי תיקיית הקוד נדרסת בכל דיפלוי אבל הדיסק הקבוע לא.
const persistentOutPath = process.env.RENDER_PERSISTENT_DIR
  ? path.join(process.env.RENDER_PERSISTENT_DIR, "backups", "seed-latest.json")
  : null;

const db = new DatabaseSync(dbPath);

const tables = db
  .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
  .all();

const indexes = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL")
  .all();

const seed = { schema: [], indexes: indexes.map((i) => i.sql), tables: {} };

for (const t of tables) {
  seed.schema.push(t.sql);
  const rows = db.prepare(`SELECT * FROM "${t.name}"`).all();
  seed.tables[t.name] = rows;
}

const seedJson = JSON.stringify(seed);
fs.writeFileSync(outPath, seedJson, "utf-8");
console.log(`נוצר קובץ seed: ${outPath}`);

if (persistentOutPath) {
  fs.mkdirSync(path.dirname(persistentOutPath), { recursive: true });
  fs.writeFileSync(persistentOutPath, seedJson, "utf-8");
  console.log(`נוצר עותק גם בדיסק הקבוע: ${persistentOutPath}`);
}

console.log("טבלאות:", Object.keys(seed.tables).map((k) => `${k}(${seed.tables[k].length})`).join(", "));

db.close();

module.exports = function exportSeedFn() {
  // כבר רץ בטעינה — הייצוא בוצע. פונקציה זו לקריאות חוזרות
};
