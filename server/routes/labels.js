const express = require("express");
const router = express.Router();
const db = require("../db");

// הגדרות פורמטים של מדבקות TANEX
const FORMATS = {
  "2133": { name: "TANEX 2133 — 33 בדף (3×11)", cols: 3, rows: 11, perPage: 33,
    labelW: "70mm", labelH: "25mm", pageMarginTop: "10.65mm", pageMarginSide: "0mm", gap: "0mm", fontSize: "17pt", nameSplitFontSize: "20pt" },
  "2072": { name: "TANEX 2072 — 72 בדף (6×12)", cols: 6, rows: 12, perPage: 72,
    labelW: "35mm", labelH: "22mm", pageMarginTop: "13.5mm", pageMarginSide: "0mm", gap: "0mm", fontSize: "13pt", nameSplitFontSize: "16pt", nameSplitPadV: "0.5mm" },
  "2120": { name: "TANEX 2120 — 120 בדף (6×20)", cols: 6, rows: 20, perPage: 120,
    labelW: "31mm", labelH: "14mm", pageMarginTop: "8mm", pageMarginSide: "12mm", gap: "0mm", fontSize: "10pt", nameSplitFontSize: "11pt", nameSplitPadV: "0.5mm" },
};

// שולף את פריטי המדבקות לפי סוג התוכן - פונקציה משותפת ל-/print ול-/export-docx,
// כדי לא לשכפל את לוגיקת השאילתות
function fetchLabelItems(content_type, class_id) {
  let items = [];

  if (content_type === "families") {
    let sql = `
      SELECT DISTINCT f.last_name, f.father_name, f.street, f.house_number, f.city, f.zip_code
      FROM families f
      JOIN students s ON s.family_id = f.id
      WHERE s.status = 'פעיל'
    `;
    const params = [];
    if (class_id) { sql += " AND s.class_id = ?"; params.push(class_id); }
    sql += " ORDER BY f.last_name";
    const rows = db.prepare(sql).all(...params);
    items = rows.map(r => ({
      line1: `משפחת ${r.last_name || ""}`,
      line2: [r.street, r.house_number].filter(Boolean).join(" "),
      line3: r.city || "",
    }));

  } else if (content_type === "students") {
    let sql = `
      SELECT s.first_name, s.last_name, c.name AS class_name, c.parallel, f.last_name AS family_last
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN families f ON s.family_id = f.id
      WHERE s.status = 'פעיל'
    `;
    const params = [];
    if (class_id) { sql += " AND s.class_id = ?"; params.push(class_id); }
    sql += " ORDER BY c.name, c.parallel, s.last_name, s.first_name";
    const rows = db.prepare(sql).all(...params);
    items = rows.map(r => ({
      line1: "",
      line2: `${r.first_name || ""} ${r.last_name || r.family_last || ""}`,
      line3: r.class_name ? r.class_name + (r.parallel ? " " + r.parallel : "") : "",
    }));

  } else if (content_type === "students_nickname") {
    let sql = `
      SELECT s.first_name, s.nickname, s.last_name, c.name AS class_name, c.parallel, f.last_name AS family_last
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN families f ON s.family_id = f.id
      WHERE s.status = 'פעיל'
    `;
    const params = [];
    if (class_id) { sql += " AND s.class_id = ?"; params.push(class_id); }
    sql += " ORDER BY c.name, c.parallel, s.last_name, s.first_name";
    const rows = db.prepare(sql).all(...params);
    items = rows.map(r => ({
      line1: r.nickname || r.first_name || "",
      line2: r.last_name || r.family_last || "",
      line3: "",
      isNameSplit: true,
    }));

  } else if (content_type === "teachers") {
    let sql = "SELECT first_name, last_name, street, house_number, city FROM teachers WHERE status='פעיל'";
    const params = [];
    if (class_id) {
      sql += " AND id IN (SELECT teacher_id FROM teacher_classes WHERE class_id=?)";
      params.push(class_id);
    }
    sql += " ORDER BY last_name, first_name";
    const rows = db.prepare(sql).all(...params);
    items = rows.map(r => ({
      line1: "לכבוד",
      line2: "הרב " + (r.first_name || "") + " " + (r.last_name || ""),
      line3: [r.street, r.house_number, r.city].filter(Boolean).join(" "),
      isTeacher: true,
    }));
  }

  return items;
}

