// parasha.js — חישוב פרשת השבוע לתאריך נתון, ולהפך.
//
// נדרש ללוח שנת הלימודים: חלק מהאירועים קבועים לפי הפרשה ולא לפי
// תאריך — "שיחה בשבת פרשת שמות" תיפול בתאריך אחר בכל שנה.
//
// החישוב נעשה מקומית ולא מול שירות חיצוני, כדי שלא ייכשל כשאין רשת.
// מבוסס על מבנה השנה העברית: מספר הימים בשנה ויום השבוע של ראש השנה
// קובעים במדויק אילו פרשות מתחברות.

const hd = require("./hebrewDate");

const PARASHOT = [
  "בראשית", "נח", "לך לך", "וירא", "חיי שרה", "תולדות", "ויצא", "וישלח",
  "וישב", "מקץ", "ויגש", "ויחי",
  "שמות", "וארא", "בא", "בשלח", "יתרו", "משפטים", "תרומה", "תצוה",
  "כי תשא", "ויקהל", "פקודי",
  "ויקרא", "צו", "שמיני", "תזריע", "מצורע", "אחרי מות", "קדושים", "אמור",
  "בהר", "בחקתי",
  "במדבר", "נשא", "בהעלתך", "שלח לך", "קרח", "חקת", "בלק", "פינחס",
  "מטות", "מסעי",
  "דברים", "ואתחנן", "עקב", "ראה", "שופטים", "כי תצא", "כי תבוא",
  "נצבים", "וילך", "האזינו",
];

// "וזאת הברכה" נקראת בשמחת תורה ולא בשבת, ולכן אינה חלק ממחזור
// השבתות. היא מטופלת בנפרד.
const VEZOT = "וזאת הברכה";

// זוגות שמתחברים בשנה שאין בה מספיק שבתות
const PAIRS = [
  ["ויקהל", "פקודי"], ["תזריע", "מצורע"], ["אחרי מות", "קדושים"],
  ["בהר", "בחקתי"], ["חקת", "בלק"], ["מטות", "מסעי"], ["נצבים", "וילך"],
];

// יום בשבוע של תאריך מוחלט. 0 = ראשון, 6 = שבת.
function dayOfWeek(abs) {
  return ((abs % 7) + 7) % 7;
}

// השבת הראשונה שאחרי תאריך נתון (או התאריך עצמו אם הוא שבת)
function nextShabbat(abs) {
  const d = dayOfWeek(abs);
  return abs + ((6 - d + 7) % 7);
}

/**
 * בונה את לוח הפרשות לשנה עברית: מיפוי מתאריך שבת לשם הפרשה.
 * הלוגיקה: מתחילים מהשבת שאחרי שמחת תורה עם "בראשית", ומתקדמים
 * שבת אחר שבת. שבתות שחלות בחג מדלגות, וכשנותרו פחות שבתות
 * מפרשות — מחברים זוגות.
 */
function buildYear(yearNum) {
  const inIsrael = true;   // שמחת תורה בכ"ב תשרי
  const simchatTorah = hd.hebrewPartsToAbsolute(yearNum, 7, inIsrael ? 22 : 23);
  const firstShabbat = nextShabbat(simchatTorah + 1);

  // סוף המחזור: שמחת תורה של השנה הבאה
  const endAbs = hd.hebrewPartsToAbsolute(yearNum + 1, 7, inIsrael ? 22 : 23);

  // כל השבתות במחזור
  const shabbatot = [];
  for (let a = firstShabbat; a < endAbs; a += 7) shabbatot.push(a);

  // שבתות שנבלעות בחג ואין בהן קריאת פרשה רגילה
  const skip = new Set();
  const addIfShabbat = (m, d) => {
    try {
      const a = hd.hebrewPartsToAbsolute(yearNum, m, d);
      if (dayOfWeek(a) === 6) skip.add(a);
    } catch (e) {}
    try {
      const a2 = hd.hebrewPartsToAbsolute(yearNum + 1, m, d);
      if (dayOfWeek(a2) === 6) skip.add(a2);
    } catch (e) {}
  };
  // פסח: ט"ו-כ"א ניסן (חודש 1). שבועות: ו' סיון (3).
  for (let d = 15; d <= 21; d++) addIfShabbat(1, d);
  addIfShabbat(3, 6);
  // ראש השנה, יום כיפור, סוכות
  for (const [m, d] of [[7,1],[7,2],[7,10],[7,15],[7,16],[7,17],[7,18],[7,19],[7,20],[7,21],[7,22]]) addIfShabbat(m, d);

  const usable = shabbatot.filter((a) => !skip.has(a));

  // כמה חיבורים צריך
  let list = PARASHOT.slice();
  let needed = list.length - usable.length;
  if (needed > 0) {
    // מחברים מהסוף להתחלה של רשימת הזוגות, כפי שנהוג
    for (const [a, b] of PAIRS) {
      if (needed <= 0) break;
      const i = list.indexOf(a);
      if (i >= 0 && list[i + 1] === b) {
        list.splice(i, 2, a + "-" + b);
        needed--;
      }
    }
  }

  const map = new Map();
  for (let i = 0; i < usable.length && i < list.length; i++) {
    map.set(usable[i], list[i]);
  }
  return map;
}

const cache = new Map();
function yearMap(yearNum) {
  if (!cache.has(yearNum)) cache.set(yearNum, buildYear(yearNum));
  return cache.get(yearNum);
}

/** שם הפרשה של השבת שבשבוע של תאריך מוחלט */
function parashaForDate(abs) {
  const shabbat = nextShabbat(abs);
  const parts = hd.serialToHebrewParts(hd.absoluteToAccessSerial(shabbat));
  if (!parts) return null;
  // הפרשה עשויה להשתייך למחזור של השנה הקודמת
  for (const y of [parts.year, parts.year - 1]) {
    const m = yearMap(y);
    if (m.has(shabbat)) return m.get(shabbat);
  }
  return null;
}

/** התאריך המוחלט של שבת פרשה מסוימת בשנה עברית נתונה */
function dateForParasha(yearNum, name) {
  // וזאת הברכה - שמחת תורה, לא שבת
  if (name === VEZOT) {
    try { return hd.hebrewPartsToAbsolute(yearNum + 1, 7, 22); } catch (e) { return null; }
  }
  const m = yearMap(yearNum);
  for (const [abs, p] of m) {
    if (p === name || p.split("-").includes(name)) return abs;
  }
  return null;
}

/** רשימת הפרשות לבחירה, בסדר השנה */
function parashaOptions() {
  return PARASHOT.concat([VEZOT]);
}

module.exports = { parashaForDate, dateForParasha, parashaOptions, PARASHOT, VEZOT };
