const db = require("./db");
const hd = require("./hebrewDate");

const GRADE_ORDER = [
  "מכינה א'", "מכינה ב'", "כיתה א'", "כיתה ב'", "כיתה ג'",
  "כיתה ד'", "כיתה ה'", "כיתה ו'", "כיתה ז'", "כיתה ח'",
];

function getCurrentYear() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'current_hebrew_year'").get();
  if (row) return row.value;
  // ברירת מחדל: תשפ"ז (5787) — ניתן לשנות ידנית דרך עמוד "שנת לימודים"
  const label = 'תשפ"ז';
  const num = 5787;
  db.prepare("INSERT INTO settings (key, value) VALUES ('current_hebrew_year', ?)").run(label);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('current_hebrew_year_num', ?)").run(String(num));
  return label;
}

function getCurrentYearNum() {
  getCurrentYear(); // מבטיח אתחול
  const row = db.prepare("SELECT value FROM settings WHERE key = 'current_hebrew_year_num'").get();
  return row ? parseInt(row.value) : hd.currentHebrewYearNumber();
}

function listSnapshots() {
  return db.prepare("SELECT id, year_label, created_at FROM year_snapshots ORDER BY id DESC").all();
}

function getSnapshot(id) {
  const row = db.prepare("SELECT * FROM year_snapshots WHERE id = ?").get(id);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) };
}

// מוצא כיתת יעד לתלמיד עבור הכיתה הנוכחית, לפי שם, ומקבילה (אם אפשר), בכיתות פעילות בלבד
function findTargetClass(currentClass) {
  if (!currentClass) return { archive: false, classId: null }; // אין כיתה - לא נוגעים

  // "מעבר לכיתה (בהעלאת שנה)" - אם הוגדר, זו המקבילה שאליה עוברים בהעלאת שנה
  // (למשל כדי לאפשר "מכינה א'1 -> מכינה ב'2"); אם ריק, ברירת המחדל היא אותה מקבילה כמו היום
  const targetParallel = (currentClass.transfer_number !== null && currentClass.transfer_number !== undefined && currentClass.transfer_number !== "")
    ? currentClass.transfer_number
    : currentClass.parallel;

  // עדיין לא נכנסו -> מכינה א' לפי מקבילה
  if (currentClass.name && currentClass.name.startsWith("עדיין לא נכנסו")) {
    const target = db
      .prepare("SELECT id FROM classes WHERE name = ? AND parallel = ? AND status = 'פעיל' LIMIT 1")
      .get("מכינה א'", targetParallel);
    if (target) return { archive: false, classId: target.id };
    const fallback = db
      .prepare("SELECT id FROM classes WHERE name = ? AND status = 'פעיל' ORDER BY parallel LIMIT 1")
      .get("מכינה א'");
    return { archive: false, classId: fallback ? fallback.id : null };
  }

  const idx = GRADE_ORDER.indexOf(currentClass.name);
  if (idx === -1) return { archive: false, classId: null }; // כיתה לא מוכרת בסדר הקידום - לא נוגעים

  if (idx === GRADE_ORDER.length - 1) {
    // כיתה ח' - מעבר לארכיון
    return { archive: true, classId: null };
  }

  const nextName = GRADE_ORDER[idx + 1];
  const target = db
    .prepare("SELECT id FROM classes WHERE name = ? AND parallel = ? AND status = 'פעיל' LIMIT 1")
    .get(nextName, targetParallel);
  if (target) return { archive: false, classId: target.id };

  const fallback = db
    .prepare("SELECT id FROM classes WHERE name = ? AND status = 'פעיל' ORDER BY parallel LIMIT 1")
    .get(nextName);
  return { archive: false, classId: fallback ? fallback.id : null };
}

function snapshotCurrentState(yearLabel) {
  const students = db
    .prepare(`
      SELECT s.id, s.first_name, s.last_name, s.id_number, s.status,
             c.name AS class_name, c.parallel AS class_parallel,
             co.name AS cohort_name, f.last_name AS family_last_name
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN cohorts co ON s.cohort_id = co.id
      LEFT JOIN families f ON s.family_id = f.id
    `)
    .all();

  const data = JSON.stringify({ students });
  const createdAt = new Date().toISOString();
  const info = db
    .prepare("INSERT INTO year_snapshots (year_label, created_at, data) VALUES (?,?,?)")
    .run(yearLabel, createdAt, data);
  return info.lastInsertRowid;
}

// מבצע את העלאת השנה: שומר תמונת מצב, מקדם תלמידים בכיתה, מעלה שנה
function promoteYear() {
  const currentLabel = getCurrentYear();
  const currentNum = getCurrentYearNum();

  // 1. שמירת תמונת מצב של השנה היוצאת
  snapshotCurrentState(currentLabel);

  // 2. קידום תלמידים פעילים/לא פעילים המשובצים לכיתה
  const classes = db.prepare("SELECT * FROM classes").all();
  const classMap = new Map(classes.map((c) => [c.id, c]));

  const studentsWithClass = db
    .prepare("SELECT id, class_id, status FROM students WHERE class_id IS NOT NULL")
    .all();

  let promoted = 0;
  let archived = 0;
  let movedToMechina = 0;

  for (const s of studentsWithClass) {
    const currentClass = classMap.get(s.class_id);
    if (!currentClass) continue;
    const result = findTargetClass(currentClass);

    if (result.archive) {
      db.prepare("UPDATE students SET class_id = NULL, status = 'ארכיון' WHERE id = ?").run(s.id);
      archived++;
    } else if (result.classId) {
      const wasNotYetIn = currentClass.name && currentClass.name.startsWith("עדיין לא נכנסו");
      const newStatus = wasNotYetIn ? "פעיל" : s.status;
      db.prepare("UPDATE students SET class_id = ?, status = ? WHERE id = ?").run(
        result.classId, newStatus, s.id
      );
      if (wasNotYetIn) movedToMechina++;
      else promoted++;
    }
    // אם classId === null ולא ארכיון - לא נוגעים (כיתה לא מוכרת בסדר הקידום)
  }

  // 3. תלמידים ללא כיתה (אחים קטנים) - לא נוגעים, נשארים ללא כיתה בסטטוס לא פעיל כפי שהם

  // 4. איפוס שדה "מעבר לכיתה (בהעלאת שנה)" בכל הכיתות - החריגות שהוגדרו היו רלוונטיות
  //    להעלאת השנה הזו בלבד; לשנה הבאה חוזרים לברירת המחדל (אותה מקבילה), אלא אם יוגדר מחדש בכוונה
  db.prepare("UPDATE classes SET transfer_number = NULL").run();

  // 5. העלאת מספר השנה
  const newNum = currentNum + 1;
  const newLabel = hd.formatHebrewYear(newNum);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('current_hebrew_year', ?)").run(newLabel);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('current_hebrew_year_num', ?)").run(String(newNum));

  return { previousLabel: currentLabel, newLabel, promoted, archived, movedToMechina };
}

module.exports = {
  getCurrentYear,
  getCurrentYearNum,
  listSnapshots,
  getSnapshot,
  promoteYear,
  GRADE_ORDER,
};
