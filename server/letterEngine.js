// -*- coding: utf-8 -*-
// מנוע מיזוג מכתבי שיבוץ - ממלא placeholders בתבנית עם נתונים אמיתיים מהמערכת

// ממיר תבנית טקסט (עם שורות ריקות כמפרידי פסקאות, **טקסט** למודגש, ו-{{שדה}} כ-placeholder)
// למערך פסקאות: [{ bold: boolean, text: string }] עבור כל פסקה, כאשר טקסט בתוך פסקה יכול לכלול
// גם מקטעים מודגשים בתוך פסקה רגילה (נשמר כמערך runs).
function parseTemplateToParagraphs(body) {
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paragraphs.map((p) => {
    const runs = [];
    const re = /\*\*(.+?)\*\*/g;
    let lastIndex = 0, m;
    while ((m = re.exec(p)) !== null) {
      if (m.index > lastIndex) runs.push({ text: p.slice(lastIndex, m.index), bold: false });
      runs.push({ text: m[1], bold: true });
      lastIndex = re.lastIndex;
    }
    if (lastIndex < p.length) runs.push({ text: p.slice(lastIndex), bold: false });
    return runs;
  });
}

function fillPlaceholders(text, data) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return data[key] !== undefined && data[key] !== null && data[key] !== "" ? String(data[key]) : `[${key} חסר]`;
  });
}

// ממלא את כל ה-placeholders בכל ה-runs של כל הפסקאות
function mergeTemplate(body, data) {
  const paragraphs = parseTemplateToParagraphs(body);
  return paragraphs.map((runs) => runs.map((r) => ({ ...r, text: fillPlaceholders(r.text, data) })));
}

function getTeacherName(db, classId) {
  const teacherRow = db.prepare(`
    SELECT t.first_name, t.last_name FROM teacher_classes tc
    JOIN teachers t ON tc.teacher_id = t.id
    WHERE tc.class_id = ?
    ORDER BY CASE tc.role WHEN 'בוקר' THEN 1 WHEN 'אחה"צ' THEN 2 WHEN 'עוזר' THEN 3 ELSE 4 END
    LIMIT 1
  `).get(classId);
  return teacherRow ? `${teacherRow.first_name || ""} ${teacherRow.last_name || ""}`.trim() : "";
}

function getCohortName(db, classId) {
  const row = db.prepare(`
    SELECT co.name, COUNT(*) AS cnt
    FROM students s JOIN cohorts co ON s.cohort_id = co.id
    WHERE s.class_id = ? AND s.status NOT IN ('ארכיון', 'לא התקבל')
    GROUP BY co.id
    ORDER BY cnt DESC
    LIMIT 1
  `).get(classId);
  return row ? row.name : "";
}

// בונה את אובייקט הנתונים למיזוג: currentClassRow היא הכיתה שבה התלמיד נמצא היום,
// ומתוכה שולפים את next_year_class_id - הכיתה שאליה הוא עולה בשנה הבאה (טרם עם כל
// הפרטים - מלמד, סניף, חדר, שכ"ל - נלקחים מכיתת היעד, כי זה מה שיהיה נכון בפועל).
function buildClassData(db, currentClassRow, globalSettings) {
  const currentFullName = `${currentClassRow.name || ""}${currentClassRow.parallel ? " " + currentClassRow.parallel : ""}`;

  let targetRow = null;
  if (currentClassRow.next_year_class_id) {
    targetRow = db.prepare(`
      SELECT c.*, cat.price FROM classes c
      LEFT JOIN categories cat ON c.category_id = cat.id
      WHERE c.id = ?
    `).get(currentClassRow.next_year_class_id);
  }
  // נפילה רכה לאחור: אם אין כיתת יעד מוגדרת, נציג את פרטי הכיתה הנוכחית עצמה
  const source = targetRow || currentClassRow;
  const targetFullName = `${source.name || ""}${source.parallel ? " " + source.parallel : ""}`;

  return {
    current_class_name: currentClassRow.name || "",
    current_parallel: currentClassRow.parallel || "",
    current_class_full_name: currentFullName,
    class_name: source.name || "",
    parallel: source.parallel || "",
    class_full_name: targetFullName,
    branch: source.branch || "",
    teacher_name: getTeacherName(db, source.id),
    room_description: source.room_description || "",
    tuition_price: source.price != null ? source.price : "",
    cohort_name: getCohortName(db, source.id),
    hebrew_date: globalSettings.letter_hebrew_date || "",
    hebrew_year: globalSettings.letter_hebrew_year || "",
  };
}

function buildRecipientLine(data) {
  if (data.current_class_name && data.current_class_name.startsWith("עדיין לא נכנסו")) {
    return `לכבוד הורי תלמידי החמד העולים ל${data.class_name} (${data.branch}) שיח'`;
  }
  return `לכבוד הורי תלמידי ${data.current_class_full_name} שיחיו`;
}

module.exports = { parseTemplateToParagraphs, mergeTemplate, buildClassData, fillPlaceholders, buildRecipientLine };
