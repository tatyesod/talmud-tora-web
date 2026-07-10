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
    SELECT s.id, s.first_name, s.last_name, s.class_id, s.branch, s.status, f.street, f.house_number
    FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    LEFT JOIN families f ON s.family_id = f.id
    WHERE s.status NOT IN ('ארכיון', 'לא התקבל')
      AND (s.branch IS NULL OR s.branch = '' OR s.class_id IS NULL OR c.id IS NULL OR c.name LIKE 'עדיין לא נכנסו%')
  `).all();

  let moved = 0;
  let skippedNoAddress = 0;
  let skippedUnresolved = [];
  for (const s of students) {
    if (!s.street || !s.street.trim()) { skippedNoAddress++; continue; }
    const result = resolveZone(db, s.street, s.house_number);
    if (!result) { skippedUnresolved.push(`${s.last_name} ${s.first_name} - "${s.street}" ${s.house_number || ""}`); continue; }

    let changed = false;
    if (s.branch !== result.branch) {
      db.prepare("UPDATE students SET branch = ? WHERE id = ?").run(result.branch, s.id);
      changed = true;
    }
    // אם קיימת כיתת "עדיין לא נכנסו" פעילה מתאימה - משבצים אליה כבונוס
    // (אבל הסניף עצמו כבר נקבע למעלה בכל מקרה, גם בלי כיתה)
    if (!s.class_id || isWaitingClass(db, s.class_id)) {
      const waitingClass = findWaitingClassForZone(db, result.zone);
      if (waitingClass && waitingClass.id !== s.class_id) {
        db.prepare("UPDATE students SET class_id = ? WHERE id = ?").run(waitingClass.id, s.id);
        changed = true;
      }
    }
    if (changed) moved++;
  }
  if (skippedNoAddress > 0) console.log(`[שיבוץ אזורים] ${skippedNoAddress} תלמידים בלי כתובת כלל - דולגו`);
  if (skippedUnresolved.length > 0) {
    console.log(`[שיבוץ אזורים] ${skippedUnresolved.length} תלמידים עם רחוב לא מזוהה:`);
    skippedUnresolved.forEach((line) => console.log("  - " + line));
  }
  return moved;
}

// נפחא וסוקולוב שייכים לאותו אזור גיאוגרפי בפועל - נפחא פשוט לא קולט תלמידים
// חדשים ישירות (רק סוקולוב/בן פתחיה מחולקים לפי כתובת). לכן לצורך בדיקת
// "פיצול אחים בין סניפים", נפחא וסוקולוב נחשבים לאותו אזור ולא לסתירה.
const SAME_REGION_GROUPS = [["סוקולוב", "נפחא"], ["בן פתחיה"]];
function branchesInSameRegion(a, b) {
  if (!a || !b) return true; // אין מספיק מידע כדי לקבוע סתירה
  if (a === b) return true;
  return SAME_REGION_GROUPS.some((group) => group.includes(a) && group.includes(b));
}

// בודק אם קביעת סניף מסוים לתלמיד סותרת את הסניף של אח/אחות פעילים מאותה
// משפחה - כדי להתריע לפני שיבוץ שעלול "לפצל" משפחה בין אזורים אמיתיים.
function findSiblingBranchConflict(db, familyId, branch, excludeStudentId) {
  if (!familyId || !branch) return null;
  const siblings = db.prepare(`
    SELECT id, first_name, last_name, branch FROM students
    WHERE family_id = ? AND status = 'פעיל' AND branch IS NOT NULL AND TRIM(branch) != ''
    ${excludeStudentId ? "AND id != ?" : ""}
  `).all(...(excludeStudentId ? [familyId, excludeStudentId] : [familyId]));
  return siblings.find((s) => !branchesInSameRegion(s.branch, branch)) || null;
}

module.exports = { resolveZone, saveZoneOverride, findWaitingClassForZone, isWaitingClass, runAutoZoneAssignment, findSiblingBranchConflict, branchesInSameRegion, ZONE_BRANCH };
