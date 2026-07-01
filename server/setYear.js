// סקריפט חד-פעמי: מעדכן את שנת הלימודים לתשפ"ז ללא שינוי נתונים אחרים
// הרץ: node server/setYear.js
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.RENDER_PERSISTENT_DIR || path.join(__dirname, "data");
const db = new DatabaseSync(path.join(DATA_DIR, "talmud-tora.db"));

const label = 'תשפ"ז';
const num = 5787;

db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('current_hebrew_year', ?)").run(label);
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('current_hebrew_year_num', ?)").run(String(num));

console.log(`שנת הלימודים עודכנה ל: ${label} (${num})`);
db.close();
