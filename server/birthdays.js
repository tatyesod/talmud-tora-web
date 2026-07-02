// birthdays.js
// חישוב "ימי הולדת קרובים" לפי הלוח העברי, לשימוש בחלונית "שהשמחה במעונם" בעמוד הבית.
const hd = require("./hebrewDate");

// מוצגים רק ימי הולדת של היום עצמו (מתעדכן אוטומטית ב-00:00 שעון ישראל, ר' todayAbsolute)
const LOOKAHEAD_DAYS = 0;

// ממיר חודש לידה עברי לחודש "מותאם" לשנה היעד, כדי להתמודד עם אדר/אדר א'/אדר ב'
// בין שנים מעוברות לפשוטות (מוסכמה נפוצה: מי שנולד באדר של שנה פשוטה חוגג באדר ב' בשנה מעוברת).
function adjustedHebrewMonth(birthMonth, birthYear, targetYear) {
  const targetIsLeap = hd.isHebrewLeapYear(targetYear);
  if (birthMonth === 13) {
    // נולד באדר ב' (קיים רק בשנה מעוברת)
    return targetIsLeap ? 13 : 12;
  }
  if (birthMonth === 12) {
    const birthIsLeap = hd.isHebrewLeapYear(birthYear);
    if (birthIsLeap) return 12; // נולד באדר א' של שנה מעוברת - נשאר חודש 12
    return targetIsLeap ? 13 : 12; // נולד ב"אדר" היחיד של שנה פשוטה
  }
  return birthMonth;
}

// מחזיר {daysAway, hebrewStr} לתאריך הלידה העברי הקרוב ביותר (כולל היום), או null אם אין תאריך
function nextHebrewBirthday(birthSerial) {
  const birth = hd.serialToHebrewParts(birthSerial);
  if (!birth) return null;

  const todayAbs = hd.todayAbsolute();
  const todayParts = hd.todayHebrewParts();

  const computeForYear = (year) => {
    const month = adjustedHebrewMonth(birth.month, birth.year, year);
    const maxDay = hd.daysInHebrewMonth(month, year);
    const day = Math.min(birth.day, maxDay);
    return hd.hebrewPartsToAbsolute(year, month, day);
  };

  let abs = computeForYear(todayParts.year);
  if (abs < todayAbs) {
    abs = computeForYear(todayParts.year + 1);
  }

  const daysAway = abs - todayAbs;
  return { daysAway, hebrewStr: hd.serialToHebrewString(birthSerial) };
}

// מקבל רשימת ישויות עם { id, name, birth_date_civil, ...extra } ומחזיר רק אלו
// שיום ההולדת העברי שלהם חל בטווח הקרוב, ממוינים מהקרוב ביותר
function upcomingBirthdays(people) {
  return people
    .map((p) => {
      const info = nextHebrewBirthday(p.birth_date_civil);
      if (!info) return null;
      return { ...p, daysAway: info.daysAway, hebrewStr: info.hebrewStr };
    })
    .filter((p) => p && p.daysAway >= 0 && p.daysAway <= LOOKAHEAD_DAYS)
    .sort((a, b) => a.daysAway - b.daysAway || a.name.localeCompare(b.name, "he"));
}

function daysAwayLabel(daysAway) {
  if (daysAway === 0) return "היום! 🎉";
  if (daysAway === 1) return "מחר";
  return `בעוד ${daysAway} ימים`;
}

module.exports = { upcomingBirthdays, daysAwayLabel, LOOKAHEAD_DAYS };