// דף בחירת הגדרות
router.get("/", (req, res) => {
  const classes = db.prepare(`
    SELECT c.id, c.name, c.parallel, c.branch,
      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id AND s.status = 'פעיל') AS student_count
    FROM classes c ORDER BY c.name, c.parallel
  `).all();
  const branches = db.prepare("SELECT DISTINCT branch FROM classes WHERE branch IS NOT NULL ORDER BY branch").all().map(r=>r.branch);
  const totalActiveStudents = db.prepare("SELECT COUNT(*) c FROM students WHERE status = 'פעיל'").get().c;
  res.render("labels/setup", { formats: FORMATS, classes, branches, totalActiveStudents });
});

// הפקת מדבקות
router.get("/print", (req, res) => {
  const { format, content_type, class_id, copies, offset_top, offset_side } = req.query;
  const fmt = FORMATS[format] || FORMATS["2133"];
  const numCopies = parseInt(copies) || 1;
  const offsetTopMM = parseFloat(offset_top) || 0;
  const offsetSideMM = parseFloat(offset_side) || 0;

  const items = fetchLabelItems(content_type, class_id);

  // הכפלת כמות עותקים - עוברים על כל הרשימה פעם אחת לכל עותק (לא חוזרים על
  // אותו שם 4 פעמים ברצף ואז עוברים הלאה - זה לא נוח לעבודה. במקום זה,
  // כשיש כמה עותקים, פשוט עוברים שוב על הרשימה השלמה, לפי הסדר)
  const allItems = [];
  for (let i = 0; i < numCopies; i++) {
    for (const item of items) allItems.push(item);
  }

  // קבלת כיתה לתצוגה
  const cls = class_id ? db.prepare("SELECT name, parallel FROM classes WHERE id=?").get(class_id) : null;
  const clsLabel = cls ? cls.name + (cls.parallel ? " " + cls.parallel : "") : "כל הכיתות";

  res.render("labels/print", { fmt, format, items: allItems, content_type, clsLabel, offsetTopMM, offsetSideMM });
});

// ============ ייצוא לוורד - כדי שאפשר יהיה לכוונן ידנית בוורד ============
const { Document, Packer, Paragraph, TextRun, AlignmentType, PageBreak, Table, TableRow, TableCell, WidthType, TableLayoutType, VerticalAlign, HeightRule } = require("docx");

function mmToTwips(mm) {
  return Math.round(mm * 56.6929);
}

