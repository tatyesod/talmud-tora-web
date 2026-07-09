const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const { buildOrderBy } = require("../sortHelper");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// הגדרת multer להעלאת קבצי תיק עובד
const DATA_DIR = process.env.RENDER_PERSISTENT_DIR || path.join(__dirname, "..");
const uploadDir = path.join(DATA_DIR, "uploads", "teachers");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = Buffer.from(file.originalname, "latin1").toString("utf8");
    cb(null, `${req.params.id}_${ts}_${safe}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB מקסימום
  fileFilter: (req, file, cb) => {
    const allowed = [".pdf", ".doc", ".docx", ".jpg", ".jpeg", ".png", ".xls", ".xlsx"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

const HEBREW_GREGORIAN_MONTHS = [
  "ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
  "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר",
];
function formatMonthLabel(monthLabel) {
  if (!monthLabel) return "";
  const [y, m] = monthLabel.split("-");
  const idx = parseInt(m, 10) - 1;
  return `${HEBREW_GREGORIAN_MONTHS[idx] || m} ${y}`;
}

function calcAge(accessSerial) {
  if (!accessSerial) return null;
  // המרה מ-Access serial ל-JavaScript Date
  const epoch = new Date(1899, 11, 30);
  const date = new Date(epoch.getTime() + accessSerial * 86400000);
  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const m = today.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < date.getDate())) age--;
  return age;
}

function withDates(t) {
  if (!t) return t;
  return {
    ...t,
    birth_date_civil_str: hd.serialToGregorianString(t.birth_date_civil),
    birth_date_hebrew_str: hd.serialToHebrewString(t.birth_date_civil),
    entry_date_str: hd.serialToGregorianString(t.entry_date),
    exit_date_str: hd.serialToGregorianString(t.exit_date),
    spouse_birth_date_str: hd.serialToGregorianString(t.spouse_birth_date),
    spouse_birth_date_hebrew_str: hd.serialToHebrewString(t.spouse_birth_date),
    age: calcAge(t.birth_date_civil),
    spouse_age: calcAge(t.spouse_birth_date),
  };
}

router.get("/", (req, res) => {
  const { q } = req.query;
  const status = req.query.status !== undefined ? req.query.status : "פעיל";
  let sql = `
    SELECT t.*, ch.name AS chassidut_name,
      (SELECT GROUP_CONCAT(c.name || COALESCE(' '||c.parallel,''), ', ')
       FROM teacher_classes tc JOIN classes c ON tc.class_id=c.id
       WHERE tc.teacher_id=t.id AND tc.role='בוקר') AS morning_classes,
      (SELECT GROUP_CONCAT(c.name || COALESCE(' '||c.parallel,''), ', ')
       FROM teacher_classes tc JOIN classes c ON tc.class_id=c.id
       WHERE tc.teacher_id=t.id AND tc.role='אחה"צ') AS afternoon_classes
    FROM teachers t
    LEFT JOIN chassidut ch ON t.chassidut_id = ch.id WHERE 1=1
  `;
  const params = [];
  if (q) {
    sql += " AND (t.last_name LIKE ? OR t.first_name LIKE ? OR t.mobile LIKE ? OR t.id_number LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status) {
    sql += " AND t.status = ?";
    params.push(status);
  }
  sql += " " + buildOrderBy(
    req,
    {
      last_name: "t.last_name, t.first_name",
      first_name: "t.first_name, t.last_name",
      id_number: "t.id_number",
      mobile: "t.mobile",
      chassidut: "ch.name",
      children_count: "COALESCE(t.children_count, t.children_count_total)",
      status: "t.status",
    },
    "ORDER BY t.last_name, t.first_name"
  );

  const teachers = db.prepare(sql).all(...params).map(withDates).map((t) => ({
    ...t,
    children_count_display: t.children_count != null ? t.children_count : t.children_count_total,
  }));
  const statuses = db.prepare("SELECT DISTINCT status FROM teachers WHERE status IS NOT NULL ORDER BY status").all();
  const totalChildren = teachers.reduce((sum, t) => sum + (t.children_count_display || 0), 0);
  res.render("teachers/list", { teachers, statuses, q: q || "", status: status || "", sort: req.query.sort || "", dir: req.query.dir || "", totalChildren });
});

router.get("/new", (req, res) => {
  const chassidut = db.prepare("SELECT id, name FROM chassidut ORDER BY name").all();
  res.render("teachers/form", { teacher: {}, mode: "new", chassidut });
});

const TEACHER_FIELDS = [
  "last_name", "first_name", "id_number", "birth_date_civil", "street", "house_number",
  "apartment", "city", "zip_code", "home_phone", "mobile", "chassidut_id", "notes",
  "status", "entry_date", "update_date", "exit_date", "children_count",
];
const DATE_FIELDS = ["birth_date_civil", "entry_date", "update_date", "exit_date"];

function normalizeField(col, value) {
  if (value === undefined || value === "") return null;
  if (DATE_FIELDS.includes(col)) return hd.gregorianStringToSerial(value);
  return value;
}

router.post("/", (req, res) => {
  const body = req.body;
  const cols = TEACHER_FIELDS.filter((c) => c in body);
  const values = cols.map((c) => normalizeField(c, body[c]));
  const info = db
    .prepare(`INSERT INTO teachers (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...values);
  res.redirect(`/teachers/${info.lastInsertRowid}`);
});

