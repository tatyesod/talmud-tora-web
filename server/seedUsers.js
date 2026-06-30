// יוצר 4 משתמשים ראשוניים אם טבלת users ריקה. מריצים פעם אחת אחרי import_data.py
const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const { hashPassword } = require("./auth");

const dbPath = path.join(__dirname, "data", "talmud-tora.db");
const db = new DatabaseSync(dbPath);

const existing = db.prepare("SELECT COUNT(*) c FROM users").get();
if (existing.c > 0) {
  console.log(`כבר קיימים ${existing.c} משתמשים - לא נוצרו משתמשים חדשים.`);
  process.exit(0);
}

const defaultUsers = [
  { username: "admin", password: "admin123", display_name: "מנהל המערכת" },
  { username: "user2", password: "user2123", display_name: "משתמש 2" },
  { username: "user3", password: "user3123", display_name: "משתמש 3" },
  { username: "user4", password: "user4123", display_name: "משתמש 4" },
];

const stmt = db.prepare(
  "INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?,?,?,?)"
);

for (const u of defaultUsers) {
  stmt.run(u.username, hashPassword(u.password), u.display_name, new Date().toISOString());
  console.log(`נוצר משתמש: ${u.username} / ${u.password} (${u.display_name})`);
}

console.log("\nחשוב: שנו את הסיסמאות האלו דרך 'ניהול משתמשים' לאחר הכניסה הראשונה!");
db.close();
