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
  // סניף ישיר על התלמיד - בלי תלות בכיתה בכלל (יש תלמידים בלי כיתה,
  // או עם כיתה שאין לה עדיין "עדיין לא נכנסו" מתאימה, שעדיין צריכים סניף)
  "ALTER TABLE students ADD COLUMN branch TEXT",
  // סכום תרומה חודשי שמשפחה אמורה לתרום לתלמוד תורה (רישום סכום בלבד,
  // בלי מעקב תשלומים פרטני - בדיוק כמו שכר לימוד אבל פשוט יותר)
  "ALTER TABLE families ADD COLUMN monthly_donation_amount REAL",
  // תוספת כמות ידנית למלאי ספרים (מעבר למה שהוזמן בפועל דרך הזמנת ספרים
  // לכיתות) - לכל ספר לפי סניף. ברירת מחדל 5 יח' לכל ספר (מטופל ב-COALESCE
  // בשאילתות, בלי צורך למלא מראש כל שילוב ספר/סניף אפשרי).
  "ALTER TABLE book_inventory ADD COLUMN extra_quantity INTEGER",
  // שיוך ספרים לכיתות - כדי שהקטלוג (book_prices) יהיה מקור האמת היחיד
  // (שם, הוצאה, מחיר, כיתה, סניף), וקטלוג ההזמנה לכל כיתה (book_catalog)
  // יסונכרן ממנו אוטומטית - כך לא ייווצרו יותר אי-התאמות שמות בין הזמנות למלאי.
  `CREATE TABLE IF NOT EXISTS book_price_classes (
    id INTEGER PRIMARY KEY,
    book_price_id INTEGER NOT NULL,
    class_name TEXT NOT NULL,
    UNIQUE(book_price_id, class_name)
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

// בדיקה ממוקדת חד-פעמית: אם תבנית "מכינה א'" חסרה מסיבה כלשהי (למשל דיפלוי
// שלא הספיק להריץ את הזריעה המקורית) - מוסיפים רק אותה, בלי לגעת בשום תבנית
// אחרת (כדי לא לדרוס עריכות ידניות שנעשו למכתבים אחרים דרך מסך "ניהול תבניות").
try {
  const mechinaAExists = db.prepare("SELECT id FROM letter_templates WHERE name = ?").get("מכינה א'");
  if (!mechinaAExists) {
    const { SEED_TEMPLATES } = require("./letterTemplatesSeed");
    const mechinaATemplate = SEED_TEMPLATES.find((t) => t.name === "מכינה א'");
    if (mechinaATemplate) {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO letter_templates (name, body, created_at, updated_at) VALUES (?,?,?,?)").run(
        mechinaATemplate.name, mechinaATemplate.body, now, now
      );
      console.log('[מכתבי שיבוץ] נוספה תבנית "מכינה א\'" שהייתה חסרה');
    }
  }
} catch (e) {
  console.error("שגיאה בבדיקת תבנית מכינה א':", e.message);
}

// תיקון חד-פעמי ממוקד: מוודאים שקיימות 4 כיתות "עדיין לא נכנסו" (מקבילות 1-4,
// לפי חלוקת האזורים - 1,2 בסוקולוב, 3,4 בבן פתחיה) - נדרש גם לשיבוץ האוטומטי
// לפי אזור וגם למכתבי השיבוץ (כדי שלכל תלמיד "עדיין לא נכנסו" תהיה כיתה אמיתית
// לבחור לה תבנית מכתב ויעד). יוצר רק את המקבילות שבאמת חסרות, לא נוגע בקיימות.
try {
  const alreadyEnsured = db.prepare("SELECT value FROM settings WHERE key = 'waiting_classes_ensured_v1'").get();
  if (!alreadyEnsured) {
    const ZONE_BRANCH = { 1: "סוקולוב", 2: "סוקולוב", 3: "בן פתחיה", 4: "בן פתחיה" };
    // לוקחים ערכי ברירת מחדל (קטגוריה/סמל מוסד) מכיתת "עדיין לא נכנסו" קיימת אם יש כזו
    const existingSample = db.prepare("SELECT category_id, institution_code FROM classes WHERE name = 'עדיין לא נכנסו' LIMIT 1").get();
    const defaultCategoryId = existingSample ? existingSample.category_id : null;
    const defaultInstitutionCode = existingSample ? existingSample.institution_code : "512384";
    let created = 0;
    for (const zone of [1, 2, 3, 4]) {
      const exists = db.prepare("SELECT id FROM classes WHERE name = 'עדיין לא נכנסו' AND parallel = ?").get(String(zone));
      if (exists) continue;
      db.prepare(`
        INSERT INTO classes (name, parallel, status, category_id, branch, institution_code)
        VALUES ('עדיין לא נכנסו', ?, 'פעיל', ?, ?, ?)
      `).run(String(zone), defaultCategoryId, ZONE_BRANCH[zone], defaultInstitutionCode);
      created++;
    }
    console.log(`[כיתות עדיין לא נכנסו] נוצרו ${created} כיתות שהיו חסרות`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('waiting_classes_ensured_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה ביצירת כיתות עדיין לא נכנסו:", e.message);
}

// תיקון חד-פעמי ממוקד: מוסיף את מספר המחזור לשורת הפתיחה של תבנית "מכינה א'" -
// מחליף רק אם הטקסט המדויק הישן עדיין שם (כלומר לא נערך ידנית בינתיים).
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'mechina_a_cohort_line_v1'").get();
  if (!alreadyFixed) {
    const oldLine = "נקדם בברכה את תלמידי המחזור, ונאחל להם שפע ברכה והצלחה בדרך התורה והיראה.";
    const newLine = "נקדם בברכה את תלמידי {{cohort_name}}, ונאחל להם שפע ברכה והצלחה בדרך התורה והיראה.";
    const tpl = db.prepare("SELECT id, body FROM letter_templates WHERE name = ?").get("מכינה א'");
    if (tpl && tpl.body.includes(oldLine)) {
      const updatedBody = tpl.body.replace(oldLine, newLine);
      db.prepare("UPDATE letter_templates SET body = ?, updated_at = ? WHERE id = ?").run(
        updatedBody, new Date().toISOString(), tpl.id
      );
      console.log('[מכתבי שיבוץ] עודכנה שורת המחזור בתבנית "מכינה א\'"');
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('mechina_a_cohort_line_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בעדכון שורת המחזור:", e.message);
}

// תיקון חד-פעמי ממוקד: בתבנית "כיתה ח'" הייתה סתירה - שורה אחת אמרה שהלימודים
// מסתיימים ב-19:00 ושורה אחרת (נכונה) אמרה 19:30. מתקן רק אם הטקסט המדויק
// הישן עדיין שם (כלומר לא נערך ידנית בינתיים).
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'kita_h_end_time_fix_v1'").get();
  if (!alreadyFixed) {
    const oldLine = 'ולימודי אחה"צ 15:00-19:00.';
    const newLine = 'ולימודי אחה"צ 15:00-19:30.';
    const tpl = db.prepare("SELECT id, body FROM letter_templates WHERE name = ?").get("כיתה ח'");
    if (tpl && tpl.body.includes(oldLine)) {
      const updatedBody = tpl.body.replace(oldLine, newLine);
      db.prepare("UPDATE letter_templates SET body = ?, updated_at = ? WHERE id = ?").run(
        updatedBody, new Date().toISOString(), tpl.id
      );
      console.log('[מכתבי שיבוץ] תוקנה שעת סיום הלימודים בתבנית "כיתה ח\'"');
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('kita_h_end_time_fix_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בתיקון שעת סיום כיתה ח':", e.message);
}

// תיקון חד-פעמי (וארכיטקטוני, גרסה מתוקנת סופית): שיוך ספר הוא לפי **כיתה
// בלבד** (למשל "כיתה ב'") - בלי מקבילה ובלי סניף ידני, כי המערכת כבר יודעת
// באילו סניפים קיימת כל כיתה (מטבלת הכיתות עצמה) ומסננת לפי זה אוטומטית.
// "עדיין לא נכנסו", "מכינה א'" ו"מכינה ב'" לא כלולות - אין בהן הזמנת ספרים.
try {
  const alreadyMigrated = db.prepare("SELECT value FROM settings WHERE key = 'book_price_grades_v1'").get();
  if (!alreadyMigrated) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS book_price_grades (
        id INTEGER PRIMARY KEY,
        book_price_id INTEGER NOT NULL,
        class_name TEXT NOT NULL,
        UNIQUE(book_price_id, class_name)
      )
    `);
    const EXCLUDED_GRADES = ["עדיין לא נכנסו", "מכינה א'", "מכינה ב'"];
    const insert = db.prepare("INSERT OR IGNORE INTO book_price_grades (book_price_id, class_name) VALUES (?, ?)");

    // 1) משמרים מתוך שיוכי כיתה-סניף קודמים (אם קיימים) - רק שם הכיתה
    let carried = 0;
    try {
      const oldPairs = db.prepare("SELECT DISTINCT book_price_id, class_name FROM book_price_classes").all();
      oldPairs.forEach((p) => {
        if (!EXCLUDED_GRADES.includes(p.class_name)) { insert.run(p.book_price_id, p.class_name); carried++; }
      });
    } catch (e) { /* אין טבלה קודמת - לא קריטי */ }

    // 2) גם ישירות מתוך book_catalog (לפי מה שכבר בשימוש בפועל בהזמנות)
    const pairs = db.prepare(`
      SELECT DISTINCT bp.id AS book_price_id, bc.class_name
      FROM book_catalog bc
      JOIN book_prices bp ON TRIM(bp.item_name) = TRIM(bc.item_name)
    `).all();
    let fromCatalog = 0;
    pairs.forEach((p) => {
      if (!EXCLUDED_GRADES.includes(p.class_name)) { insert.run(p.book_price_id, p.class_name); fromCatalog++; }
    });

    console.log(`[קטלוג ספרים] שיוך ספר-כיתה: ${carried} משוחזרים, ${fromCatalog} מיובאים מהקטלוג`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('book_price_grades_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה ביצירת שיוכי ספר-כיתה:", e.message);
}

// תיקון חד-פעמי ממוקד: "כלי כתיבה - כיתות א-ג" שייך רק לכיתות א'-ג', ו"כלי
// כתיבה - כיתות ד-ז" שייך רק לכיתות ד'-ז' - קובעים את השיוך המדויק, ומכל
// הזמנה שנמצאה "תקועה" תחת המוצר הלא נכון (למשל תלמיד כיתה ד' עם הזמנה על
// "כלי כתיבה א-ג") - מעבירים אותה בפועל למוצר הנכון לכיתה שלו (לא רק
// משאירים כהערה - זו טעות ברורה שיש לה תיקון חד-משמעי, בניגוד למקרה כללי
// שדורש שיקול דעת).
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'writing_supplies_grades_fix_v3'").get();
  if (!alreadyFixed) {
    const findBook = (namePattern) => db.prepare(
      "SELECT id, item_name, publisher, price FROM book_prices WHERE item_name LIKE ? AND item_name LIKE ?"
    ).get("%כלי כתיבה%", `%${namePattern}%`);

    const bookAG = findBook("א-ג");
    const bookDZ = findBook("ד-ז");
    const gradesAG = ["כיתה א'", "כיתה ב'", "כיתה ג'"];
    const gradesDZ = ["כיתה ד'", "כיתה ה'", "כיתה ו'", "כיתה ז'"];

    const setGrades = (book, grades) => {
      if (!book) return;
      db.prepare("DELETE FROM book_price_grades WHERE book_price_id = ?").run(book.id);
      const insert = db.prepare("INSERT OR IGNORE INTO book_price_grades (book_price_id, class_name) VALUES (?, ?)");
      grades.forEach((g) => insert.run(book.id, g));
    };
    setGrades(bookAG, gradesAG);
    setGrades(bookDZ, gradesDZ);
    console.log(`[כלי כתיבה] תוקן שיוך: א-ג=${bookAG ? bookAG.item_name : "לא נמצא"}, ד-ז=${bookDZ ? bookDZ.item_name : "לא נמצא"}`);

    // עבור כל שורת קטלוג "תקועה" (מוצר לא נכון לכיתה שלה), מעבירים כל הזמנה
    // בפועל למוצר הנכון (יוצרים שורת קטלוג ליעד אם עוד אין), ואז מוחקים את
    // השורה הישנה שהתרוקנה.
    const fixStrayOrders = (wrongBook, wrongGrades, correctBook) => {
      if (!wrongBook || !correctBook) return { moved: 0, deleted: 0 };
      const strayRows = db.prepare(`
        SELECT id, year_label, class_name FROM book_catalog
        WHERE item_name = ? AND class_name NOT IN (${wrongGrades.map(() => "?").join(",")})
      `).all(wrongBook.item_name, ...wrongGrades);
      let moved = 0, deleted = 0;
      strayRows.forEach((row) => {
        let target = db.prepare(
          "SELECT id FROM book_catalog WHERE year_label = ? AND class_name = ? AND item_name = ?"
        ).get(row.year_label, row.class_name, correctBook.item_name);
        if (!target) {
          const info = db.prepare(
            "INSERT INTO book_catalog (year_label, class_name, item_name, publisher, price, sort_order) VALUES (?,?,?,?,?,0)"
          ).run(row.year_label, row.class_name, correctBook.item_name, correctBook.publisher, correctBook.price);
          target = { id: info.lastInsertRowid };
        }
        const result = db.prepare("UPDATE book_orders SET catalog_id = ? WHERE catalog_id = ?").run(target.id, row.id);
        moved += result.changes;
        db.prepare("DELETE FROM book_catalog WHERE id = ?").run(row.id);
        deleted++;
      });
      return { moved, deleted };
    };

    const fixAG = fixStrayOrders(bookAG, gradesAG, bookDZ);
    console.log(`[כלי כתיבה א-ג] ${fixAG.moved} הזמנות שהיו בטעות תחת א-ג בכיתות ד-ז - הועברו ל"כלי כתיבה ד-ז" הנכון (${fixAG.deleted} שורות ישנות נוקו)`);
    const fixDZ = fixStrayOrders(bookDZ, gradesDZ, bookAG);
    console.log(`[כלי כתיבה ד-ז] ${fixDZ.moved} הזמנות שהיו בטעות תחת ד-ז בכיתות א-ג - הועברו ל"כלי כתיבה א-ג" הנכון (${fixDZ.deleted} שורות ישנות נוקו)`);

    db.prepare("INSERT INTO settings (key, value) VALUES ('writing_supplies_grades_fix_v3', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בתיקון שיוך כלי כתיבה:", e.message);
}

// תיקון חד-פעמי: מעבירים את "כלי כתיבה - כיתות ד-ז" לעמודה האחרונה בכל
// כיתה שהוא מופיע בה (העמודות מסודרות לפי sort_order, אז קובעים לו ערך
// גבוה מכל שאר הפריטים באותה כיתה/שנה).
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'writing_supplies_dz_last_column_v1'").get();
  if (!alreadyFixed) {
    const rows = db.prepare("SELECT id, year_label, class_name FROM book_catalog WHERE item_name LIKE ? AND item_name LIKE ?").all("%כלי כתיבה%", "%ד-ז%");
    let updated = 0;
    rows.forEach((row) => {
      const maxSort = db.prepare(
        "SELECT MAX(sort_order) AS m FROM book_catalog WHERE year_label = ? AND class_name = ?"
      ).get(row.year_label, row.class_name).m || 0;
      db.prepare("UPDATE book_catalog SET sort_order = ? WHERE id = ?").run(maxSort + 1, row.id);
      updated++;
    });
    console.log(`[כלי כתיבה ד-ז] הועבר לעמודה אחרונה ב-${updated} כיתות`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('writing_supplies_dz_last_column_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בהעברת עמודת כלי כתיבה ד-ז:", e.message);
}

// תיקון חד-פעמי ממוקד: "גמרא בבא קמא (כרוך) טלמן" (עם פירוש/מהרש"א) שייכת
// רק לכיתה ז', ו"גמרא בבא קמא (כרוך) עוז והדר" (בלי פירוש) שייכת רק לכיתות
// ו'-ה' - בדיוק כמו התיקון של כלי כתיבה: קובעים שיוך מדויק, ומעבירים כל
// הזמנה שנמצאת בטעות תחת הגרסה הלא נכונה לגרסה הנכונה עבור הכיתה בפועל.
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'bava_kama_grades_fix_v1'").get();
  if (!alreadyFixed) {
    // "עם מהרש"א"/"טלמן" = עם פירוש; "עוז והדר" = בלי פירוש
    const bookWith = db.prepare("SELECT id, item_name, publisher, price FROM book_prices WHERE item_name LIKE '%גמרא בבא קמא%' AND (item_name LIKE '%מהרש%' OR item_name LIKE '%טלמן%') AND item_name NOT LIKE '%עוז והדר%'").get();
    const bookWithout = db.prepare("SELECT id, item_name, publisher, price FROM book_prices WHERE item_name LIKE '%גמרא בבא קמא%' AND item_name LIKE '%עוז והדר%'").get();

    const gradesWith = ["כיתה ז'"];
    const gradesWithout = ["כיתה ה'", "כיתה ו'"];

    const setGrades = (book, grades) => {
      if (!book) return;
      db.prepare("DELETE FROM book_price_grades WHERE book_price_id = ?").run(book.id);
      const insert = db.prepare("INSERT OR IGNORE INTO book_price_grades (book_price_id, class_name) VALUES (?, ?)");
      grades.forEach((g) => insert.run(book.id, g));
    };
    setGrades(bookWith, gradesWith);
    setGrades(bookWithout, gradesWithout);
    console.log(`[גמרא בבא קמא] תוקן שיוך: עם פירוש=${bookWith ? bookWith.item_name : "לא נמצא"}, בלי פירוש=${bookWithout ? bookWithout.item_name : "לא נמצא"}`);

    const fixStrayOrders = (wrongBook, wrongGrades, correctBook) => {
      if (!wrongBook || !correctBook) return { moved: 0, deleted: 0 };
      const strayRows = db.prepare(`
        SELECT id, year_label, class_name FROM book_catalog
        WHERE item_name = ? AND class_name NOT IN (${wrongGrades.map(() => "?").join(",")})
      `).all(wrongBook.item_name, ...wrongGrades);
      let moved = 0, deleted = 0;
      strayRows.forEach((row) => {
        let target = db.prepare(
          "SELECT id FROM book_catalog WHERE year_label = ? AND class_name = ? AND item_name = ?"
        ).get(row.year_label, row.class_name, correctBook.item_name);
        if (!target) {
          const info = db.prepare(
            "INSERT INTO book_catalog (year_label, class_name, item_name, publisher, price, sort_order) VALUES (?,?,?,?,?,0)"
          ).run(row.year_label, row.class_name, correctBook.item_name, correctBook.publisher, correctBook.price);
          target = { id: info.lastInsertRowid };
        }
        const result = db.prepare("UPDATE book_orders SET catalog_id = ? WHERE catalog_id = ?").run(target.id, row.id);
        moved += result.changes;
        db.prepare("DELETE FROM book_catalog WHERE id = ?").run(row.id);
        deleted++;
      });
      return { moved, deleted };
    };

    const fixWith = fixStrayOrders(bookWith, gradesWith, bookWithout);
    console.log(`[גמרא בבא קמא עם פירוש] ${fixWith.moved} הזמנות שהיו בטעות מחוץ לכיתה ז' - הועברו לגרסה בלי פירוש (${fixWith.deleted} שורות ישנות נוקו)`);
    const fixWithout = fixStrayOrders(bookWithout, gradesWithout, bookWith);
    console.log(`[גמרא בבא קמא בלי פירוש] ${fixWithout.moved} הזמנות שהיו בטעות בכיתה ז' - הועברו לגרסה עם פירוש (${fixWithout.deleted} שורות ישנות נוקו)`);

    db.prepare("INSERT INTO settings (key, value) VALUES ('bava_kama_grades_fix_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בתיקון שיוך גמרא בבא קמא:", e.message);
}

// תיקון כללי (לא רק בבא קמא): מוצא אוטומטית **כל** זוג גמרות באותה מסכת -
// גרסה "עם פירוש" (מהרש"א/טלמן) מול גרסה "בלי פירוש" (עוז והדר) - וקובע
// לכולן את אותו כלל: עם פירוש רק לכיתה ז', בלי פירוש רק לכיתות ה'-ו'.
// מזהה זוגות לפי "שם המסכת" (המילים אחרי "גמרא", בלי כל מילות התיאור).
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'gemara_commentary_split_v1'").get();
  if (!alreadyFixed) {
    const tractateKey = (name) => name
      .replace(/גמרא/g, "")
      .replace(/\([^)]*\)/g, " ")
      .replace(/עם מהרש"?א/g, " ")
      .replace(/טלמן|טלן/g, " ")
      .replace(/עוז והדר/g, " ")
      .replace(/["'׳״]/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const allGemaras = db.prepare("SELECT id, item_name, publisher, price FROM book_prices WHERE item_name LIKE '%גמרא%'").all();
    const byTractate = {};
    allGemaras.forEach((b) => {
      const key = tractateKey(b.item_name);
      if (!byTractate[key]) byTractate[key] = [];
      byTractate[key].push(b);
    });

    const gradesWith = ["כיתה ז'"];
    const gradesWithout = ["כיתה ה'", "כיתה ו'"];

    const setGrades = (book, grades) => {
      db.prepare("DELETE FROM book_price_grades WHERE book_price_id = ?").run(book.id);
      const insert = db.prepare("INSERT OR IGNORE INTO book_price_grades (book_price_id, class_name) VALUES (?, ?)");
      grades.forEach((g) => insert.run(book.id, g));
    };
    const fixStrayOrders = (wrongBook, wrongGrades, correctBook) => {
      const strayRows = db.prepare(`
        SELECT id, year_label, class_name FROM book_catalog
        WHERE item_name = ? AND class_name NOT IN (${wrongGrades.map(() => "?").join(",")})
      `).all(wrongBook.item_name, ...wrongGrades);
      let moved = 0, deleted = 0;
      strayRows.forEach((row) => {
        let target = db.prepare(
          "SELECT id FROM book_catalog WHERE year_label = ? AND class_name = ? AND item_name = ?"
        ).get(row.year_label, row.class_name, correctBook.item_name);
        if (!target) {
          const info = db.prepare(
            "INSERT INTO book_catalog (year_label, class_name, item_name, publisher, price, sort_order) VALUES (?,?,?,?,?,0)"
          ).run(row.year_label, row.class_name, correctBook.item_name, correctBook.publisher, correctBook.price);
          target = { id: info.lastInsertRowid };
        }
        const result = db.prepare("UPDATE book_orders SET catalog_id = ? WHERE catalog_id = ?").run(target.id, row.id);
        moved += result.changes;
        db.prepare("DELETE FROM book_catalog WHERE id = ?").run(row.id);
        deleted++;
      });
      return { moved, deleted };
    };

    let fixedTractates = 0;
    Object.entries(byTractate).forEach(([key, books]) => {
      if (books.length !== 2 || !key) return; // רק זוגות ברורים - לא נוגעים בשלישיות/יחידות מעורפלות
      const withBook = books.find((b) => /מהרש|טלמן|טלן/.test(b.item_name) && !/עוז והדר/.test(b.item_name));
      const withoutBook = books.find((b) => /עוז והדר/.test(b.item_name));
      if (!withBook || !withoutBook || withBook.id === withoutBook.id) return; // לא זוג "עם/בלי פירוש" מובהק

      setGrades(withBook, gradesWith);
      setGrades(withoutBook, gradesWithout);
      const r1 = fixStrayOrders(withBook, gradesWith, withoutBook);
      const r2 = fixStrayOrders(withoutBook, gradesWithout, withBook);
      console.log(`[גמרא ${key}] עם פירוש→ז' בלבד, בלי פירוש→ה'-ו' בלבד. הזמנות שהועברו: ${r1.moved + r2.moved}`);
      fixedTractates++;
    });
    console.log(`[גמרא - תיקון כללי] תוקנו ${fixedTractates} מסכתות עם פיצול עם/בלי פירוש`);

    db.prepare("INSERT INTO settings (key, value) VALUES ('gemara_commentary_split_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בתיקון כללי של גמרות עם/בלי פירוש:", e.message);
}

// תיקון חד-פעמי: מאחדים את הניסוח "מלמד ומחנך עם ניסיון רב ב..." בכל מכתבי
// השיבוץ (מכינה א'-כיתה ז') - חלקם היו כתובים "מלמד עם ניסיון" (בלי
// "ומחנך"), חלקם עם שגיאת כתיב "נסיון" (בלי י'), ואחד בלי המילה "רב" בכלל.
// כיתה ח' נשארת בדיוק כפי שהיא (יש לה נוסח שונה במכוון - "ר"מ ומחנך").
// מחליפים רק אם הטקסט המדויק הישן עדיין שם (לא נערך ידנית בינתיים).
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'teacher_experience_wording_v1'").get();
  if (!alreadyFixed) {
    const fixes = [
      { name: "מכינה א'", old: "מלמד עם ניסיון רב בשנים בהקניית האותיות והניקוד.", new: "מלמד ומחנך עם ניסיון רב בהקניית האותיות והניקוד." },
      { name: "מכינה ב'", old: "מלמד עם נסיון רב בשנים בלימוד קריאה.", new: "מלמד ומחנך עם ניסיון רב בלימוד קריאה." },
      { name: "כיתה א'", old: "שהינו מלמד עם ניסיון בלימוד חומש בראשית.", new: "שהינו מלמד ומחנך עם ניסיון רב בלימוד חומש בראשית." },
      { name: "כיתה ד'", old: "מלמד עם ניסיון רב בלימוד גמרא ומשניות.", new: "מלמד ומחנך עם ניסיון רב בלימוד גמרא ומשניות." },
      { name: "כיתה ה'", old: "מלמד עם ניסיון רב בלימוד גמרא ומשניות.", new: "מלמד ומחנך עם ניסיון רב בלימוד גמרא ומשניות." },
      { name: "כיתה ו'", old: "מלמד עם ניסיון רב בלימוד גמרא ומשניות.", new: "מלמד ומחנך עם ניסיון רב בלימוד גמרא ומשניות." },
    ];
    let fixedCount = 0;
    fixes.forEach((f) => {
      const tpl = db.prepare("SELECT id, body FROM letter_templates WHERE name = ?").get(f.name);
      if (tpl && tpl.body.includes(f.old)) {
        const updatedBody = tpl.body.replace(f.old, f.new);
        db.prepare("UPDATE letter_templates SET body = ?, updated_at = ? WHERE id = ?").run(updatedBody, new Date().toISOString(), tpl.id);
        fixedCount++;
      }
    });
    console.log(`[מכתבי שיבוץ] אוחד ניסוח "ניסיון רב" ב-${fixedCount} תבניות (כיתה ח' לא נגעה)`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('teacher_experience_wording_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה באיחוד ניסוח ניסיון רב:", e.message);
}

// תיקון חד-פעמי: בכל מכתבי השיבוץ נכתב "יום ראשון א' אלול" - אבל אם יום
// שישי הוא א' אלול (וזה נכון ונשאר כך), אז יום ראשון שאחריו הוא בעצם ג'
// אלול (יומיים אחרי שישי), לא א' אלול. זו טעות עובדתית בתאריך שחוזרת בכל
// הכיתות (כולל כיתה ח' - זו טעות בתאריך, לא עניין של ניסוח). "יום שישי א'
// אלול" עצמו נכון ונשאר בלי שינוי.
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'sunday_date_fix_v1'").get();
  if (!alreadyFixed) {
    const oldText = "יום ראשון א' אלול";
    const newText = "יום ראשון ג' אלול";
    const templates = db.prepare("SELECT id, name, body FROM letter_templates WHERE body LIKE ?").all(`%${oldText}%`);
    let fixedCount = 0, occurrencesFixed = 0;
    templates.forEach((tpl) => {
      const count = tpl.body.split(oldText).length - 1;
      const updatedBody = tpl.body.split(oldText).join(newText);
      db.prepare("UPDATE letter_templates SET body = ?, updated_at = ? WHERE id = ?").run(updatedBody, new Date().toISOString(), tpl.id);
      fixedCount++;
      occurrencesFixed += count;
    });
    console.log(`[מכתבי שיבוץ] תוקן תאריך "יום ראשון" מא' אלול לג' אלול ב-${fixedCount} תבניות (${occurrencesFixed} מופעים)`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('sunday_date_fix_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בתיקון תאריך יום ראשון:", e.message);
}

// ניקוי כללי ומקיף (לא רק ספר-ספר ספציפי): עובר על **כל** שורות קטלוג
// ההזמנה, בכל הכיתות ובכל השנים, ומוחק כל שורה שהספר שלה כבר לא משויך
// לאותה כיתה דרך "שיוך ספר לכיתה" - **ורק אם אין עליה אף הזמנה אמיתית**.
// זה בדיוק הפער שזוהה: אין סנכרון בזמן אמת בין שיוך הספר לבין קטלוג
// ההזמנה, אז שורות ישנות (מלפני שהשיוך תוקן, או שמעולם לא היו אמורות
// להיות שם) ממשיכות "להיתקע" ולהופיע כעמודות מיותרות. שורות עם הזמנה
// אמיתית לא נמחקות - הן ימשיכו להופיע בבדיקת ההתאמות לבדיקה ידנית.
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'general_orphan_catalog_cleanup_v1'").get();
  if (!alreadyFixed) {
    const orphanRows = db.prepare(`
      SELECT bc.id, bc.item_name, bc.class_name
      FROM book_catalog bc
      JOIN book_prices bp ON TRIM(bp.item_name) = TRIM(bc.item_name)
      WHERE NOT EXISTS (
        SELECT 1 FROM book_price_grades bpg WHERE bpg.book_price_id = bp.id AND bpg.class_name = bc.class_name
      )
    `).all();
    let removed = 0, keptWithOrders = 0;
    orphanRows.forEach((row) => {
      const orderCount = db.prepare("SELECT COUNT(*) c FROM book_orders WHERE catalog_id = ?").get(row.id).c;
      if (orderCount === 0) {
        db.prepare("DELETE FROM book_catalog WHERE id = ?").run(row.id);
        removed++;
      } else {
        keptWithOrders++; // יש הזמנה אמיתית - יופיע בבדיקת ההתאמות לבדיקה ידנית, לא נמחק
      }
    });
    console.log(`[ניקוי קטלוג כללי] נוקו ${removed} שורות קטלוג מיותרות (ספר לא משויך לכיתה, בלי הזמנות). ${keptWithOrders} שורות עם הזמנות אמיתיות נשמרו (יופיעו בבדיקת ההתאמות לבדיקה ידנית).`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('general_orphan_catalog_cleanup_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בניקוי קטלוג כללי:", e.message);
}

// תיקון חד-פעמי ממוקד: משנים את שם "כלי כתיבה - כיתות ד-ז" ל"כלי כתיבה -
// כיתות ד-ו", ומסירים את כיתה ז' מהשיוך שלו (נשארות רק ד', ה', ו'). משנים
// את השם גם בקטלוג ההזמנה עצמו (כל השורות עם השם הישן, בכל הכיתות/שנים) -
// כדי שההזמנות הקיימות ימשיכו להיות מקושרות נכון תחת השם החדש.
try {
  const alreadyFixed = db.prepare("SELECT value FROM settings WHERE key = 'writing_supplies_dv_rename_v1'").get();
  if (!alreadyFixed) {
    const book = db.prepare("SELECT id, item_name FROM book_prices WHERE item_name LIKE ? AND item_name LIKE ?").get("%כלי כתיבה%", "%ד-ז%");
    if (book) {
      const oldName = book.item_name;
      const newName = oldName.replace("ד-ז", "ד-ו");
      db.prepare("UPDATE book_prices SET item_name = ?, updated_at = ? WHERE id = ?").run(newName, new Date().toISOString(), book.id);
      db.prepare("UPDATE book_catalog SET item_name = ? WHERE TRIM(item_name) = TRIM(?)").run(newName, oldName);
      db.prepare("DELETE FROM book_price_grades WHERE book_price_id = ? AND class_name = ?").run(book.id, "כיתה ז'");
      console.log(`[כלי כתיבה] שונה שם מ-"${oldName}" ל-"${newName}", והוסרה כיתה ז' מהשיוך`);
    } else {
      console.log('[כלי כתיבה] לא נמצא ספר "כלי כתיבה ... ד-ז" לשינוי שם');
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('writing_supplies_dv_rename_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בשינוי שם כלי כתיבה ד-ו:", e.message);
}

// טבלת חופשות מוסד - תקופות (תאריך התחלה-סוף, לפי סריאל גישה כמו event_date)
// שיסומנו בצבע שונה על לוח השנה
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vacations (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      start_date INTEGER NOT NULL,
      end_date INTEGER NOT NULL,
      created_at TEXT
    )
  `);
} catch (e) {
  console.error("שגיאה ביצירת טבלת חופשות:", e.message);
}

// מנגנון "איפוס הזמנה" בהזמנת ספרים: כשמוציאים הזמנה בפועל לספק, לוחצים
// "איפוס" - זה שומר תמונת מצב (checkpoint) של מה שהוזמן (לפי סניף), ומאותו
// רגע "כמות להזמנה" מחושבת רק מהזמנות **חדשות** שנוספו אחרי האיפוס - בלי
// לאבד או למחוק אף הזמנה אמיתית של תלמיד. איפוס קורה **רק** בלחיצה מפורשת,
// לעולם לא אוטומטית.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_order_checkpoints (
      id INTEGER PRIMARY KEY,
      branch TEXT NOT NULL,
      year_label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      note TEXT
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_order_checkpoint_items (
      id INTEGER PRIMARY KEY,
      checkpoint_id INTEGER NOT NULL,
      book_price_id INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      publisher TEXT,
      ordered_count INTEGER NOT NULL,
      extra_quantity INTEGER NOT NULL,
      current_stock INTEGER NOT NULL,
      to_order INTEGER NOT NULL,
      received_quantity INTEGER,
      reconciliation_notes TEXT,
      FOREIGN KEY(checkpoint_id) REFERENCES book_order_checkpoints(id)
    )
  `);
} catch (e) {
  console.error("שגיאה ביצירת טבלאות איפוס הזמנת ספרים:", e.message);
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
  const alreadyRanInitialZoneAssignment = db.prepare("SELECT value FROM settings WHERE key = 'initial_zone_assignment_v5'").get();
  if (!alreadyRanInitialZoneAssignment) {
    const { runAutoZoneAssignment } = require("./zoneResolver");
    const moved = runAutoZoneAssignment(db);
    console.log(`[שיבוץ אזורים ראשוני] ${moved} תלמידים שובצו לסניף`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('initial_zone_assignment_v5', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בשיבוץ אזורים ראשוני:", e.message);
}

// תיקון חד-פעמי: תלמידים לא פעילים (למשל בכיתת "עדיין לא נכנסו") שיובצו
// אוטומטית לפי אזור מגורים, יכלו להיות "מפוצלים" מהאחים הפעילים שלהם אם
// יש התנגשות אזור אמיתית (סוקולוב/נפחא מול בן פתחיה). נפחא וסוקולוב הם
// אותו אזור גיאוגרפי בפועל (נפחא פשוט לא קולט חדשים ישירות) - so that's
// לא נחשב פיצול. מיישרים כל אח לא פעיל לסניף של אח/אחות פעילים מאותה
// משפחה, רק כשיש התנגשות אזור אמיתית. תלמידים בלי אחים פעילים - לא נוגעים
// בהם. תלמידים שכבר בכיתה אמיתית (לא "עדיין לא נכנסו") - לעולם לא נוגעים
// בשדה הסניף הישיר שלהם, כי הסניף שלהם תמיד נגזר מהכיתה עצמה.
try {
  const alreadyAlignedSiblings = db.prepare("SELECT value FROM settings WHERE key = 'sibling_branch_alignment_v3'").get();
  if (!alreadyAlignedSiblings) {
    const { branchesInSameRegion } = require("./zoneResolver");
    const families = db.prepare(`
      SELECT DISTINCT family_id FROM students
      WHERE family_id IS NOT NULL AND status NOT IN ('ארכיון', 'לא התקבל')
    `).all();
    let aligned = 0;
    for (const { family_id } of families) {
      const activeSibling = db.prepare(`
        SELECT COALESCE(c.branch, s.branch) AS effective_branch
        FROM students s LEFT JOIN classes c ON s.class_id = c.id
        WHERE s.family_id = ? AND s.status = 'פעיל'
          AND COALESCE(c.branch, s.branch) IS NOT NULL AND TRIM(COALESCE(c.branch, s.branch)) != ''
        LIMIT 1
      `).get(family_id);
      if (!activeSibling) continue;
      // רק אחים שאין להם כיתה אמיתית (בלי כיתה בכלל, או ב"עדיין לא נכנסו" בלבד) -
      // מי שכבר בכיתה אמיתית לעולם לא נוגעים בסניף הישיר שלו.
      const siblingsToCheck = db.prepare(`
        SELECT s.id, s.branch FROM students s LEFT JOIN classes c ON s.class_id = c.id
        WHERE s.family_id = ? AND s.status != 'פעיל'
          AND (s.class_id IS NULL OR c.id IS NULL OR c.name LIKE 'עדיין לא נכנסו%')
      `).all(family_id);
      for (const sib of siblingsToCheck) {
        if (!branchesInSameRegion(sib.branch, activeSibling.effective_branch)) {
          db.prepare("UPDATE students SET branch = ? WHERE id = ?").run(activeSibling.effective_branch, sib.id);
          aligned++;
        }
      }
    }
    // ניקוי: תלמידים שכן בכיתה אמיתית אבל יש להם בכל זאת ערך שגוי בשדה הסניף
    // הישיר (מקוד ישן, לפני התיקון) - מנקים את השדה כי הוא לא אמור לשמש
    // בכלל כשיש כיתה אמיתית עם סניף משלה.
    const cleaned = db.prepare(`
      UPDATE students SET branch = NULL
      WHERE id IN (
        SELECT s.id FROM students s JOIN classes c ON s.class_id = c.id
        WHERE c.name NOT LIKE 'עדיין לא נכנסו%' AND s.branch IS NOT NULL
      )
    `).run();
    console.log(`[יישור סניף אחים] ${aligned} תלמידים לא פעילים יושרו, ${cleaned.changes} שדות סניף שגויים נוקו מתלמידים בכיתה אמיתית`);
    db.prepare("INSERT INTO settings (key, value) VALUES ('sibling_branch_alignment_v3', '1')").run();
  }
} catch (e) {
  console.error("שגיאה ביישור סניף אחים:", e.message);
}

// תיקון חד-פעמי: שינוי שם הפריט "משניות" ל"משניות ברכות" במחירון הספרים
try {
  const alreadyRenamed = db.prepare("SELECT value FROM settings WHERE key = 'rename_mishnayot_v1'").get();
  if (!alreadyRenamed) {
    db.prepare("UPDATE book_prices SET item_name = 'משניות ברכות' WHERE item_name = 'משניות'").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('rename_mishnayot_v1', '1')").run();
  }
} catch (e) {
  console.error("שגיאה בשינוי שם משניות:", e.message);
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
