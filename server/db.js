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
  "ALTER TABLE classes ADD COLUMN room_description TEXT",
  "ALTER TABLE classes ADD COLUMN letter_template_id INTEGER",
  `CREATE TABLE IF NOT EXISTS letter_templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
  )`,
  "ALTER TABLE students ADD COLUMN birth_country TEXT DEFAULT 'ישראל'",
  "ALTER TABLE students ADD COLUMN immigration_year TEXT",
  "ALTER TABLE classes ADD COLUMN next_year_class_id INTEGER",
  `CREATE TABLE IF NOT EXISTS book_inventory (
    id INTEGER PRIMARY KEY,
    book_price_id INTEGER NOT NULL,
    branch TEXT NOT NULL,
    current_stock INTEGER DEFAULT 0,
    desired_stock INTEGER DEFAULT 0,
    updated_at TEXT,
    UNIQUE(book_price_id, branch)
  )`,
  "ALTER TABLE classes ADD COLUMN institution_code TEXT",
  "UPDATE classes SET institution_code = '512384' WHERE name LIKE 'כיתה %'",
  "ALTER TABLE supplier_orders ADD COLUMN dismissed_by_creator INTEGER DEFAULT 0",
  "ALTER TABLE teacher_attendance ADD COLUMN day_part TEXT DEFAULT 'יום שלם'",
  `CREATE TABLE IF NOT EXISTS supplier_contacts (
    id INTEGER PRIMARY KEY,
    supplier_id INTEGER NOT NULL,
    contact_name TEXT NOT NULL,
    phone TEXT,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS supplier_items (
    id INTEGER PRIMARY KEY,
    supplier_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    category TEXT,
    price REAL DEFAULT 0,
    created_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS supplier_item_inventory (
    id INTEGER PRIMARY KEY,
    supplier_item_id INTEGER NOT NULL,
    branch TEXT NOT NULL,
    current_stock INTEGER DEFAULT 0,
    desired_stock INTEGER DEFAULT 0,
    updated_at TEXT,
    UNIQUE(supplier_item_id, branch)
  )`,
  // מייבא את איש הקשר הקיים כבר בכרטיס הספק כאיש קשר ראשון בטבלת אנשי הקשר החדשה,
  // כדי לא לאבד מידע שכבר הוזן, ולתמוך מכאן והלאה בכמה אנשי קשר לספק
  `INSERT INTO supplier_contacts (supplier_id, contact_name, phone, created_at)
   SELECT id, contact_person, phone, datetime('now') FROM suppliers
   WHERE contact_person IS NOT NULL AND contact_person <> ''
     AND id NOT IN (SELECT DISTINCT supplier_id FROM supplier_contacts)`,
  // חברת גביה למשפחה - קשר / מוסדי / אחר (טקסט חופשי)
  "ALTER TABLE families ADD COLUMN billing_company TEXT",
  // הערות חופשיות לכל פריט במלאי ספק (לדוגמה: מק"ט, הערת ספק, וכו')
  "ALTER TABLE supplier_items ADD COLUMN notes TEXT",
  // רכיבי שכר למלמד - חלק מ"תיק עובד", חשוף למנהלים בלבד
  "ALTER TABLE teachers ADD COLUMN hourly_rate REAL",
  "ALTER TABLE teachers ADD COLUMN monthly_hours REAL",
  // רחובות שלא היו ברשימת שיוך האזורים הקבועה (streetZones.js) - נשמרים כאן
  // ברגע שמנהל בוחר ידנית סניף עבורם בפעם הראשונה, כדי שמכאן והלאה השיבוץ
  // יהיה אוטומטי לאותו רחוב.
  `CREATE TABLE IF NOT EXISTS street_zone_overrides (
    street TEXT PRIMARY KEY,
    zone INTEGER NOT NULL,
    branch TEXT NOT NULL,
    created_at TEXT
  )`,
];

for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (e) {
    // עמודה כבר קיימת — מתעלמים מהשגיאה
  }
}

