const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const db = require("../db");
const { mergeTemplate, buildClassData, buildRecipientLine } = require("../letterEngine");
const { Document, Packer, Paragraph, TextRun, AlignmentType, PageBreak, ImageRun } = require("docx");

const JSZip = require("jszip");

const LETTERHEAD_PATH = path.join(__dirname, "..", "public", "images", "letterhead.jpg");
function buildLetterheadParagraph() {
  const imageBuffer = fs.readFileSync(LETTERHEAD_PATH);
  // התמונה המקורית 2480x537 פיקסלים - שומרים על אותו יחס גובה-רוחב, מוצמד לרוחב הדף
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    bidirectional: true,
    run: { rightToLeft: true },
    spacing: { after: 200 },
    children: [
      new ImageRun({
        data: imageBuffer,
        transformation: { width: 620, height: 134 },
        type: "jpg",
      }),
    ],
  });
}

// ספריית docx לא חושפת דרך ישירה להגדיר <w:bidi/> ברמת ה-section (רק ברמת פסקה בודדת),
// וזה עלול לגרום להתנהגות "הפוכה" של כפתורי היישור ב-Word האמיתי (גם כשכל פסקה
// כשלעצמה מוגדרת נכון). מתקנים את זה בדיעבד ע"י הזרקת התג ישירות ל-XML הפנימי
// של הקובץ (שהוא בעצם ZIP עם קבצי XML בפנים).
async function injectSectionBidi(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docXmlPath = "word/document.xml";
  let xml = await zip.file(docXmlPath).async("string");
  xml = xml.replace(/<w:sectPr>/g, "<w:sectPr><w:bidi/>");
  zip.file(docXmlPath, xml);
  return zip.generateAsync({ type: "nodebuffer" });
}

// סדר השכבות במוסד - כל שכבה "עולה" לשכבה הבאה ברשימה, וזה קובע אוטומטית איזו
// תבנית מכתב מתאימה (אין צורך לבחור תבנית ידנית - היא נגזרת מהכיתה הנוכחית)
const STAGE_ORDER = [
  "עדיין לא נכנסו", "מכינה א'", "מכינה ב'",
  "כיתה א'", "כיתה ב'", "כיתה ג'", "כיתה ד'",
  "כיתה ה'", "כיתה ו'", "כיתה ז'", "כיתה ח'",
];

function getNextStageTemplateName(currentClassName) {
  if (!currentClassName) return null;
  const stage = STAGE_ORDER.find((s) => currentClassName.startsWith(s));
  if (!stage) return null;
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return null; // כיתה ח' - אין שכבה הבאה
  return STAGE_ORDER[idx + 1];
}