router.get("/monthly-reports", (req, res) => {
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const teachers = db.prepare("SELECT id, first_name, last_name FROM teachers ORDER BY last_name, first_name").all();
  const reportsForMonth = db.prepare("SELECT * FROM teacher_monthly_reports WHERE month_label = ?").all(month);
  const reportByTeacher = {};
  reportsForMonth.forEach((r) => { reportByTeacher[r.teacher_id] = r; });

  const rows = teachers.map((t) => {
    const r = reportByTeacher[t.id];
    return {
      teacher_id: t.id,
      teacher_name: `${t.last_name || ""} ${t.first_name || ""}`.trim(),
      submitted: !!r,
      submitted_date_str: r && r.submitted_date ? new Date(r.submitted_date).toLocaleDateString("he-IL") : "",
      file_path: r ? r.file_path : null,
      file_name: r ? r.file_name : null,
    };
  });

  const submittedCount = rows.filter((r) => r.submitted).length;
  res.render("teachers/monthly-reports", {
    month, monthDisplay: formatMonthLabel(month), rows, submittedCount, total: rows.length,
  });
});

// ============ מצבת מלמדים - מפת שיבוץ לכל הכיתות ============
router.get("/staffing-map", (req, res) => {
  const classes = db.prepare(`
    SELECT id, name, parallel, branch FROM classes
    WHERE status = 'פעיל'
    ORDER BY branch, name, parallel
  `).all();

  const assignmentsStmt = db.prepare(`
    SELECT tc.role, t.id AS teacher_id, t.first_name, t.last_name
    FROM teacher_classes tc JOIN teachers t ON tc.teacher_id = t.id
    WHERE tc.class_id = ?
  `);
  const allTeachers = db.prepare("SELECT id, first_name, last_name FROM teachers WHERE status='פעיל' ORDER BY last_name, first_name").all();

  const STAGE_ORDER = [
    "עדיין לא נכנסו", "מכינה א'", "מכינה ב'",
    "כיתה א'", "כיתה ב'", "כיתה ג'", "כיתה ד'",
    "כיתה ה'", "כיתה ו'", "כיתה ז'", "כיתה ח'",
  ];
  function classRank(name) {
    const idx = STAGE_ORDER.findIndex((s) => name && name.startsWith(s));
    return idx === -1 ? 999 : idx;
  }

  // מכינה ב' מתחילה לימודי אחה"צ רק אחרי חנוכה - לפני כן זה לא נחשב "חוסר" אמיתי.
  // בודקים לפי חודש לועזי (חנוכה תמיד בנובמבר/דצמבר) כדי לא להסתבך עם חישוב מדויק מדי.
  const currentMonth = new Date().getMonth() + 1; // 1-12
  const isBeforeChanukah = currentMonth >= 9 && currentMonth <= 11; // ספטמבר-נובמבר = לפני חנוכה

  let missingMorning = 0, missingAfternoon = 0, missingHelper = 0;
  const rows = classes.map((c) => {
    const assignments = assignmentsStmt.all(c.id);
    const find = (role) => assignments.find((a) => a.role === role);
    const morning = find("בוקר");
    const afternoon = find('אחה"צ');
    const helper = find("עוזר");
    const isMechinaA = c.name && c.name.startsWith("מכינה א'");
    const isMechinaB = c.name && c.name.startsWith("מכינה ב'");
    const isMechina = isMechinaA || isMechinaB;

    // אחה"צ: לא רלוונטי כלל למכינה א'; למכינה ב' רלוונטי רק אחרי חנוכה; לכל שאר הכיתות - חובה.
    let afternoonStatus = "required";
    if (isMechinaA) afternoonStatus = "na";
    else if (isMechinaB) afternoonStatus = isBeforeChanukah ? "grace" : "required";

    // עוזר: רלוונטי רק למכינה א'/ב'; בכל שאר הכיתות - לא רלוונטי כלל.
    const helperStatus = isMechina ? "required" : "na";

    if (!morning) missingMorning++;
    if (afternoonStatus === "required" && !afternoon) missingAfternoon++;
    if (helperStatus === "required" && !helper) missingHelper++;

    return {
      class_id: c.id,
      class_name: c.name,
      parallel: c.parallel,
      class_full_name: `${c.name}${c.parallel ? " " + c.parallel : ""}`,
      branch: c.branch || "",
      morning, afternoon, helper, afternoonStatus, helperStatus,
      rank: classRank(c.name),
    };
  }).sort((a, b) => (a.branch || "").localeCompare(b.branch || "", "he") || a.rank - b.rank || (a.parallel || "").localeCompare(b.parallel || "", "he"));

  const branches = [...new Set(rows.map((r) => r.branch))];

  res.render("teachers/staffing-map", {
    rows, branches, allTeachers, missingMorning, missingAfternoon, missingHelper,
    totalClasses: classes.length, saved: req.query.saved === "1",
  });
});

