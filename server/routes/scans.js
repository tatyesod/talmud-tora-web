const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { getCurrentYear, GRADE_ORDER } = require("../yearManager");

// הקבצים נשמרים על הדיסק הקבוע, לא בתיקיית הקוד - אחרת כל פריסה מוחקת אותם
const SCAN_DIR = path.join(
  process.env.RENDER_PERSISTENT_DIR || path.join(__dirname, ".."),
  "uploads", "scans"
);
if (!fs.existsSync(SCAN_DIR)) fs.mkdirSync(SCAN_DIR, { recursive: true });

// טופס אחד של תלמיד הוא שני עמודים סרוקים - כמה מאות קילובייט לכל היותר.
// 8MB היא תקרת ביטחון רחבה.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");

// ============ מסך ההעלאה ============
router.get("/", (req, res) => {
  const year = req.query.year || getCurrentYear();
  const classes = db.prepare(`
    SELECT c.id, c.name, c.parallel, c.branch, COUNT(s.id) AS student_count
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id AND s.status = 'פעיל'
    WHERE c.status = 'פעיל'
    GROUP BY c.id
  `).all().sort((a, b) => {
    const ga = GRADE_ORDER.indexOf(a.name), gb = GRADE_ORDER.indexOf(b.name);
    if (ga !== gb) return (ga === -1 ? 99 : ga) - (gb === -1 ? 99 : gb);
    return String(a.parallel || "").localeCompare(String(b.parallel || ""), "he");
  });

  // כמה טפסים כבר נקלטו בכל כיתה
  const counts = db.prepare(`
    SELECT s.class_id, COUNT(*) AS n FROM scanned_forms f
    JOIN students s ON s.id = f.student_id
    WHERE f.year = ? AND f.form_type = 'health'
    GROUP BY s.class_id
  `).all(year);
  const byClass = Object.fromEntries(counts.map((c) => [c.class_id, c.n]));

  res.render("scans/index", {
    year,
    classes: classes.map((c) => ({ ...c, scanned: byClass[c.id] || 0 })),
    totalStudents: classes.reduce((s, c) => s + c.student_count, 0),
    totalScanned: counts.reduce((s, c) => s + c.n, 0),
  });
});

// רשימת התלמידים של כיתה - לשיוך ידני כשאין קוד זיהוי
router.get("/class/:id", (req, res) => {
  const year = req.query.year || getCurrentYear();
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(req.params.id);
  if (!cls) return res.redirect("/scans");

  const students = db.prepare(`
    SELECT s.id, s.first_name, s.nickname,
           COALESCE(NULLIF(s.last_name,''), f.last_name) AS last_name,
           sf.id AS form_id, sf.file_name, sf.size_bytes, sf.uploaded_at, sf.page_count
    FROM students s
    LEFT JOIN families f ON s.family_id = f.id
    LEFT JOIN scanned_forms sf
      ON sf.student_id = s.id AND sf.year = ? AND sf.form_type = 'health'
    WHERE s.class_id = ? AND s.status = 'פעיל'
    ORDER BY COALESCE(NULLIF(s.last_name,''), f.last_name), s.first_name
  `).all(year, req.params.id).map((s) => ({
    ...s,
    uploaded_str: s.uploaded_at ? hd.formatGregorian(s.uploaded_at) : "",
    size_str: s.size_bytes ? fmtSize(s.size_bytes) : "",
  }));

  res.render("scans/class", {
    cls, year, students,
    returned: students.filter((s) => s.form_id).length,
  });
});

// ============ שיוך ידני (חד-פעמי לשנה הנוכחית) ============
// הטפסים של השנה הזו הודפסו לפני שהוספנו את קוד הזיהוי, ולכן אין מה לקרוא
// מהם אוטומטית. המסך הזה מציג את העמוד הראשון של כל טופס - שעליו מודפס שם
// התלמיד - ולידו בחירת תלמיד. השיוך מוצע מראש לפי סדר ההדפסה, שהוא לפי
// שם משפחה, ולכן ברוב המקרים נותר רק לאשר.
// מיועד להימחק אחרי הסבב הזה, כשכל הטפסים יישאו קוד.
// שיוך ידני מעורב - סריקה שמכילה כמה כיתות יחד ובכל סדר.
// בלי קוד אין דרך לדעת לאיזו כיתה שייך טופס, אבל גם אין צורך: ברגע
// שנבחר התלמיד, הכיתה נגזרת ממנו. לכן הרשימה כאן היא של כל התלמידים
// הפעילים, עם חיפוש לפי שם - והמיון לכיתות קורה מאליו.
router.get("/manual", (req, res) => {
  const year = req.query.year || getCurrentYear();
  const students = db.prepare(`
    SELECT s.id, s.first_name, s.nickname, s.last_name,
           COALESCE(NULLIF(s.last_name,''), f.last_name) AS family_name,
           c.name AS class_name, c.parallel, c.branch, c.grade_order,
           (SELECT COUNT(*) FROM scanned_forms sf
            WHERE sf.student_id = s.id AND sf.year = ? AND sf.form_type = 'health') AS has_form
    FROM students s
    LEFT JOIN families f ON s.family_id = f.id
    LEFT JOIN classes c ON s.class_id = c.id
    WHERE s.status = 'פעיל'
    ORDER BY c.grade_order, c.name, c.parallel, s.last_name, s.first_name
  `).all(year);

  const emptyMap = emptyFieldsFor(students.map((s) => s.id));
  res.render("scans/manual-all", {
    year, students, emptyMap,
    pending: students.filter((s) => !s.has_form).length,
  });
});