// פיצול חד-פעמי של פריטי מחירון כלליים (חומש, קרא כצבי, בואו חשבון, כתיב וכתב, סודות הלשון)
// לפריטים ספציפיים לפי חלק/כרך - כדי שאפשר יהיה לנהל מלאי נפרד לכל חלק
try {
  const alreadySplit = db.prepare("SELECT value FROM settings WHERE key = 'book_prices_split_volumes_v1'").get();
  if (!alreadySplit) {
    const GENERIC_ITEMS_TO_REMOVE = ["חומש (כרוך) הדר", "קרא כצבי", "בואו חשבון", "כתיב וכתב", "סודות הלשון"];
    const delStmt = db.prepare("DELETE FROM book_prices WHERE item_name = ?");
    GENERIC_ITEMS_TO_REMOVE.forEach((name) => delStmt.run(name));

    const NEW_ITEMS = [
      // חומש - 5 חלקים, לפי השם המדויק שכבר בשימוש בקטלוג בפועל
      ['חומש "בראשית" (כרוך)', "הדר", 28],
      ['חומש "שמות" (כרוך)', "הדר", 28],
      ['חומש "ויקרא" (כרוך)', "הדר", 28],
      ['חומש "במדבר" (כרוך)', "הדר", 28],
      ['חומש "דברים" (כרוך)', "הדר", 28],
      // בואו חשבון - 7 חלקים
      ["בואו חשבון חלק 1", "", 32],
      ["בואו חשבון חלק 2", "", 32],
      ["בואו חשבון חלק 3", "", 32],
      ["בואו חשבון חלק 4", "", 32],
      ["בואו חשבון חלק 5", "", 32],
      ["בואו חשבון חלק 6", "", 32],
      ["בואו חשבון חלק 7", "", 32],
      // כתיב וכתב - חלקים 2-7 (כפי שכבר בשימוש בקטלוג)
      ["כתיב וכתב 2", "", 17],
      ["כתיב וכתב 3", "", 17],
      ["כתיב וכתב 4", "", 17],
      ["כתיב וכתב 5", "", 17],
      ["כתיב וכתב 6", "", 17],
      ["כתיב וכתב 7", "", 17],
      // סודות הלשון - חלקים ד'-ז' (כפי שכבר בשימוש בקטלוג)
      ["סודות הלשון ד'", "הלפרין", 33],
      ["סודות הלשון ה'", "הלפרין", 33],
      ["סודות הלשון ו'", "הלפרין", 33],
      ["סודות הלשון ז'", "הלפרין", 33],
      // קרא כצבי - 6 חלקים
      ["קרא כצבי חלק 1", "", 44],
      ["קרא כצבי חלק 2", "", 44],
      ["קרא כצבי חלק 3", "", 44],
      ["קרא כצבי חלק 4", "", 44],
      ["קרא כצבי חלק 5", "", 44],
      ["קרא כצבי חלק 6 (2 חלקים)", "", 44],
    ];
    const insertBookPrices = db.prepare("INSERT OR IGNORE INTO book_prices (item_name, publisher, price, updated_at) VALUES (?,?,?,?)");
    const insertPriceList = db.prepare("INSERT OR IGNORE INTO price_list (item_name, publisher, price, updated_at) VALUES (?,?,?,?)");
    const now = new Date().toISOString();
    NEW_ITEMS.forEach(([name, publisher, price]) => {
      insertBookPrices.run(name, publisher, price, now);
      insertPriceList.run(name, publisher, price, now);
    });

    const delPriceList = db.prepare("DELETE FROM price_list WHERE item_name = ?");
    GENERIC_ITEMS_TO_REMOVE.forEach((name) => delPriceList.run(name));

    db.prepare("INSERT INTO settings (key, value) VALUES ('book_prices_split_volumes_v1', '1')").run();
  }
} catch (e) {
  // לא קריטי - אפשר להוסיף/לערוך פריטים ידנית דרך עמוד "מחירון"
}

