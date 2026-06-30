// מייצא את כל מסד הנתונים (סכמה + נתונים) לקובץ JSON אחד.
// קובץ טקסט עמיד הרבה יותר מקובץ .db בינארי בהעברה דרך zip/הורדה/אנטי-וירוס/ענן.
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "data", "talmud-tora.db");
const outPath = path.join(__dirname, "data", "seed.json");

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

fs.writeFileSync(outPath, JSON.stringify(seed), "utf-8");
console.log(`נוצר קובץ seed: ${outPath}`);
console.log("טבלאות:", Object.keys(seed.tables).map((k) => `${k}(${seed.tables[k].length})`).join(", "));

db.close();