router.get("/class/:id/manual", (req, res) => {
  const year = req.query.year || getCurrentYear();
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(req.params.id);
  if (!cls) return res.redirect("/scans");

  // אותו סדר בדיוק שבו הטפסים הודפסו
  const students = db.prepare(`
    SELECT s.id, s.first_name, s.nickname, s.last_name,
           COALESCE(NULLIF(s.last_name,''), f.last_name) AS family_name,
           (SELECT COUNT(*) FROM scanned_forms sf
            WHERE sf.student_id = s.id AND sf.year = ? AND sf.form_type = 'health') AS has_form
    FROM students s
    LEFT JOIN families f ON s.family_id = f.id
    WHERE s.class_id = ? AND s.status = 'פעיל'
    ORDER BY s.last_name, s.first_name
  `).all(year, req.params.id);

  res.render("scans/manual", { cls, year, students });
});

// אילו שדות היו ריקים במסד, ולכן הודפסו כקו ריק בטופס. זו הרשימה שמולה
// נבדק הדיו: דיו בשדה שהודפס ריק פירושו שההורים כתבו בו.
const EMPTY_CHECK = [
  ["nickname", "students"], ["health_fund", "students"], ["immigration_year", "students"],
  ["address", "families"], ["home_phone", "families"],
  ["father_workplace", "families"], ["father_mobile", "families"],
  ["father_synagogue", "families"], ["mother_workplace", "families"],
  ["mother_mobile", "families"], ["mother_work_phone", "families"],
  ["father_email", "families"], ["mother_email", "families"],
  // שדות רפואיים וסימון - נבדקים גם הם. אם ריקים במערכת וההורים מילאו,
  // הם יופיעו במסך העדכונים.
  ["allergies", "students"], ["medications", "students"], ["walks_alone", "students"],
];

