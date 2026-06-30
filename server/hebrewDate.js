// מודול המרת תאריכים: Access date serial <-> Gregorian <-> Hebrew
// Access serial = מספר ימים מאז 1899-12-30

const HEBREW_MONTHS = [
  "תשרי", "חשון", "כסלו", "טבת", "שבט", "אדר", "אדר א'", "אדר ב'",
  "ניסן", "אייר", "סיון", "תמוז", "אב", "אלול",
];

const GERESH = "'";
const GERSHAYIM = '"';

function hebrewNumeral(num) {
  // ממיר מספר לגימטריה (לשנים/ימים)
  const ones = ["", "א", "ב", "ג", "ד", "ה", "ו", "ז", "ח", "ט"];
  const tens = ["", "י", "כ", "ל", "מ", "נ", "ס", "ע", "פ", "צ"];
  const hundreds = ["", "ק", "ר", "ש", "ת"];

  let n = num;
  let result = "";
  let h = Math.floor(n / 100);
  n %= 100;
  while (h > 4) {
    result += "ת";
    h -= 4;
  }
  result += hundreds[h];

  if (n === 15) {
    result += "טו";
  } else if (n === 16) {
    result += "טז";
  } else {
    result += tens[Math.floor(n / 10)];
    result += ones[n % 10];
  }

  if (result.length === 1) {
    return result + GERESH;
  }
  return result.slice(0, -1) + GERSHAYIM + result.slice(-1);
}

// --- אלגוריתם לוח עברי (Civil <-> Hebrew), שיטה סטנדרטית מבוססת מולד ---

function hebrewLeapYear(year) {
  return ((7 * year + 1) % 19) < 7;
}

function monthsInHebYear(year) {
  return hebrewLeapYear(year) ? 13 : 12;
}

function daysInHebYear(year) {
  return hebrewToAbsolute(year + 1, 7, 1) - hebrewToAbsolute(year, 7, 1);
}

function longCheshvan(year) {
  return daysInHebYear(year) % 10 === 5;
}

function shortKislev(year) {
  return daysInHebYear(year) % 10 === 3;
}

function daysInHebMonth(month, year) {
  if ([2, 4, 6, 10, 13].includes(month)) return 29;
  if (month === 12 && !hebrewLeapYear(year)) return 29;
  if (month === 8 && !longCheshvan(year)) return 29;
  if (month === 9 && shortKislev(year)) return 29;
  return 30;
}

// 1=תשרי ... 6=אדר(/אדר א' בשנה מעוברת) 7=אדר ב' (רק במעוברת) 8=ניסן ... 13=אלול
function hebrewElapsedDays(year) {
  const monthsElapsed =
    Math.floor((235 * year - 234) / 19);
  const partsElapsed = 204 + 793 * (monthsElapsed % 1080);
  const hoursElapsed =
    5 + 12 * monthsElapsed + 793 * Math.floor(monthsElapsed / 1080) + Math.floor(partsElapsed / 1080);
  let day = 1 + 29 * monthsElapsed + Math.floor(hoursElapsed / 24);
  const parts = (hoursElapsed % 24) * 1080 + (partsElapsed % 1080);

  let alternativeDay;
  if (parts >= 19440 || (day % 7 === 2 && parts >= 9924 && !hebrewLeapYear(year)) ||
      (day % 7 === 1 && parts >= 16789 && hebrewLeapYear(year - 1))) {
    alternativeDay = day + 1;
  } else {
    alternativeDay = day;
  }

  if ([0, 3, 5].includes(alternativeDay % 7)) {
    return alternativeDay + 1;
  }
  return alternativeDay;
}

const HEB_EPOCH = -1373428; // absolute date offset constant for hebrew calendar (calibrated)

function hebrewToAbsolute(year, month, day) {
  let temp = day;
  if (month < 7) {
    for (let m = 7; m <= monthsInHebYear(year); m++) temp += daysInHebMonth(m, year);
    for (let m = 1; m < month; m++) temp += daysInHebMonth(m, year);
  } else {
    for (let m = 7; m < month; m++) temp += daysInHebMonth(m, year);
  }
  return HEB_EPOCH + hebrewElapsedDays(year) + temp - 1;
}