// שיבוץ/החלפה/ביטול מלמד ישירות מהמפה - מעדכן את אותה טבלת teacher_classes
// שמשמשת גם את עמוד עריכת הכיתה וגם את כרטיס המלמד, כך שהכל מסונכרן אוטומטית.
router.post("/staffing-map/assign", (req, res) => {
  const { class_id, role, teacher_id } = req.body;
  db.prepare("DELETE FROM teacher_classes WHERE class_id = ? AND role = ?").run(class_id, role);
  if (teacher_id) {
    db.prepare("INSERT INTO teacher_classes (class_id, teacher_id, role) VALUES (?,?,?)").run(class_id, teacher_id, role);
  }
  res.redirect("/teachers/staffing-map?saved=1");
});

router.get("/:id", (req, res) => {
  const teacher = withDates(
    db.prepare(`
      SELECT t.*, ch.name AS chassidut_name FROM teachers t
      LEFT JOIN chassidut ch ON t.chassidut_id = ch.id WHERE t.id = ?
    `).get(req.params.id)
  );
  if (!teacher) return res.status(404).render("404");
  // רכיבי שכר הם חלק מ"תיק עובד" - לא נחשפים למשתמשים שאינם מנהלים, גם ברמת הנתונים
  if (!req.currentUser || !req.currentUser.is_admin) {
    delete teacher.hourly_rate;
    delete teacher.monthly_hours;
  }
  const classes = db
    .prepare(`
      SELECT c.*, tc.role FROM teacher_classes tc JOIN classes c ON tc.class_id = c.id
      WHERE tc.teacher_id = ?
    `)
    .all(req.params.id);

  const attendance = db
    .prepare("SELECT * FROM teacher_attendance WHERE teacher_id = ? ORDER BY att_date DESC LIMIT 30")
    .all(req.params.id)
    .map((a) => ({ ...a, att_date_str: hd.serialToGregorianString(a.att_date) }));

  const attendanceSummary = db
    .prepare("SELECT status, COUNT(*) c FROM teacher_attendance WHERE teacher_id = ? GROUP BY status")
    .all(req.params.id);

  // "תיק עובד" (חוזי העסקה וכד') - חומר אישי רגיש, זמין למנהלים בלבד
  const file = req.currentUser && req.currentUser.is_admin
    ? db.prepare("SELECT * FROM teacher_file WHERE teacher_id = ? ORDER BY entry_date DESC")
        .all(req.params.id)
        .map((f) => ({ ...f, entry_date_str: hd.serialToGregorianString(f.entry_date) }))
    : null;

  const monthlyReports = db
    .prepare("SELECT * FROM teacher_monthly_reports WHERE teacher_id = ? ORDER BY month_label DESC")
    .all(req.params.id)
    .map((r) => ({
      ...r,
      month_display: formatMonthLabel(r.month_label),
      submitted_date_str: r.submitted_date ? new Date(r.submitted_date).toLocaleDateString("he-IL") : "",
      is_image: r.file_name && /\.(jpg|jpeg|png)$/i.test(r.file_name),
      is_pdf: r.file_name && /\.pdf$/i.test(r.file_name),
    }));

  // ניווט הקודם/הבא - לפי אותו סדר אלפביתי שמוצג ברשימת המלמדים
  const allIds = db.prepare("SELECT id FROM teachers ORDER BY last_name, first_name, id").all().map((r) => r.id);
  const idx = allIds.indexOf(Number(req.params.id));
  const prevTeacherId = idx > 0 ? allIds[idx - 1] : null;
  const nextTeacherId = idx >= 0 && idx < allIds.length - 1 ? allIds[idx + 1] : null;

  res.render("teachers/view", { teacher, classes, attendance, attendanceSummary, file, monthlyReports, prevTeacherId, nextTeacherId });
});