function getTemplateIdForClass(currentClassName) {
  const nextStageName = getNextStageTemplateName(currentClassName);
  if (!nextStageName) return null;
  const row = db.prepare("SELECT id FROM letter_templates WHERE name = ?").get(nextStageName);
  return row ? row.id : null;
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : "";
}
function setSetting(key, value) {
  const existing = db.prepare("SELECT key FROM settings WHERE key = ?").get(key);
  if (existing) db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(value, key);
  else db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

// ============ עמוד ראשי - ניהול מכתבי שיבוץ ============
router.get("/", (req, res) => {
  // כל הכיתות הפעילות - כולל כיתה ח' (רק כדי לעדכן את המיקום שלה) וכולל עדיין לא נכנסו
  const classes = db.prepare(`
    SELECT c.*, cat.price, lt.name AS template_name
    FROM classes c
    LEFT JOIN categories cat ON c.category_id = cat.id
    LEFT JOIN letter_templates lt ON c.letter_template_id = lt.id
    WHERE c.status = 'פעיל'
    ORDER BY c.name, c.parallel
  `).all().map((c) => ({ ...c, auto_template_name: getNextStageTemplateName(c.name) }));
  // כל הכיתות (כולל ח') - לבחירת "כיתת יעד לשנה הבאה" (כי גם כיתה ח' יכולה להיות יעד של כיתה ז')
  const allClasses = db.prepare(`
    SELECT id, name, parallel FROM classes WHERE status = 'פעיל' ORDER BY name, parallel
  `).all().map((c) => ({ ...c, full_name: `${c.name}${c.parallel ? " " + c.parallel : ""}` }));
  const templates = db.prepare("SELECT id, name FROM letter_templates ORDER BY name").all();
  const settings = {
    letter_hebrew_date: getSetting("letter_hebrew_date"),
    letter_hebrew_year: getSetting("letter_hebrew_year"),
  };
  res.render("letters/index", { classes, allClasses, templates, settings, saved: req.query.saved === "1" });
});

router.post("/settings", (req, res) => {
  setSetting("letter_hebrew_date", req.body.letter_hebrew_date || "");
  setSetting("letter_hebrew_year", req.body.letter_hebrew_year || "");
  res.redirect("/letters?saved=1");
});

router.post("/class/:classId/fields", (req, res) => {
  const classRow = db.prepare("SELECT name FROM classes WHERE id = ?").get(req.params.classId);
  const autoTemplateId = classRow ? getTemplateIdForClass(classRow.name) : null;
  db.prepare("UPDATE classes SET room_description = ?, letter_template_id = ?, next_year_class_id = ? WHERE id = ?").run(
    req.body.room_description || null,
    autoTemplateId,
    req.body.next_year_class_id || null,
    req.params.classId
  );
  res.redirect("/letters");
});

// ============ ניהול תבניות ============
router.get("/templates", (req, res) => {
  const templates = db.prepare("SELECT * FROM letter_templates ORDER BY name").all();
  res.render("letters/templates-list", { templates });
});

router.get("/templates/new", (req, res) => {
  res.render("letters/template-form", { template: {}, mode: "new" });
});

router.post("/templates", (req, res) => {
  const { name, body } = req.body;
  db.prepare("INSERT INTO letter_templates (name, body, created_at, updated_at) VALUES (?,?,?,?)").run(
    name, body, new Date().toISOString(), new Date().toISOString()
  );
  res.redirect("/letters/templates");
});

router.get("/templates/:id/edit", (req, res) => {
  const template = db.prepare("SELECT * FROM letter_templates WHERE id = ?").get(req.params.id);
  if (!template) return res.status(404).render("404");
  res.render("letters/template-form", { template, mode: "edit" });
});

router.put("/templates/:id", (req, res) => {
  const { name, body } = req.body;
  db.prepare("UPDATE letter_templates SET name = ?, body = ?, updated_at = ? WHERE id = ?").run(
    name, body, new Date().toISOString(), req.params.id
  );
  res.redirect("/letters/templates");
});

router.delete("/templates/:id", (req, res) => {
  db.prepare("UPDATE classes SET letter_template_id = NULL WHERE letter_template_id = ?").run(req.params.id);
  db.prepare("DELETE FROM letter_templates WHERE id = ?").run(req.params.id);
  res.redirect("/letters/templates");
});

// ============ מכתב לכיתה - תצוגת הדפסה ============
router.get("/class/:classId/preview", (req, res) => {
  const classRow = db.prepare(`
    SELECT c.*, cat.price FROM classes c LEFT JOIN categories cat ON c.category_id = cat.id WHERE c.id = ?
  `).get(req.params.classId);
  if (!classRow) return res.status(404).render("404");
  if (!classRow.letter_template_id) {
    return res.render("letters/no-template", { classRow, message: "לכיתה זו לא משויכת תבנית מכתב." });
  }
  if (!classRow.next_year_class_id) {
    return res.render("letters/no-template", { classRow, message: "לכיתה זו לא משויכת כיתת יעד לשנה הבאה." });
  }
  const template = db.prepare("SELECT * FROM letter_templates WHERE id = ?").get(classRow.letter_template_id);
  const settings = { letter_hebrew_date: getSetting("letter_hebrew_date"), letter_hebrew_year: getSetting("letter_hebrew_year") };
  const data = buildClassData(db, classRow, settings);
  const paragraphs = mergeTemplate(template.body, data);
  res.render("letters/print-letter", {
    title: `מכתב שיבוץ - ${data.class_full_name}`,
    recipientLine: buildRecipientLine(data),
    paragraphs,
  });
});

router.get("/class/:classId/docx", async (req, res) => {
  const classRow = db.prepare(`
    SELECT c.*, cat.price FROM classes c LEFT JOIN categories cat ON c.category_id = cat.id WHERE c.id = ?
  `).get(req.params.classId);
  if (!classRow) return res.status(404).render("404");
  if (!classRow.letter_template_id) return res.status(400).send("לכיתה זו לא משויכת תבנית מכתב");
  if (!classRow.next_year_class_id) return res.status(400).send("לכיתה זו לא משויכת כיתת יעד לשנה הבאה");
  const template = db.prepare("SELECT * FROM letter_templates WHERE id = ?").get(classRow.letter_template_id);
  const settings = { letter_hebrew_date: getSetting("letter_hebrew_date"), letter_hebrew_year: getSetting("letter_hebrew_year") };
  const data = buildClassData(db, classRow, settings);
  const paragraphs = mergeTemplate(template.body, data);
  const recipientLine = buildRecipientLine(data);

  const buffer = await buildLetterDocx(recipientLine, paragraphs);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`מכתב-${data.class_full_name}.docx`)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.send(buffer);
});

