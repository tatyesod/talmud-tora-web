// עוזר משותף לשיבוץ אוטומטי של תלמידים לסניף/כיתת "עדיין לא נכנסו" הנכונה,
// לפי הרחוב שבכתובת המשפחה. משלב את הרשימה הקבועה (streetZones.js) עם
// רחובות ש"נלמדו" בעבר (נבחרו ידנית פעם אחת ע"י מנהל ומאז נשמרים).
const { getZoneForAddress, ZONE_BRANCH } = require("./streetZones");

// מחזיר { zone, branch, source: 'static'|'learned' } או null אם הרחוב לא מוכר בכלל
function resolveZone(db, street, houseNumber) {
  const staticResult = getZoneForAddress(street, houseNumber);
  if (staticResult) return { ...staticResult, source: "static" };

  const clean = (street || "").trim();
  if (!clean) return null;
  const learned = db.prepare("SELECT zone, branch FROM street_zone_overrides WHERE street = ?").get(clean);
  if (learned) return { zone: learned.zone, branch: learned.branch, source: "learned" };

  return null;
}

// שומר רחוב חדש שנבחר ידנית, כדי שהפעם הבאה ישובץ אוטומטית
function saveZoneOverride(db, street, zone, branch) {
  const clean = (street || "").trim();
  if (!clean) return;
  db.prepare(`
    INSERT INTO street_zone_overrides (street, zone, branch, created_at) VALUES (?,?,?,?)
    ON CONFLICT(street) DO UPDATE SET zone = excluded.zone, branch = excluded.branch, created_at = excluded.created_at
  `).run(clean, zone, branch, new Date().toISOString());
}

// מוצא את כיתת "עדיין לא נכנסו" הפעילה שמתאימה למספר האזור (parallel = מספר האזור)
function findWaitingClassForZone(db, zone) {
  return db.prepare(
    "SELECT id, parallel, branch FROM classes WHERE name LIKE 'עדיין לא נכנסו%' AND parallel = ? AND status = 'פעיל' LIMIT 1"
  ).get(String(zone));
}

function isWaitingClass(db, classId) {
  if (!classId) return false;
  const c = db.prepare("SELECT name FROM classes WHERE id = ?").get(classId);
  return !!(c && c.name && c.name.startsWith("עדיין לא נכנסו"));
}

// שיבוץ אוטומטי ברקע (בלי צורך בביקור ידני במסך) - עובר על כל התלמידים
// שנמצאים כרגע ב"עדיין לא נכנסו" ומזיז את מי שהרחוב שלו מזוהה למקבילה הנכונה.
// לא נוגע במי שהרחוב לא מזוהה (אלה ממשיכים לדרוש טיפול ידני במסך השיבוץ).
function runAutoZoneAssignment(db) {
  const students = db.prepare(`
    SELECT s.id, s.class_id, f.street, f.house_number
    FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    LEFT JOIN families f ON s.family_id = f.id
    WHERE (s.class_id IS NULL OR c.name LIKE 'עדיין לא נכנסו%')
      AND s.status NOT IN ('ארכיון', 'לא התקבל')
  `).all();

  let moved = 0;
  for (const s of students) {
    const result = resolveZone(db, s.street, s.house_number);
    if (!result) continue;
    const waitingClass = findWaitingClassForZone(db, result.zone);
    if (waitingClass && waitingClass.id !== s.class_id) {
      db.prepare("UPDATE students SET class_id = ? WHERE id = ?").run(waitingClass.id, s.id);
      moved++;
    }
  }
  return moved;
}

module.exports = { resolveZone, saveZoneOverride, findWaitingClassForZone, isWaitingClass, runAutoZoneAssignment, ZONE_BRANCH };