function absoluteToHebrew(absolute) {
  let year = Math.floor((absolute - HEB_EPOCH) / 366);
  while (hebrewToAbsolute(year + 1, 7, 1) <= absolute) year++;
  const numMonths = monthsInHebYear(year);
  let month = 7;
  let count = 0;
  while (
    count < numMonths &&
    hebrewToAbsolute(year, month, daysInHebMonth(month, year)) < absolute
  ) {
    month = month === numMonths ? 1 : month + 1;
    count++;
  }
  const day = absolute - hebrewToAbsolute(year, month, 1) + 1;
  return { year, month, day };
}

// --- Gregorian <-> Absolute ---
function gregorianLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function gregorianToAbsolute(year, month, day) {
  let n = day;
  for (let m = 1; m < month; m++) {
    n += [31, gregorianLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }
  const y = year - 1;
  return (
    n +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400)
  );
}

function absoluteToGregorian(absolute) {
  let year = Math.floor(absolute / 365.2425) + 1;
  while (gregorianToAbsolute(year + 1, 1, 1) <= absolute) year++;
  while (gregorianToAbsolute(year, 1, 1) > absolute) year--;
  let month = 1;
  while (
    gregorianToAbsolute(
      year,
      month,
      [31, gregorianLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    ) < absolute
  ) {
    month++;
  }
  const day = absolute - gregorianToAbsolute(year, month, 1) + 1;
  return { year, month, day };
}

// --- Access serial <-> Absolute ---
// Access epoch 1899-12-30 == absolute date for that Gregorian date
const ACCESS_EPOCH_ABS = gregorianToAbsolute(1899, 12, 30);

function accessSerialToAbsolute(serial) {
  return ACCESS_EPOCH_ABS + serial;
}

function absoluteToAccessSerial(absolute) {
  return absolute - ACCESS_EPOCH_ABS;
}

// --- ממשק ציבורי ---

function serialToGregorianDate(serial) {
  if (serial === null || serial === undefined || serial === "") return null;
  const abs = accessSerialToAbsolute(Number(serial));
  return absoluteToGregorian(abs); // {year, month, day}
}

function serialToGregorianString(serial) {
  const g = serialToGregorianDate(serial);
  if (!g) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(g.day)}/${pad(g.month)}/${g.year}`;
}

function serialToHebrewString(serial) {
  if (serial === null || serial === undefined || serial === "") return "";
  const abs = accessSerialToAbsolute(Number(serial));
  const h = absoluteToHebrew(abs);
  const names = {
    1: "ניסן", 2: "אייר", 3: "סיון", 4: "תמוז", 5: "אב", 6: "אלול",
    7: "תשרי", 8: "חשון", 9: "כסלו", 10: "טבת", 11: "שבט",
    12: hebrewLeapYear(h.year) ? "אדר א'" : "אדר",
    13: "אדר ב'",
  };
  const monthName = names[h.month];
  return `${hebrewNumeral(h.day)} ${monthName} ${hebrewNumeral(h.year % 1000)}`;
}

function todayAccessSerial() {
  const now = new Date();
  const abs = gregorianToAbsolute(now.getFullYear(), now.getMonth() + 1, now.getDate());
  return absoluteToAccessSerial(abs);
}

function gregorianStringToSerial(str) {
  // מצפה לפורמט DD/MM/YYYY או YYYY-MM-DD
  if (!str) return null;
  let y, m, d;
  if (str.includes("-")) {
    [y, m, d] = str.split("-").map(Number);
  } else if (str.includes("/")) {
    [d, m, y] = str.split("/").map(Number);
  } else {
    return null;
  }
  if (!y || !m || !d) return null;
  const abs = gregorianToAbsolute(y, m, d);
  return absoluteToAccessSerial(abs);
}

function serialToInputDate(serial) {
  // מחזיר YYYY-MM-DD לשימוש ב-<input type=date>
  const g = serialToGregorianDate(serial);
  if (!g) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${g.year}-${pad(g.month)}-${pad(g.day)}`;
}

function currentHebrewYearNumber() {
  const abs = accessSerialToAbsolute(todayAccessSerial());
  const h = absoluteToHebrew(abs);
  return h.year;
}

function formatHebrewYear(num) {
  return hebrewNumeral(num % 1000);
}

module.exports = {
  serialToGregorianString,
  serialToHebrewString,
  serialToInputDate,
  gregorianStringToSerial,
  todayAccessSerial,
  currentHebrewYearNumber,
  formatHebrewYear,
};