// ============ מכתב למשפחה (ניסיוני) - כל הילדים באותו מכתב ============
router.get("/family/:familyId/preview", (req, res) => {
  const family = db.prepare("SELECT * FROM families WHERE id = ?").get(req.params.familyId);
  if (!family) return res.status(404).render("404");
  const children = db.prepare(`
    SELECT s.first_name, s.last_name, c.* , cat.price
    FROM students s
    JOIN classes c ON s.class_id = c.id
    LEFT JOIN categories cat ON c.category_id = cat.id
    WHERE s.family_id = ? AND s.status = 'פעיל'
    ORDER BY s.birth_date_civil ASC
  `).all(req.params.familyId);

  if (children.length === 0) {
    return res.render("letters/no-template", { classRow: null, message: "אין ילדים פעילים עם כיתה משויכת למשפחה זו" });
  }

  const settings = { letter_hebrew_date: getSetting("letter_hebrew_date"), letter_hebrew_year: getSetting("letter_hebrew_year") };

  // התוכן הכללי נלקח מהתבנית של הילד הראשון (הבכור) שיש לו תבנית משויכת
  const templateSource = children.find((c) => c.letter_template_id);
  if (!templateSource) return res.render("letters/no-template", { classRow: null, message: "לאף אחד מילדי המשפחה אין תבנית מכתב משויכת לכיתה" });
  const template = db.prepare("SELECT * FROM letter_templates WHERE id = ?").get(templateSource.letter_template_id);
  const generalData = buildClassData(db, templateSource, settings);
  const paragraphs = mergeTemplate(template.body, generalData);

  const childrenRows = children.map((c) => buildClassData(db, c, settings)).map((d, i) => ({
    ...d, child_name: `${children[i].first_name || ""} ${children[i].last_name || family.last_name || ""}`.trim(),
  }));

  res.render("letters/print-letter", {
    title: `מכתב שיבוץ - משפחת ${family.last_name}`,
    recipientLine: `לכבוד הורי משפחת ${family.last_name} שיחיו`,
    paragraphs,
    childrenRows,
  });
});

async function buildLetterDocx(recipientLine, paragraphs) {
  const docParagraphs = [
    buildLetterheadParagraph(),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
      indent: { left: 0, right: 0, firstLine: 0 },
      spacing: { after: 180 },
      run: { rightToLeft: true },
      children: [new TextRun({ text: recipientLine, bold: true, size: 24, rightToLeft: true })],
    }),
  ];
  paragraphs.forEach((runs, idx) => {
    const isClosingLine = idx >= paragraphs.length - 2;
    docParagraphs.push(new Paragraph({
      alignment: isClosingLine ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
      bidirectional: true,
      run: { rightToLeft: true },
      spacing: { after: 120 },
      children: runs.map((r) => new TextRun({ text: r.text, bold: r.bold, rightToLeft: true, size: 24 })),
    }));
  });

  const doc = new Document({
    sections: [{
      properties: {
        page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } },
      },
      children: docParagraphs,
    }],
  });
  const rawBuffer = await Packer.toBuffer(doc);
  return injectSectionBidi(rawBuffer);
}