router.get("/export-docx", async (req, res) => {
  const { format, content_type, class_id, copies, offset_top, offset_side } = req.query;
  const fmt = FORMATS[format] || FORMATS["2133"];
  const numCopies = parseInt(copies) || 1;
  const offsetTopMM = parseFloat(offset_top) || 0;
  const offsetSideMM = parseFloat(offset_side) || 0;

  const items = fetchLabelItems(content_type, class_id);
  const allItems = [];
  for (let i = 0; i < numCopies; i++) {
    for (const item of items) allItems.push(item);
  }

  const labelWmm = parseFloat(fmt.labelW);
  const labelHmm = parseFloat(fmt.labelH);
  const marginTopMM = parseFloat(fmt.pageMarginTop) + offsetTopMM;
  const marginSideMM = parseFloat(fmt.pageMarginSide) + offsetSideMM;
  const baseFontHalfPt = parseFloat(fmt.fontSize) * 2;
  const nameSplitFontHalfPt = parseFloat(fmt.nameSplitFontSize || fmt.fontSize) * 2;

  // מחלקים לדפים - עמוד אחד = perPage מדבקות, בדיוק כמו בגרסת ההדפסה
  const pages = [];
  let current = [];
  allItems.forEach((item, i) => {
    current.push(item);
    if (current.length === fmt.perPage || i === allItems.length - 1) {
      pages.push([...current]);
      current = [];
    }
  });
  if (pages.length === 0) pages.push([]);

  function buildCellParagraphs(item) {
    if (!item) return [new Paragraph({ text: "" })];
    const paragraphs = [];
    if (item.isNameSplit) {
      // שם חיבה + משפחה - שתי שורות קבועות, שתיהן מודגשות באותו גודל
      if (item.line1) paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: item.line1, bold: true, size: nameSplitFontHalfPt })],
      }));
      if (item.line2) paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: item.line2, bold: true, size: nameSplitFontHalfPt })],
      }));
    } else {
      // תבנית 3 שורות רגילה: שורה 1 קטנה, שורה 2 מודגשת (עיקרית), שורה 3 קטנה
      if (item.line1) paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: item.line1, size: Math.round(baseFontHalfPt * 0.85) })],
      }));
      if (item.line2) paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: item.line2, bold: true, size: Math.round(baseFontHalfPt * 1.05) })],
      }));
      if (item.line3) paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: item.line3, size: Math.round(baseFontHalfPt * 0.88) })],
      }));
    }
    if (paragraphs.length === 0) paragraphs.push(new Paragraph({ text: "" }));
    return paragraphs;
  }

  const docChildren = [];
  pages.forEach((page, pageIdx) => {
    const tableRows = [];
    for (let r = 0; r < fmt.rows; r++) {
      const cells = [];
      for (let c = 0; c < fmt.cols; c++) {
        const idx = r * fmt.cols + c;
        const item = idx < page.length ? page[idx] : null;
        cells.push(new TableCell({
          width: { size: mmToTwips(labelWmm), type: WidthType.DXA },
          verticalAlign: VerticalAlign.CENTER,
          children: buildCellParagraphs(item),
        }));
      }
      tableRows.push(new TableRow({
        children: cells,
        height: { value: mmToTwips(labelHmm), rule: HeightRule.EXACT },
      }));
    }
    const table = new Table({
      rows: tableRows,
      layout: TableLayoutType.FIXED,
      width: { size: mmToTwips(labelWmm * fmt.cols), type: WidthType.DXA },
      // חובה להגדיר את זה במפורש - זו ה"אמת" שוורד בפועל מסתמך עליה
      // לרוחב כל עמודה (ה-tblGrid ב-XML), לא רק רוחב כל תא בנפרד. בלעדיו
      // וורד היה מציג עמודות ברוחב שרירותי (כמעט אפס), לא לפי המידה
      // המדויקת של מדבקת TANEX
      columnWidths: Array(fmt.cols).fill(mmToTwips(labelWmm)),
      indent: { size: 0, type: WidthType.DXA },
      // שוליים פנימיים מפורשים לכל תא - בלי זה וורד מוסיף שוליים משלו
      // (בערך 2 מ"מ מכל צד) שלא היינו מודעים אליהם, מה שהזיז את התוכן
      // מהמידות המדויקות של מדבקת TANEX
      margins: {
        top: mmToTwips(parseFloat(fmt.nameSplitPadV) || 0.8),
        bottom: mmToTwips(parseFloat(fmt.nameSplitPadV) || 0.8),
        left: mmToTwips(1),
        right: mmToTwips(1),
        marginUnitType: WidthType.DXA,
      },
    });
    docChildren.push(table);
    if (pageIdx < pages.length - 1) {
      docChildren.push(new Paragraph({ children: [new PageBreak()] }));
    }
  });

  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: mmToTwips(marginTopMM),
            right: mmToTwips(marginSideMM),
            left: mmToTwips(marginSideMM),
            bottom: mmToTwips(marginTopMM),
          },
        },
      },
      children: docChildren,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="labels.docx"; filename*=UTF-8''${encodeURIComponent("מדבקות.docx")}`);
  res.send(buffer);
});

module.exports = router;