function emptyFieldsFor(studentIds) {
  if (!studentIds.length) return {};
  const marks = studentIds.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT s.id AS student_id, s.nickname, s.health_fund, s.immigration_year,
           s.allergies, s.medications, s.walks_alone,
           f.home_phone, f.father_workplace, f.father_mobile, f.father_synagogue,
           f.mother_workplace, f.mother_mobile, f.mother_work_phone,
           f.father_email, f.mother_email, f.street
    FROM students s LEFT JOIN families f ON s.family_id = f.id
    WHERE s.id IN (${marks})
  `).all(...studentIds);
  const out = {};
  for (const r of rows) {
    const empty = [];
    for (const [key] of EMPTY_CHECK) {
      const val = key === "address" ? r.street : r[key];
      if (val === null || val === undefined || String(val).trim() === "") empty.push(key);
    }
    out[r.student_id] = empty;
  }
  return out;
}

// ============ קליטת טופס של תלמיד אחד ============
router.post("/upload", upload.single("file"), (req, res) => {
  const studentId = parseInt(req.body.student_id, 10);
  const year = req.body.year || getCurrentYear();
  const replace = req.body.replace === "1";

  if (!req.file || isNaN(studentId)) {
    return res.status(400).json({ ok: false, error: "חסר קובץ או תלמיד" });
  }
  const student = db.prepare("SELECT id FROM students WHERE id = ?").get(studentId);
  if (!student) return res.status(400).json({ ok: false, error: "תלמיד לא נמצא" });

  const hash = crypto.createHash("sha256").update(req.file.buffer).digest("hex");

  // כפילות סוג א': אותו קובץ בדיוק כבר קיים אצל התלמיד
  const sameFile = db.prepare(
    "SELECT id FROM scanned_forms WHERE student_id = ? AND file_hash = ?"
  ).get(studentId, hash);
  if (sameFile) return res.json({ ok: true, status: "duplicate" });

  // כפילות סוג ב': כבר יש טופס לאותו תלמיד באותה שנה
  const existing = db.prepare(
    "SELECT id, file_name FROM scanned_forms WHERE student_id = ? AND form_type = 'health' AND year = ?"
  ).get(studentId, year);
  if (existing && !replace) return res.json({ ok: true, status: "exists" });

  const fileName = `hd_${year.replace(/[^\w\u0590-\u05FF]/g, "")}_${studentId}_${Date.now()}.pdf`;
  fs.writeFileSync(path.join(SCAN_DIR, fileName), req.file.buffer);

  db.exec("BEGIN");
  try {
    if (existing) {
      // מחליפים: מוחקים את הישן מהדיסק כדי לא להשאיר קובץ יתום
      try { fs.unlinkSync(path.join(SCAN_DIR, path.basename(existing.file_name))); } catch (e) {}
      db.prepare("DELETE FROM scanned_forms WHERE id = ?").run(existing.id);
    }
    db.prepare(`INSERT INTO scanned_forms
      (student_id, form_type, year, file_name, file_hash, size_bytes, page_count, uploaded_by_user_id, uploaded_at)
      VALUES (?, 'health', ?, ?, ?, ?, ?, ?, ?)`).run(
      studentId, year, fileName, hash, req.file.size,
      parseInt(req.body.page_count, 10) || 2,
      req.currentUser ? req.currentUser.id : null, new Date().toISOString()
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    try { fs.unlinkSync(path.join(SCAN_DIR, fileName)); } catch (e2) {}
    return res.status(500).json({ ok: false, error: e.message });
  }
  // ממצאי הדיו שהדפדפן חישב - שדות שהודפסו ריקים ונכתב בהם משהו
  let findings = [];
  try { findings = JSON.parse(req.body.findings || "[]"); } catch (e) { findings = []; }
  if (findings.length) {
    const formRow = db.prepare(
      "SELECT id FROM scanned_forms WHERE student_id = ? AND form_type = 'health' AND year = ?"
    ).get(studentId, year);
    if (formRow) {
      const ins = db.prepare(`INSERT OR IGNORE INTO scan_findings
        (form_id, student_id, field_key, field_label, ink_pct, crop_data, status, created_at)
        VALUES (?,?,?,?,?,?, 'pending', ?)`);
      const now2 = new Date().toISOString();
      for (const f of findings.slice(0, 20)) {
        if (!f || !f.key) continue;
        ins.run(formRow.id, studentId, String(f.key), String(f.label || ""),
                Number(f.ink) || 0, String(f.crop || "").slice(0, 300000), now2);
      }
    }
  }

  res.json({ ok: true, status: replace ? "replaced" : "saved", findings: findings.length });
});

// ============ עדכוני הורים מהטפסים ============
// מציג רק את השדות שההורים מילאו, עם תמונת מה שנכתב לצד הערך הקיים.
// המזכירה אינה פותחת טפסים - היא רואה שדות בודדים ומקלידה מה שכתוב.
router.get("/updates", (req, res) => {
  const year = req.query.year || getCurrentYear();
  const rows = db.prepare(`
    SELECT fi.*, s.first_name, s.nickname,
           COALESCE(NULLIF(s.last_name,''), f.last_name) AS family_name,
           c.name AS class_name, c.parallel, c.grade_order,
           s.family_id
    FROM scan_findings fi
    JOIN students s ON s.id = fi.student_id
    LEFT JOIN families f ON s.family_id = f.id
    LEFT JOIN classes c ON s.class_id = c.id
    JOIN scanned_forms sf ON sf.id = fi.form_id
    WHERE fi.status = 'pending' AND sf.year = ?
    ORDER BY c.grade_order, c.name, c.parallel, COALESCE(NULLIF(s.last_name,''), f.last_name), fi.field_key
  `).all(year);

  const counts = db.prepare(`
    SELECT fi.status, COUNT(*) AS n FROM scan_findings fi
    JOIN scanned_forms sf ON sf.id = fi.form_id
    WHERE sf.year = ? GROUP BY fi.status
  `).all(year);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));

  res.render("scans/updates", {
    year, rows,
    pending: byStatus.pending || 0,
    applied: byStatus.applied || 0,
    dismissed: byStatus.dismissed || 0,
  });
});

// שמירת ערך שהמזכירה הקלידה. נכתב לכרטיס המשפחה או התלמיד, ומשם הוא
// מופיע בכל מקום שקורא את השדה - הכרטיס, הדוחות, המדבקות.
router.post("/updates/:id", (req, res) => {
  const fi = db.prepare("SELECT * FROM scan_findings WHERE id = ?").get(req.params.id);
  if (!fi) return res.redirect("/scans/updates");
  const action = req.body.action;
  const value = String(req.body.value || "").trim();

  // רשימה לבנה: רק שדות מוכרים, כדי שלא ניתן יהיה לכתוב לעמודה שרירותית
  const ALLOWED = {
    nickname: "students", health_fund: "students", immigration_year: "students",
    allergies: "students", medications: "students", walks_alone: "students",
    home_phone: "families", father_workplace: "families", father_mobile: "families",
    father_synagogue: "families", mother_workplace: "families", mother_mobile: "families",
    mother_work_phone: "families", father_email: "families", mother_email: "families",
  };

  if (action === "apply" && value && ALLOWED[fi.field_key]) {
    const table = ALLOWED[fi.field_key];
    db.exec("BEGIN");
    try {
      if (table === "students") {
        db.prepare(`UPDATE students SET ${fi.field_key} = ? WHERE id = ?`).run(value, fi.student_id);
      } else {
        const st = db.prepare("SELECT family_id FROM students WHERE id = ?").get(fi.student_id);
        if (st && st.family_id) {
          db.prepare(`UPDATE families SET ${fi.field_key} = ? WHERE id = ?`).run(value, st.family_id);
        }
      }
      db.prepare(`UPDATE scan_findings SET status = 'applied', applied_value = ?,
                  resolved_by_user_id = ?, resolved_at = ? WHERE id = ?`)
        .run(value, req.currentUser ? req.currentUser.id : null, new Date().toISOString(), fi.id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      console.error("עדכון מטופס נכשל:", e.message);
    }
  } else if (action === "dismiss") {
    db.prepare(`UPDATE scan_findings SET status = 'dismissed',
                resolved_by_user_id = ?, resolved_at = ? WHERE id = ?`)
      .run(req.currentUser ? req.currentUser.id : null, new Date().toISOString(), fi.id);
  }
  res.redirect("/scans/updates?year=" + encodeURIComponent(req.body.year || getCurrentYear()));
});

// ============ ייצוא כל הכיתה לקובץ אחד ============
// מאחד את כל הטפסים הסרוקים של הכיתה ל-PDF אחד, ממוין לפי שם משפחה -
// כלומר בדיוק הסדר שבו נוח לעבור עליהם או לתייק אותם.
router.get("/class/:id/export", async (req, res) => {
  const year = req.query.year || getCurrentYear();
  const cls = db.prepare("SELECT * FROM classes WHERE id = ?").get(req.params.id);
  if (!cls) return res.redirect("/scans");

  const rows = db.prepare(`
    SELECT sf.file_name, COALESCE(NULLIF(s.last_name,''), f.last_name) AS family_name,
           s.first_name, s.nickname
    FROM scanned_forms sf
    JOIN students s ON s.id = sf.student_id
    LEFT JOIN families f ON s.family_id = f.id
    WHERE s.class_id = ? AND sf.year = ? AND sf.form_type = 'health'
    ORDER BY COALESCE(NULLIF(s.last_name,''), f.last_name), s.first_name
  `).all(req.params.id, year);

  if (!rows.length) {
    return res.status(404).send("אין טפסים סרוקים לכיתה זו בשנה " + year);
  }

  const { PDFDocument } = require("pdf-lib");
  const out = await PDFDocument.create();
  let merged = 0, missing = 0;

  for (const r of rows) {
    const full = path.join(SCAN_DIR, path.basename(r.file_name));
    if (!fs.existsSync(full)) { missing++; continue; }
    try {
      const src = await PDFDocument.load(fs.readFileSync(full));
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((pg) => out.addPage(pg));
      merged++;
    } catch (e) {
      // קובץ פגום אינו מפיל את כל הייצוא - מדלגים ומדווחים בלוג
      missing++;
      console.error("ייצוא סריקות: דילוג על " + r.file_name + " - " + e.message);
    }
  }
  if (!merged) return res.status(500).send("לא ניתן היה לאחד אף טופס");
  if (missing) console.log(`[סריקות] ייצוא ${cls.name}: אוחדו ${merged}, דולגו ${missing}`);

  const bytes = await out.save();
  const name = `הצהרות בריאות ${cls.name} ${cls.parallel || ""} ${year}.pdf`.replace(/\s+/g, " ").trim();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition",
    "attachment; filename*=UTF-8''" + encodeURIComponent(name));
  res.send(Buffer.from(bytes));
});

// ============ צפייה בטופס ============
router.get("/file/:id", (req, res) => {
  const f = db.prepare(`
    SELECT sf.file_name, sf.year, COALESCE(NULLIF(s.last_name,''), fa.last_name) AS family_name,
           s.first_name, s.nickname
    FROM scanned_forms sf
    JOIN students s ON s.id = sf.student_id
    LEFT JOIN families fa ON s.family_id = fa.id
    WHERE sf.id = ?`).get(req.params.id);
  if (!f) return res.status(404).end();
  // basename: שם הקובץ מגיע מהמסד ולא מהכתובת, ואין דרך לבקש קובץ שרירותי
  const full = path.join(SCAN_DIR, path.basename(f.file_name));
  if (!fs.existsSync(full)) return res.status(404).end();

  // שם משמעותי לקובץ. בלעדיו חלק מהדפדפנים מורידים במקום להציג, וגם אם
  // המשתמש בוחר לשמור - הקובץ נשמר בשם טכני חסר משמעות.
  const nice = `הצהרת בריאות ${f.family_name || ""} ${f.nickname || f.first_name || ""} ${f.year}.pdf`
    .replace(/\s+/g, " ").trim();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition",
    "inline; filename*=UTF-8''" + encodeURIComponent(nice));
  fs.createReadStream(full).pipe(res);
});

// תצוגה מקדימה עם כפתורי הדפסה והורדה. עדיפה על פתיחת ה-PDF הגולמי:
// שם התלמיד מופיע למעלה, ואפשר להדפיס בלחיצה במקום לחפש בתפריט הדפדפן.
router.get("/view/:id", (req, res) => {
  const f = db.prepare(`
    SELECT sf.*, COALESCE(NULLIF(s.last_name,''), fa.last_name) AS family_name,
           s.first_name, s.nickname, s.id AS student_id,
           c.name AS class_name, c.parallel
    FROM scanned_forms sf
    JOIN students s ON s.id = sf.student_id
    LEFT JOIN families fa ON s.family_id = fa.id
    LEFT JOIN classes c ON s.class_id = c.id
    WHERE sf.id = ?`).get(req.params.id);
  if (!f) return res.redirect("/scans");
  res.render("scans/view", {
    form: f,
    uploaded_str: f.uploaded_at ? hd.formatGregorian(f.uploaded_at) : "",
    size_str: f.size_bytes ? fmtSize(f.size_bytes) : "",
    back: req.query.back || "/scans",
  });
});

// טופס לפי תלמיד - הקישור שמופיע בתיק האישי
router.get("/student/:studentId", (req, res) => {
  const year = req.query.year || getCurrentYear();
  const f = db.prepare(
    "SELECT id FROM scanned_forms WHERE student_id = ? AND form_type = 'health' AND year = ?"
  ).get(req.params.studentId, year);
  if (!f) return res.status(404).send("אין טופס סרוק לתלמיד זה בשנה זו");
  res.redirect("/scans/file/" + f.id);
});

router.delete("/:id", (req, res) => {
  const f = db.prepare("SELECT file_name FROM scanned_forms WHERE id = ?").get(req.params.id);
  if (f) {
    try { fs.unlinkSync(path.join(SCAN_DIR, path.basename(f.file_name))); } catch (e) {}
    db.prepare("DELETE FROM scanned_forms WHERE id = ?").run(req.params.id);
  }
  res.redirect(req.get("referer") || "/scans");
});

// ============ ניקוי שנה קודמת ============
// נמחק רק מה שכבר הוחלף: טופס של שנה ישנה שלתלמיד יש עבורו טופס עדכני.
// כך לא נוצר מצב שבו הישן נמחק והחדש עוד לא הגיע ואין כלום.
router.post("/purge-old", (req, res) => {
  const year = getCurrentYear();
  const rows = db.prepare(`
    SELECT old.id, old.file_name FROM scanned_forms old
    WHERE old.year <> ?
      AND EXISTS (SELECT 1 FROM scanned_forms cur
                  WHERE cur.student_id = old.student_id
                    AND cur.form_type = old.form_type AND cur.year = ?)
  `).all(year, year);
  let freed = 0;
  for (const r of rows) {
    const full = path.join(SCAN_DIR, path.basename(r.file_name));
    try { if (fs.existsSync(full)) { freed += fs.statSync(full).size; fs.unlinkSync(full); } } catch (e) {}
    db.prepare("DELETE FROM scanned_forms WHERE id = ?").run(r.id);
  }
  console.log(`[סריקות] נמחקו ${rows.length} טפסים ישנים, שוחררו ${fmtSize(freed)}`);
  res.redirect("/scans?purged=" + rows.length);
});

module.exports = router;