router.get("/family/:familyId/docx", async (req, res) => {
  const family = db.prepare("SELECT * FROM families WHERE id = ?").get(req.params.familyId);
  if (!family) return res.status(404).render("404");
  const children = db.prepare(`
    SELECT s.first_name, s.last_name, c.*, cat.price
    FROM students s
    JOIN classes c ON s.class_id = c.id
    LEFT JOIN categories cat ON c.category_id = cat.id
    WHERE s.family_id = ? AND s.status = 'פעיל'
    ORDER BY s.birth_date_civil ASC
  `).all(req.params.familyId);
  const settings = { letter_hebrew_date: getSetting("letter_hebrew_date"), letter_hebrew_year: getSetting("letter_hebrew_year") };
  const templateSource = children.find((c) => c.letter_template_id);
  if (!templateSource) return res.status(400).send("לאף אחד מילדי המשפחה אין תבנית מכתב משויכת");
  const template = db.prepare("SELECT * FROM letter_templates WHERE id = ?").get(templateSource.letter_template_id);
  const generalData = buildClassData(db, templateSource, settings);
  const paragraphs = mergeTemplate(template.body, generalData);
  const recipientLine = `לכבוד הורי משפחת ${family.last_name} שיחיו`;

  const buffer = await buildLetterDocx(recipientLine, paragraphs);
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`מכתב-משפחת-${family.last_name}.docx`)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.send(buffer);
});

router.get("/generate-all/docx", async (req, res) => {
  const classes = db.prepare(`
    SELECT c.*, cat.price FROM classes c
    LEFT JOIN categories cat ON c.category_id = cat.id
    WHERE c.status = 'פעיל' AND c.name NOT LIKE 'כיתה ח%'
      AND c.letter_template_id IS NOT NULL AND c.next_year_class_id IS NOT NULL
    ORDER BY c.name, c.parallel
  `).all();

  if (classes.length === 0) {
    return res.status(400).send("אין כיתות עם תבנית וכיתת יעד משויכות. יש להשלים את השיוך בעמוד 'מכתבי שיבוץ' לפני ההפקה.");
  }

  const settings = { letter_hebrew_date: getSetting("letter_hebrew_date"), letter_hebrew_year: getSetting("letter_hebrew_year") };
  const templatesById = {};
  db.prepare("SELECT * FROM letter_templates").all().forEach((t) => { templatesById[t.id] = t; });

  const allDocParagraphs = [];
  classes.forEach((classRow, idx) => {
    const template = templatesById[classRow.letter_template_id];
    if (!template) return;
    const data = buildClassData(db, classRow, settings);
    const paragraphs = mergeTemplate(template.body, data);
    const recipientLine = buildRecipientLine(data);

    if (idx > 0) {
      allDocParagraphs.push(new Paragraph({ bidirectional: true, run: { rightToLeft: true }, children: [new PageBreak()] }));
    }
    allDocParagraphs.push(buildLetterheadParagraph());
    allDocParagraphs.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      bidirectional: true,
      indent: { left: 0, right: 0, firstLine: 0 },
      spacing: { after: 180 },
      run: { rightToLeft: true },
      children: [new TextRun({ text: recipientLine, bold: true, size: 24, rightToLeft: true })],
    }));
    paragraphs.forEach((runs, pIdx) => {
      const isClosingLine = pIdx >= paragraphs.length - 2;
      allDocParagraphs.push(new Paragraph({
        alignment: isClosingLine ? AlignmentType.CENTER : AlignmentType.JUSTIFIED,
        bidirectional: true,
        run: { rightToLeft: true },
        spacing: { after: 120 },
        children: runs.map((r) => new TextRun({ text: r.text, bold: r.bold, rightToLeft: true, size: 24 })),
      }));
    });
  });

  const doc = new Document({
    sections: [{
      properties: {
        page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } },
      },
      children: allDocParagraphs,
    }],
  });
  const rawBuffer = await Packer.toBuffer(doc);
  const buffer = await injectSectionBidi(rawBuffer);

  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(`מכתבי-שיבוץ-כל-הכיתות-${settings.letter_hebrew_year || ""}.docx`)}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.send(buffer);
});

module.exports = router;
