// עוזר משותף לשיבוץ אוטומטי של תלמידים לסניף/כיתת "עדיין לא נכנסו" הנכונה,
// לפי הרחוב שבכתובת המשפחה. משלב את הרשימה הקבועה (streetZones.js) עם
// רחובות ש"נלמדו" בעבר (נבחרו ידנית פעם אחת ע"י מנהל ומאז נשמרים).
const { getZoneForAddress, ZONE_BRANCH, normalizeStreet } = require("./streetZones");

// מחזיר { zone, branch, source: 'static'|'learned' } או null אם הרחוב לא מוכר בכלל
function resolveZone(db, street, houseNumber) {
  const staticResult = getZoneForAddress(street, houseNumber);
  if (staticResult) return { ...staticResult, source: "static" };

  const clean = normalizeStreet(street);
  if (!clean) return null;
  const learned = db.prepare("SELECT zone, branch FROM street_zone_overrides WHERE street = ?").get(clean);
  if (learned) return { zone: learned.zone, branch: learned.branch, source: "learned" };

  return null;
}

// שומר רחוב חדש שנבחר ידנית, כדי שהפעם הבאה ישובץ אוטומטית
function saveZoneOverride(db, street, zone, branch) {
  const clean = normalizeStreet(street);
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
// שנמצאים כרגע ב"עדיין לא נכנסו", בלי כיתה בכלל, או עם הפניה לכיתה שכבר
// לא קיימת (class_id "תלוי באוויר") - ומזיז את מי שהרחוב שלו מזוהה למקבילה
// הנכונה. לא נוגע במי שכבר בכיתה אמיתית, ולא במי שהרחוב לא מזוהה כלל.
function runAutoZoneAssignment(db) {
  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.class_id, s.status, f.street, f.house_number
    FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    LEFT JOIN families f ON s.family_id = f.id
    WHERE s.status NOT IN ('ארכיון', 'לא התקבל')
      AND (s.class_id IS NULL OR c.id IS NULL OR c.name LIKE 'עדיין לא נכנסו%')
  `).all();

  let moved = 0;
  let skippedNoAddress = 0;
  let skippedUnresolved = [];
  for (const s of students) {
    if (!s.street || !s.street.trim()) { skippedNoAddress++; continue; }
    const result = resolveZone(db, s.street, s.house_number);
    if (!result) { skippedUnresolved.push(`${s.last_name} ${s.first_name} - "${s.street}" ${s.house_number || ""}`); continue; }
    const waitingClass = findWaitingClassForZone(db, result.zone);
    if (waitingClass && waitingClass.id !== s.class_id) {
      db.prepare("UPDATE students SET class_id = ? WHERE id = ?").run(waitingClass.id, s.id);
      moved++;
    }
  }
  if (skippedNoAddress > 0) console.log(`[שיבוץ אזורים] ${skippedNoAddress} תלמידים בלי כתובת כלל - דולגו`);
  if (skippedUnresolved.length > 0) {
    console.log(`[שיבוץ אזורים] ${skippedUnresolved.length} תלמידים עם רחוב לא מזוהה:`);
    skippedUnresolved.forEach((line) => console.log("  - " + line));
  }
  return moved;
}

module.exports = { resolveZone, saveZoneOverride, findWaitingClassForZone, isWaitingClass, runAutoZoneAssignment, ZONE_BRANCH };
