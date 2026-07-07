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

// בונה את אובייקט הנתונים למיזוג עבור כיתה בודדת
function buildClassData(db, classRow, globalSettings) {
  const teacherRow = db.prepare(`
    SELECT t.first_name, t.last_name FROM teacher_classes tc
    JOIN teachers t ON tc.teacher_id = t.id
    WHERE tc.class_id = ?
    ORDER BY CASE tc.role WHEN 'בוקר' THEN 1 WHEN 'אחה"צ' THEN 2 WHEN 'עוזר' THEN 3 ELSE 4 END
    LIMIT 1
  `).get(classRow.id);
  const teacherName = teacherRow ? `${teacherRow.first_name || ""} ${teacherRow.last_name || ""}`.trim() : "";

  return {
    class_name: classRow.name || "",
    parallel: classRow.parallel || "",
    class_full_name: `${classRow.name || ""}${classRow.parallel ? " " + classRow.parallel : ""}`,
    branch: classRow.branch || "",
    teacher_name: teacherName,
    room_description: classRow.room_description || "",
    tuition_price: classRow.price != null ? classRow.price : "",
    hebrew_date: globalSettings.letter_hebrew_date || "",
    hebrew_year: globalSettings.letter_hebrew_year || "",
  };
}

module.exports = { parseTemplateToParagraphs, mergeTemplate, buildClassData, fillPlaceholders };