router.post("/:id/attendance", (req, res) => {
  const { att_date, status, day_part, notes } = req.body;
  db.prepare("INSERT INTO teacher_attendance (teacher_id, att_date, status, day_part, notes) VALUES (?,?,?,?,?)").run(
    req.params.id, att_date ? hd.gregorianStringToSerial(att_date) : hd.todayAccessSerial(), status, day_part || "יום שלם", notes || null
  );
  res.redirect(`/teachers/${req.params.id}`);
});

router.delete("/:id/attendance/:attId", (req, res) => {
  db.prepare("DELETE FROM teacher_attendance WHERE id = ? AND teacher_id = ?").run(req.params.attId, req.params.id);
  res.redirect(`/teachers/${req.params.id}`);
});

router.post("/:id/salary", (req, res) => {
  // רכיבי שכר הם חלק מ"תיק עובד" - חומר אישי רגיש, עדכון מותר למנהלים בלבד.
  // בכוונה נשמר בנתיב נפרד מטופס עריכת המלמד הכללי, כדי שלא ייחשף/יתעדכן
  // דרך מסך שגם משתמשים רגילים יכולים לגשת אליו.
  if (!req.currentUser || !req.currentUser.is_admin) {
    return res.status(403).render("403");
  }
  const hourlyRate = parseFloat(req.body.hourly_rate);
  const monthlyHours = parseFloat(req.body.monthly_hours);
  db.prepare("UPDATE teachers SET hourly_rate = ?, monthly_hours = ? WHERE id = ?").run(
    isNaN(hourlyRate) ? null : hourlyRate,
    isNaN(monthlyHours) ? null : monthlyHours,
    req.params.id
  );
  res.redirect(`/teachers/${req.params.id}`);
});

router.post("/:id/file", upload.single("attachment"), (req, res) => {
  // "תיק עובד" הוא חומר אישי רגיש (חוזי העסקה וכד') - העלאה מותרת למנהלים בלבד
  if (!req.currentUser || !req.currentUser.is_admin) {
    return res.status(403).render("403");
  }
  const { entry_date, category, notes } = req.body;
  const file_path = req.file ? `/uploads/teachers/${req.file.filename}` : null;
  const file_name = req.file ? Buffer.from(req.file.originalname, "latin1").toString("utf8") : null;
  db.prepare("INSERT INTO teacher_file (teacher_id, entry_date, category, notes, file_path, file_name) VALUES (?,?,?,?,?,?)").run(
    req.params.id,
    entry_date ? hd.gregorianStringToSerial(entry_date) : hd.todayAccessSerial(),
    category || null,
    notes || null,
    file_path,
    file_name
  );
  res.redirect(`/teachers/${req.params.id}`);
});

// ============ דוחות חודשיים ============