// זריעה/עדכון חד-פעמי של תבניות פתיחה למכתבי שיבוץ, מבוססות על 28 מכתבים אמיתיים
// (דגל ב-settings מבטיח שזה קורה פעם אחת בלבד, ולא דורס תבניות שהמנהל כתב/ערך בעצמו אחר כך)
try {
  const alreadySeededV2 = db.prepare("SELECT value FROM settings WHERE key = 'letter_templates_seeded_v4'").get();
  if (!alreadySeededV2) {
    const { SEED_TEMPLATES } = require("./letterTemplatesSeed");
    // מסיר תבניות ישנות (גרסה מקורית משוערת) שאף אחד לא הספיק לערוך אותן דרך המסך,
    // ומחליף אותן בגרסה המדויקת. כיתות ששויכו לתבנית ישנה ישויכו מחדש ל"ללא תבנית" לרגע.
    const oldTemplateIds = db.prepare("SELECT id FROM letter_templates").all().map((r) => r.id);
    if (oldTemplateIds.length > 0) {
      db.exec("UPDATE classes SET letter_template_id = NULL WHERE letter_template_id IN (" + oldTemplateIds.join(",") + ")");
      db.exec("DELETE FROM letter_templates");
    }
    const insertTpl = db.prepare("INSERT INTO letter_templates (name, body, created_at, updated_at) VALUES (?,?,?,?)");
    const now = new Date().toISOString();
    SEED_TEMPLATES.forEach((t) => insertTpl.run(t.name, t.body, now, now));
    db.prepare("INSERT INTO settings (key, value) VALUES ('letter_templates_seeded_v4', '1')").run();
  }
} catch (e) {
  // אם משהו נכשל - לא קריטי, אפשר ליצור תבניות ידנית דרך המסך
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

// הרצה חד-פעמית: שיבוץ מיידי לכל התלמידים הקיימים שאין להם כיתה/סניף
// (כולל תלמידים בסטטוס "לא פעיל"), לפי בקשת המשתמש - לא מחכים לריצה
// המתוזמנת הבאה (כל 3 שעות), אלא מריצים פעם אחת מיד עם העדכון הזה.
try {
  const alreadyRanInitialZoneAssignment = db.prepare("SELECT value FROM settings WHERE key = 'initial_zone_assignment_v2'").get();
  if (!alreadyRanInitialZoneAssignment) {
    const { runAutoZoneAssignment } = require("./zoneResolver");
    const moved = runAutoZoneAssignment(db);
    console.log(`[שיבוץ אזורים ראשוני] ${moved} תלמידים שובצו לסניף`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('initial_zone_assignment_v2', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בשיבוץ אזורים ראשוני:", e.message);
}

// זריעה חד-פעמית של קטלוג ציוד משרדי (מתוך קבצי אקסל שהמשתמש שלח) -
// יוצר את הספקים "עולם המדבקות" ו"גוונים" אם עוד לא קיימים, ומכניס את הפריטים כקטלוג בחירה
// (כדי שבמסך הזמנת ציוד משרדי אפשר יהיה לבחור פריט מתוך רשימה, ולא רק להקליד חופשי).
// דגל ב-settings מבטיח שזה קורה פעם אחת בלבד, ולא דורס/מכפיל פריטים שנוספו/נערכו ידנית אחר כך.
try {
  const alreadySeededSupplies = db.prepare("SELECT value FROM settings WHERE key = 'office_supplies_seeded_v1'").get();
  if (!alreadySeededSupplies) {
    const { OFFICE_SUPPLIES_SEED } = require("./officeSuppliesSeed");
    const now = new Date().toISOString();
    const findSupplier = db.prepare("SELECT id FROM suppliers WHERE name = ?");
    const insertSupplier = db.prepare("INSERT INTO suppliers (name, category, status, created_at) VALUES (?,?,?,?)");
    const findItem = db.prepare("SELECT id FROM supplier_items WHERE supplier_id = ? AND item_name = ?");
    const insertItem = db.prepare("INSERT INTO supplier_items (supplier_id, item_name, category, price, created_at) VALUES (?,?,?,?,?)");

    for (const supplierName of Object.keys(OFFICE_SUPPLIES_SEED)) {
      const existing = findSupplier.get(supplierName);
      const supplierId = existing ? existing.id : insertSupplier.run(supplierName, "ציוד משרדי", "פעיל", now).lastInsertRowid;
      for (const item of OFFICE_SUPPLIES_SEED[supplierName]) {
        if (!findItem.get(supplierId, item.item_name)) {
          insertItem.run(supplierId, item.item_name, item.category, 0, now);
        }
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('office_supplies_seeded_v1', '1')").run();
  }
} catch (e) {
  // לא קריטי - אפשר להוסיף פריטים ידנית דרך המסך
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