router.post("/:id/monthly-report", upload.single("attachment"), (req, res) => {
  const { month_label, submitted_date, notes } = req.body;
  const file_path = req.file ? `/uploads/teachers/${req.file.filename}` : null;
  const file_name = req.file ? Buffer.from(req.file.originalname, "latin1").toString("utf8") : null;
  db.prepare(`
    INSERT INTO teacher_monthly_reports (teacher_id, month_label, submitted_date, file_path, file_name, notes, created_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(
    req.params.id, month_label, submitted_date || new Date().toISOString().slice(0, 10),
    file_path, file_name, notes || null, new Date().toISOString()
  );
  res.redirect(`/teachers/${req.params.id}`);
});

router.delete("/:id/monthly-report/:reportId", (req, res) => {
  db.prepare("DELETE FROM teacher_monthly_reports WHERE id = ? AND teacher_id = ?").run(req.params.reportId, req.params.id);
  res.redirect(`/teachers/${req.params.id}`);
});

router.delete("/:id/file/:fileId", (req, res) => {
  if (!req.currentUser || !req.currentUser.is_admin) {
    return res.status(403).render("403");
  }
  const row = db.prepare("SELECT file_path FROM teacher_file WHERE id=? AND teacher_id=?").get(req.params.fileId, req.params.id);
  if (row?.file_path) {
    const full = path.join(__dirname, "..", row.file_path.replace(/^\//, ""));
    try { if (fs.existsSync(full)) fs.unlinkSync(full); } catch(e) {}
  }
  db.prepare("DELETE FROM teacher_file WHERE id = ? AND teacher_id = ?").run(req.params.fileId, req.params.id);
  res.redirect(`/teachers/${req.params.id}`);
});

router.get("/:id/edit", (req, res) => {
  const teacher = db.prepare("SELECT * FROM teachers WHERE id = ?").get(req.params.id);
  if (!teacher) return res.status(404).render("404");
  const chassidut = db.prepare("SELECT id, name FROM chassidut ORDER BY name").all();
  const allClasses = db.prepare("SELECT id, name, parallel, branch FROM classes ORDER BY name, parallel").all();
  const assignments = db
    .prepare(`
      SELECT tc.id AS assignment_id, tc.role, c.id AS class_id, c.name, c.parallel
      FROM teacher_classes tc JOIN classes c ON tc.class_id = c.id
      WHERE tc.teacher_id = ?
      ORDER BY c.name, c.parallel
    `)
    .all(req.params.id);
  res.render("teachers/form", {
    teacher: {
      ...teacher,
      birth_date_civil: hd.serialToInputDate(teacher.birth_date_civil),
      birth_date_hebrew_str: hd.serialToHebrewString(teacher.birth_date_civil),
      entry_date: hd.serialToInputDate(teacher.entry_date),
      exit_date: hd.serialToInputDate(teacher.exit_date),
    },
    mode: "edit", chassidut, allClasses, assignments,
    assignError: req.query.assignError || null,
  });
});

router.post("/:id/classes", (req, res) => {
  const { class_id, role } = req.body;
  if (class_id) {
    // מניעת שיבוץ כפול לאותה כיתה באותה משמרת (בוקר/אחה"צ) - לא רלוונטי לתפקיד "עוזר"
    if (role === "בוקר" || role === 'אחה"צ') {
      const existing = db.prepare(`
        SELECT t.id, t.first_name, t.last_name FROM teacher_classes tc
        JOIN teachers t ON tc.teacher_id = t.id
        WHERE tc.class_id = ? AND tc.role = ? AND tc.teacher_id != ?
      `).get(class_id, role, req.params.id);
      if (existing) {
        const cls = db.prepare("SELECT name, parallel FROM classes WHERE id = ?").get(class_id);
        const className = [cls?.name, cls?.parallel].filter(Boolean).join(" ");
        const msg = `הכיתה ${className} כבר משובצת ל${role} עם ${existing.first_name || ""} ${existing.last_name || ""}. לא ניתן לשבץ מלמד נוסף לאותה כיתה באותה משמרת.`;
        return res.redirect(`/teachers/${req.params.id}/edit?assignError=${encodeURIComponent(msg)}`);
      }
    }
    db.prepare("INSERT INTO teacher_classes (class_id, teacher_id, role) VALUES (?,?,?)").run(
      class_id, req.params.id, role || null
    );
  }
  res.redirect(`/teachers/${req.params.id}/edit`);
});

router.delete("/:id/classes/:assignmentId", (req, res) => {
  db.prepare("DELETE FROM teacher_classes WHERE id = ? AND teacher_id = ?").run(
    req.params.assignmentId, req.params.id
  );
  res.redirect(`/teachers/${req.params.id}/edit`);
});

router.put("/:id", (req, res) => {
  const body = req.body;
  const cols = TEACHER_FIELDS.filter((c) => c in body);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => normalizeField(c, body[c]));
  values.push(req.params.id);
  db.prepare(`UPDATE teachers SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect(`/teachers/${req.params.id}`);
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM teachers WHERE id = ?").run(req.params.id);
  res.redirect("/teachers");
});

module.exports = router;
