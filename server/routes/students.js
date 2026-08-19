const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const { buildOrderBy } = require("../sortHelper");
const { checkNoConflict } = require("../concurrency");
const { resolveZone, saveZoneOverride, findWaitingClassForZone, isWaitingClass, findSiblingBranchConflict, ZONE_BRANCH } = require("../zoneResolver");

function calcAge(accessSerial) {
  if (!accessSerial) return null;
  const epoch = new Date(1899, 11, 30);
  const date = new Date(epoch.getTime() + accessSerial * 86400000);
  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const m = today.getMonth() - date.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < date.getDate())) age--;
  return age;
}

function withDates(student) {
  if (!student) return student;
  return {
    ...student,
    birth_date_civil_str: hd.serialToGregorianString(student.birth_date_civil),
    birth_date_hebrew_str: hd.serialToHebrewString(student.birth_date_civil),
    entry_date_str: hd.serialToGregorianString(student.entry_date),
    exit_date_str: hd.serialToGregorianString(student.exit_date),
    registration_date_str: hd.serialToGregorianString(student.registration_date),
    admission_date_str: hd.serialToGregorianString(student.admission_date),
    update_date_str: hd.serialToGregorianString(student.update_date),
    age: calcAge(student.birth_date_civil),
  };
}

const STUDENT_SELECT = `
  SELECT s.*, c.name AS class_name, c.parallel AS class_parallel, COALESCE(c.branch, s.branch) AS branch, c.institution_code, co.name AS cohort_name,
         f.last_name AS family_last_name, f.father_name, f.mother_name, f.sector,
         f.home_phone, f.father_mobile, f.mother_mobile,
         f.street, f.house_number, f.apartment, f.city
  FROM students s
  LEFT JOIN classes c ON s.class_id = c.id
  LEFT JOIN cohorts co ON s.cohort_id = co.id
  LEFT JOIN families f ON s.family_id = f.id
`;

function getEmergencyContacts(familyId) {
  if (!familyId) return [];
  return db.prepare("SELECT * FROM emergency_contacts WHERE family_id = ?").all(familyId);
}

function getStudentFile(studentId) {
  return db
    .prepare("SELECT * FROM student_file WHERE student_id = ? ORDER BY entry_date DESC")
    .all(studentId)
    .map((r) => ({ ...r, entry_date_str: hd.serialToGregorianString(r.entry_date) }));
}

// בודק אם שיבוץ תלמיד לכיתה מתאים לשנתון שלו - אין מיפוי מפורש בין כיתה
// לשנתון, אז בודקים התאמה מול השנתון ה*רוב* (הנפוץ ביותר) של תלמידים
// אחרים שכבר משובצים לאותה כיתה (הם בפועל מגדירים "מה השנתון של הכיתה
// הזו"). משתמשים ברוב, לא בכל חוסר-התאמה בודד, כדי שחריג אחד שכבר אושר
// במפורש לא ימשיך "לתפוס" כל שיבוץ תקין אחר לאותה כיתה. מחזיר את פרטי
// השנתון הדומיננטי אם הוא שונה מזה שנבחר, או null אם הכל תקין.
function checkCohortMismatch(classId, cohortId, excludeStudentId) {
  if (!classId || !cohortId) return null;
  let sql = `
    SELECT s.cohort_id, co.name AS cohort_name, COUNT(*) AS cnt
    FROM students s
    JOIN cohorts co ON s.cohort_id = co.id
    WHERE s.class_id = ? AND s.status = 'פעיל' AND s.cohort_id IS NOT NULL
  `;
  const params = [classId];
  if (excludeStudentId) {
    sql += " AND s.id != ?";
    params.push(excludeStudentId);
  }
  sql += " GROUP BY s.cohort_id ORDER BY cnt DESC LIMIT 1";
  const dominant = db.prepare(sql).get(...params);
  if (!dominant) return null; // אין עדיין תלמידים בכיתה - שום דבר להשוות מולו
  if (String(dominant.cohort_id) === String(cohortId)) return null; // תואם לרוב - הכל תקין
  return dominant;
}

function getClassTeachers(classId) {
  if (!classId) return [];
  return db
    .prepare(`
      SELECT t.*, tc.role FROM teacher_classes tc
      JOIN teachers t ON tc.teacher_id = t.id
      WHERE tc.class_id = ?
      ORDER BY CASE tc.role WHEN 'בוקר' THEN 1 WHEN 'אחה"צ' THEN 2 WHEN 'עוזר' THEN 3 ELSE 4 END
    `)
    .all(classId);
}

// --- רשימה וחיפוש ---
router.get("/", (req, res) => res.redirect("/students"));

// מזהה אוטומטית את המחזור המתאים לפי תאריך לידה - משמש בטופס התלמיד כדי
// לבחור מחזור אוטומטית ברגע שמזינים תאריך לידה
router.get("/students/api/cohort-for-date", (req, res) => {
  const { date } = req.query;
  if (!date) return res.json({ cohort: null });
  let serial;
  try {
    serial = hd.gregorianStringToSerial(date);
  } catch (e) {
    return res.json({ cohort: null });
  }
  if (!serial) return res.json({ cohort: null });
  const cohort = db.prepare(`
    SELECT id, name FROM cohorts
    WHERE from_date <= ? AND to_date >= ?
    ORDER BY from_date DESC LIMIT 1
  `).get(serial, serial);
  res.json({ cohort: cohort || null });
});

router.get("/students/mismatched-branch", (req, res) => {
  const students = db.prepare(`
    SELECT s.id, s.first_name, s.last_name, s.branch AS student_branch,
           c.name AS class_name, c.parallel AS class_parallel, c.branch AS class_branch,
           f.last_name AS family_last_name
    FROM students s
    JOIN classes c ON s.class_id = c.id
    LEFT JOIN families f ON s.family_id = f.id
    WHERE COALESCE(c.class_kind,'regular') <> 'waiting'
      AND s.branch IS NOT NULL AND TRIM(s.branch) != ''
      AND s.branch != c.branch
    ORDER BY s.last_name, s.first_name
  `).all();
  res.render("students/mismatched-branch", { students });
});

router.get("/students/duplicates", (req, res) => {
  const dupIds = db.prepare(`
    SELECT id_number FROM students
    WHERE id_number IS NOT NULL AND TRIM(id_number) != ''
    GROUP BY id_number HAVING COUNT(*) > 1
  `).all().map((r) => r.id_number);

  const groups = dupIds.map((idNumber) => {
    const students = db.prepare(`
      SELECT s.id, s.first_name, s.last_name, s.status, c.name AS class_name, c.parallel AS class_parallel,
             f.last_name AS family_last_name
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN families f ON s.family_id = f.id
      WHERE s.id_number = ?
      ORDER BY s.id
    `).all(idNumber);
    return { idNumber, students };
  });

  res.render("students/duplicates", { groups });
});

router.get("/students", (req, res) => {
  const { q, class_id, cohort_id, sector, branch, archive_type } = req.query;
  const status = req.query.status !== undefined ? req.query.status : "פעיל";
  let sql = STUDENT_SELECT + " WHERE 1=1";
  const params = [];

  if (q) {
    sql += ` AND (
      s.last_name LIKE ? OR s.first_name LIKE ? OR s.nickname LIKE ? OR
      s.id_number LIKE ? OR f.father_name LIKE ? OR f.home_phone LIKE ? OR
      f.father_mobile LIKE ? OR f.mother_mobile LIKE ?
    )`;
    const like = `%${q}%`;
    for (let i = 0; i < 8; i++) params.push(like);
  }
  if (class_id) {
    if (class_id === "__none__") {
      sql += " AND s.class_id IS NULL";
    } else {
      sql += " AND s.class_id = ?";
      params.push(class_id);
    }
  }
  if (status) {
    sql += " AND s.status = ?";
    params.push(status);
  }
  if (cohort_id) {
    sql += " AND s.cohort_id = ?";
    params.push(cohort_id);
  }
  if (sector) {
    sql += " AND f.sector = ?";
    params.push(sector);
  }
  // סינון בוגרים/עזבו. רלוונטי רק בתוך סטטוס ארכיון, ולכן מצומצם אליו במפורש
  // כדי שסינון "בוגר" לא ישלוף בטעות תלמיד פעיל שיש לו ערך שיורי בשדה.
  if (archive_type) {
    sql += " AND s.status = 'ארכיון' AND s.archive_type = ?";
    params.push(archive_type);
  }
  if (branch) {
    if (branch === "__none__") {
      sql += " AND COALESCE(c.branch, s.branch) IS NULL";
    } else {
      sql += " AND COALESCE(c.branch, s.branch) = ?";
      params.push(branch);
    }
  }
  sql += " " + buildOrderBy(
    req,
    {
      last_name: "s.last_name, s.first_name",
      first_name: "s.first_name, s.last_name",
      nickname: "s.nickname",
      class_name: "c.name, c.parallel",
      cohort_name: "co.name",
      id_number: "s.id_number",
      home_phone: "f.home_phone",
      status: "s.status",
    },
    "ORDER BY s.last_name, s.first_name"
  );

  const students = db.prepare(sql).all(...params).map(withDates);
  // כשהסינון הוא "פעיל", אין טעם להציג במסנן הכיתות את כיתות "עדיין לא
  // נכנסו" - הן מכילות בהגדרה תלמידים שטרם התחילו. בכל סינון אחר, וגם
  // כשמציגים הכל, הן כן מוצגות כדי שניתן יהיה להגיע אליהן.
  const classes = db.prepare(
    "SELECT id, name, parallel FROM classes" +
    (status === "פעיל" ? " WHERE COALESCE(class_kind,'regular') <> 'waiting'" : "") +
    " ORDER BY grade_order, name, parallel"
  ).all();
  const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
  const statuses = db.prepare("SELECT DISTINCT status FROM students WHERE status IS NOT NULL ORDER BY status").all();

  res.render("students/list", {
    students, classes, cohorts, statuses,
    q: q || "", class_id: class_id || "", status: status || "", cohort_id: cohort_id || "",
    archive_type: archive_type || "",
    // מחרוזת הסינון הנוכחית, נגררת דרך כרטיס התלמיד וטופס העריכה כדי שחזרה
    // אחרי שמירה תחזיר לרשימה המסוננת ולא לרשימה מאופסת.
    listQuery: new URLSearchParams(req.query).toString(),
    sector: sector || "", branch: branch || "",
    sort: req.query.sort || "", dir: req.query.dir || "",
  });
});

// --- הוספה ---
// ============ עדכון מרוכז של סוג ארכיון (בוגר / עזב) ============
// מסך זמני לסימון ראשוני של תלמידי הארכיון הקיימים, שהגיעו מייבוא הנתונים
// ואי אפשר לדעת לגביהם אוטומטית מי סיים כיתה ח' ומי עזב באמצע.
// מרגע שהסימון הראשוני הושלם אפשר להסיר את שני ה-routes האלה ואת התבנית
// students/bulk-archive-type.ejs - הסימון השוטף נעשה לבד בהעלאת שנה.
router.get("/students/bulk-archive-type", (req, res) => {
  const { cohort_id } = req.query;
  let sql = `
    SELECT s.id, s.first_name, s.nickname, s.last_name, s.archive_type,
           f.last_name AS family_last_name, co.name AS cohort_name, co.id AS cohort_id
    FROM students s
    LEFT JOIN families f ON s.family_id = f.id
    LEFT JOIN cohorts co ON s.cohort_id = co.id
    WHERE s.status = 'ארכיון'
  `;
  const params = [];
  if (cohort_id) {
    if (cohort_id === "__none__") sql += " AND s.cohort_id IS NULL";
    else { sql += " AND s.cohort_id = ?"; params.push(cohort_id); }
  }
  // מיון לפי מחזור ואז שם - כך שמחזור שלם (שכולו בוגרים) מסומן ברצף אחד
  sql += " ORDER BY co.from_date, co.name, f.last_name, s.last_name, s.first_name";
  const students = db.prepare(sql).all(...params);

  // רק מחזורים שיש בהם תלמידי ארכיון - אין טעם להציג מחזור ריק בתפריט
  const cohorts = db.prepare(`
    SELECT co.id, co.name, COUNT(*) n FROM students s
    JOIN cohorts co ON s.cohort_id = co.id
    WHERE s.status = 'ארכיון'
    GROUP BY co.id ORDER BY co.from_date, co.name
  `).all();
  const noCohort = db.prepare("SELECT COUNT(*) c FROM students WHERE status = 'ארכיון' AND cohort_id IS NULL").get().c;

  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN archive_type = 'בוגר' THEN 1 ELSE 0 END) grads,
      SUM(CASE WHEN archive_type = 'עזב' THEN 1 ELSE 0 END) left_,
      SUM(CASE WHEN archive_type IS NULL OR archive_type = '' THEN 1 ELSE 0 END) unset,
      COUNT(*) total
    FROM students WHERE status = 'ארכיון'
  `).get();

  res.render("students/bulk-archive-type", {
    students, cohorts, noCohort, totals,
    cohort_id: cohort_id || "",
    saved: req.query.saved ? parseInt(req.query.saved, 10) : null,
  });
});

router.post("/students/bulk-archive-type", (req, res) => {
  const body = req.body;
  // הטופס שולח archive_type_<id> לכל שורה. עוברים רק על מי שנשלח בפועל,
  // כך ששורות שסוננו החוצה מהמסך לא נדרסות.
  const update = db.prepare("UPDATE students SET archive_type = ?, updated_at = ? WHERE id = ? AND status = 'ארכיון'");
  const now = new Date().toISOString();
  let changed = 0;
  for (const key of Object.keys(body)) {
    const m = key.match(/^archive_type_(\d+)$/);
    if (!m) continue;
    const value = body[key] === "בוגר" || body[key] === "עזב" ? body[key] : null;
    const info = update.run(value, now, parseInt(m[1], 10));
    changed += info.changes;
  }
  const back = body.cohort_id ? `&cohort_id=${encodeURIComponent(body.cohort_id)}` : "";
  res.redirect(`/students/bulk-archive-type?saved=${changed}${back}`);
});

router.get("/students/new", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY grade_order, name, parallel").all();
  const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
  const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
  const chassidut = db.prepare("SELECT id, name FROM chassidut ORDER BY name").all();
  const yeshivot = db.prepare("SELECT id, name FROM yeshivot ORDER BY name").all();
  res.render("students/form", { student: {}, mode: "new", classes, cohorts, families, chassidut, yeshivot });
});

const STUDENT_FIELDS = [
  "last_name", "first_name", "nickname", "class_id", "id_number", "notes",
  "allergies", "medications", "walks_alone", "health_fund", "birth_country", "immigration_year", "family_id", "status",
  "cohort_id", "birth_date_civil", "entry_date", "update_date", "exit_date",
  "registration_date", "admission_date", "branch",
  // "בוגר" / "עזב" - רלוונטי רק לסטטוס ארכיון. נכתב אוטומטית בהעלאת שנה
  // למי שסיים כיתה ח', וניתן לשינוי ידני מהטופס.
  "archive_type",
  // סייע/מסייע
  "aide_eligible", "aide_type", "aide_name", "aide_mobile", "aide_id_number", "aide_payer",
  "aide_hours",
];
const DATE_FIELDS = ["birth_date_civil", "entry_date", "update_date", "exit_date", "registration_date", "admission_date"];

function normalizeField(col, value) {
  if (value === undefined || value === "") return null;
  if (DATE_FIELDS.includes(col)) return hd.gregorianStringToSerial(value);
  return value;
}

router.post("/students", (req, res) => {
  const body = req.body;

  // בדיקת כפילות ת"ז - לפני שנוגעים במשהו במסד (גם לפני יצירת משפחה חדשה),
  // כדי שלא ניצור רשומות מיותרות אם מתברר שזו כפילות.
  if (body.id_number && body.id_number.trim()) {
    const dup = db.prepare(`
      SELECT s.id, s.first_name, s.last_name, f.last_name AS family_last_name
      FROM students s LEFT JOIN families f ON s.family_id = f.id
      WHERE s.id_number = ?
    `).get(body.id_number.trim());
    if (dup) {
      const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY grade_order, name, parallel").all();
      const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
      const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
      const chassidut = db.prepare("SELECT id, name FROM chassidut ORDER BY name").all();
      const yeshivot = db.prepare("SELECT id, name FROM yeshivot ORDER BY name").all();
      return res.render("students/form", {
        student: body, mode: "new", classes, cohorts, families, chassidut, yeshivot,
        duplicateIdError: `מספר הזהות ${body.id_number.trim()} כבר קיים במערכת - עבור התלמיד/ה ${dup.first_name || ""} ${dup.last_name || dup.family_last_name || ""}. יש לוודא שזה לא אותו תלמיד לפני שממשיכים.`,
      });
    }
  }

  // בדיקת התאמת שנתון לכיתה - לפני שנוגעים במשהו במסד. אם לא אושר במפורש
  // ("כן, שבץ בכל זאת"), מציגים אזהרה במקום לשמור ישר.
  if (body.class_id && body.cohort_id && body.confirm_cohort_mismatch !== "1") {
    const mismatch = checkCohortMismatch(body.class_id, body.cohort_id, null);
    if (mismatch) {
      const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY grade_order, name, parallel").all();
      const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
      const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
      const chassidut = db.prepare("SELECT id, name FROM chassidut ORDER BY name").all();
      const yeshivot = db.prepare("SELECT id, name FROM yeshivot ORDER BY name").all();
      const targetClass = classes.find((c) => String(c.id) === String(body.class_id));
      const className = targetClass ? targetClass.name + (targetClass.parallel ? " " + targetClass.parallel : "") : "";
      return res.render("students/form", {
        student: body, mode: "new", classes, cohorts, families, chassidut, yeshivot,
        cohortMismatchWarning: `התלמיד שובץ ל${className}, אך השנתון שנבחר לא תואם לשנתון של שאר תלמידי הכיתה (רוב תלמידי הכיתה משויכים לשנתון "${mismatch.cohort_name}"). לשבץ בכל זאת?`,
      });
    }
  }

  // יצירת משפחה חדשה אם המשתמש בחר "משפחה חדשה"
  if (body.family_mode === "new") {
    const famFields = [
      "last_name","sector","father_name","father_id_number","father_email",
      "mother_name","mother_id_number","mother_email",
      "home_phone","father_mobile","mother_mobile",
      "father_workplace","father_work_phone","mother_workplace","mother_work_phone",
      "street","house_number","apartment","city","zip_code","notes",
      "paternal_grandparents","paternal_grandparents_address",
      "maternal_grandparents","maternal_grandparents_address"
    ];
    const famCols = famFields.filter(f => body["fam_"+f] !== undefined && body["fam_"+f] !== "");
    const famVals = famCols.map(f => body["fam_"+f]);
    // ברירת מחדל: חברת גביה "קשר" (החברה הראשית) לכל משפחה חדשה, אלא אם
    // צוין אחרת - כך שלא נשארות משפחות בלי חברת גביה מוגדרת (גם לשכ"ל וגם לתרומות)
    if (!famCols.includes("billing_company")) {
      famCols.push("billing_company");
      famVals.push("קשר");
    }
    if (!famCols.includes("donation_billing_company")) {
      famCols.push("donation_billing_company");
      famVals.push("קשר");
    }
    if (famCols.length > 0) {
      const famInfo = db.prepare(
        `INSERT INTO families (${famCols.join(",")}) VALUES (${famCols.map(()=>"?").join(",")})`
      ).run(...famVals);
      body.family_id = famInfo.lastInsertRowid;
    }
  }

  // שיבוץ אוטומטי לפי אזור מגורים - קובע תמיד את שדה הסניף הישיר על התלמיד,
  // גם אם לא נבחרה כיתה בכלל וגם אם עדיין אין כיתת "עדיין לא נכנסו" מתאימה
  // במערכת. אם כן נבחרה כיתת "עדיין לא נכנסו" (או שלא נבחרה כיתה כלל) ויש
  // כיתת יעד פעילה - משבצים אליה גם כבונוס, אבל זה לא תנאי לקביעת הסניף.
  if (!body.class_id || isWaitingClass(db, body.class_id)) {
    let street = body.fam_street, houseNumber = body.fam_house_number;
    if (body.family_mode !== "new" && body.family_id) {
      const fam = db.prepare("SELECT street, house_number FROM families WHERE id = ?").get(body.family_id);
      if (fam) { street = fam.street; houseNumber = fam.house_number; }
    }

    if (body.resolved_branch) {
      // חוזרים מהשלב של "בחירת סניף לרחוב לא מוכר" - שומרים את הרחוב לפעם הבאה
      const zone = body.resolved_branch === "סוקולוב" ? 1 : 3; // ברירת מחדל לאזור הראשון של הסניף שנבחר
      saveZoneOverride(db, street, zone, body.resolved_branch);
      body.branch = body.resolved_branch;
      const waitingClass = findWaitingClassForZone(db, zone);
      if (waitingClass) body.class_id = waitingClass.id;
    } else {
      const result = resolveZone(db, street, houseNumber);
      if (result) {
        body.branch = result.branch;
        const waitingClass = findWaitingClassForZone(db, result.zone);
        if (waitingClass) body.class_id = waitingClass.id;
      } else if (street && street.trim()) {
        // רחוב לא מוכר - עוצרים ושואלים לאיזה סניף לשבץ, לפני שממשיכים ליצור את התלמיד
        return res.render("students/resolve-branch", { formData: body, street });
      }
    }
  }

  // אזהרה (לא חסימה) אם הסניף שנקבע סותר את הסניף של אח/אחות פעילים -
  // כדי לא "לפצל" משפחה בין סניפים בטעות. אפשר לאשר ולהמשיך בכל זאת.
  if (body.branch && body.family_id && !body.confirm_sibling_mismatch) {
    const conflict = findSiblingBranchConflict(db, body.family_id, body.branch);
    if (conflict) {
      const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY grade_order, name, parallel").all();
      const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
      const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
      const chassidut = db.prepare("SELECT id, name FROM chassidut ORDER BY name").all();
      const yeshivot = db.prepare("SELECT id, name FROM yeshivot ORDER BY name").all();
      return res.render("students/form", {
        student: body, mode: "new", classes, cohorts, families, chassidut, yeshivot,
        siblingBranchWarning: `האח/אחות ${conflict.first_name} ${conflict.last_name} (פעיל/ה) משובץ/ת לסניף "${conflict.branch}", אבל התלמיד/ה הזו עומדת להישבץ לסניף "${body.branch}". האם לשבץ בכל זאת?`,
      });
    }
  }

  const cols = STUDENT_FIELDS.filter((c) => c in body);
  const placeholders = cols.map(() => "?").join(",");
  const values = cols.map((c) => normalizeField(c, body[c]));
  const info = db.prepare(`INSERT INTO students (${cols.join(",")}) VALUES (${placeholders})`).run(...values);
  if (body.family_id && body.sector) {
    db.prepare("UPDATE families SET sector = ? WHERE id = ?").run(body.sector, body.family_id);
  }
  res.redirect(`/students/${info.lastInsertRowid}`);
});

// --- צפייה בכרטיס ---
router.get("/students/:id", (req, res) => {
  const student = withDates(db.prepare(STUDENT_SELECT + " WHERE s.id = ?").get(req.params.id));
  if (!student) return res.status(404).render("404");
  const contacts = getEmergencyContacts(student.family_id);
  const siblings = student.family_id
    ? db.prepare(`
        SELECT s.id, s.first_name, s.last_name, s.status,
               c.name AS class_name, c.parallel
        FROM students s
        LEFT JOIN classes c ON s.class_id = c.id
        WHERE s.family_id = ? AND s.id != ?
        ORDER BY (s.birth_date_civil IS NULL), s.birth_date_civil ASC
      `).all(student.family_id, student.id)
    : [];
  const studentFile = getStudentFile(student.id);
  const teachers = getClassTeachers(student.class_id);
  // הטופס הסרוק של השנה הנוכחית, אם נקלט
  const { getCurrentYear } = require("../yearManager");
  const scannedForm = db.prepare(
    "SELECT id FROM scanned_forms WHERE student_id = ? AND form_type = 'health' AND year = ?"
  ).get(student.id, getCurrentYear());

  res.render("students/view", {
    student, contacts, siblings, studentFile, teachers,
    scannedFormId: scannedForm ? scannedForm.id : null,
    back: req.query.back || "",
  });
});

// --- עריכה ---
router.get("/students/:id/edit", (req, res) => {
  const student = db.prepare(`
    SELECT s.*, f.sector AS family_sector FROM students s
    LEFT JOIN families f ON s.family_id = f.id WHERE s.id = ?
  `).get(req.params.id);
  if (!student) return res.status(404).render("404");
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY grade_order, name, parallel").all();
  const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
  const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
  res.render("students/form", {
    student: {
      ...student,
      sector: student.family_sector,
      birth_date_civil: hd.serialToInputDate(student.birth_date_civil),
      entry_date: hd.serialToInputDate(student.entry_date),
      exit_date: hd.serialToInputDate(student.exit_date),
      registration_date: hd.serialToInputDate(student.registration_date),
      admission_date: hd.serialToInputDate(student.admission_date),
    },
    mode: "edit", classes, cohorts, families, conflict: req.query.conflict === "1",
    back: req.query.back || "",
  });
});

router.put("/students/:id", (req, res) => {
  const body = req.body;
  if (!checkNoConflict("students", req.params.id, body.updated_at)) {
    return res.redirect(`/students/${req.params.id}/edit?conflict=1`);
  }

  if (body.id_number && body.id_number.trim()) {
    const dup = db.prepare(`
      SELECT s.id, s.first_name, s.last_name, f.last_name AS family_last_name
      FROM students s LEFT JOIN families f ON s.family_id = f.id
      WHERE s.id_number = ? AND s.id != ?
    `).get(body.id_number.trim(), req.params.id);
    if (dup) {
      const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY grade_order, name, parallel").all();
      const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
      const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
      return res.render("students/form", {
        student: { ...body, id: req.params.id }, mode: "edit", classes, cohorts, families,
        conflict: false,
        duplicateIdError: `מספר הזהות ${body.id_number.trim()} כבר קיים במערכת - עבור התלמיד/ה ${dup.first_name || ""} ${dup.last_name || dup.family_last_name || ""}. יש לוודא שזה לא אותו תלמיד לפני שממשיכים.`,
      });
    }
  }

  if (body.branch && body.family_id && !body.confirm_sibling_mismatch) {
    const conflict = findSiblingBranchConflict(db, body.family_id, body.branch, req.params.id);
    if (conflict) {
      const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY grade_order, name, parallel").all();
      const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
      const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
      return res.render("students/form", {
        student: { ...body, id: req.params.id }, mode: "edit", classes, cohorts, families,
        conflict: false,
        siblingBranchWarning: `האח/אחות ${conflict.first_name} ${conflict.last_name} (פעיל/ה) משובץ/ת לסניף "${conflict.branch}", אבל התלמיד/ה הזו עומדת להישבץ לסניף "${body.branch}". האם לשבץ בכל זאת?`,
      });
    }
  }

  // בדיקת התאמת שנתון לכיתה - אותה לוגיקה כמו ביצירת תלמיד חדש
  if (body.class_id && body.cohort_id && body.confirm_cohort_mismatch !== "1") {
    const mismatch = checkCohortMismatch(body.class_id, body.cohort_id, req.params.id);
    if (mismatch) {
      const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY grade_order, name, parallel").all();
      const cohorts = db.prepare("SELECT id, name FROM cohorts ORDER BY to_date DESC, from_date DESC").all();
      const families = db.prepare("SELECT id, last_name, father_name, sector FROM families ORDER BY last_name").all();
      const targetClass = classes.find((c) => String(c.id) === String(body.class_id));
      const className = targetClass ? targetClass.name + (targetClass.parallel ? " " + targetClass.parallel : "") : "";
      return res.render("students/form", {
        student: { ...body, id: req.params.id }, mode: "edit", classes, cohorts, families,
        conflict: false,
        cohortMismatchWarning: `התלמיד שובץ ל${className}, אך השנתון שנבחר לא תואם לשנתון של שאר תלמידי הכיתה (רוב תלמידי הכיתה משויכים לשנתון "${mismatch.cohort_name}"). לשבץ בכל זאת?`,
      });
    }
  }

  // יצירת משפחה חדשה אם המשתמש בחר "משפחה חדשה" - זמין גם בעריכה, לא רק
  // ביצירה, כדי שאפשר יהיה להוסיף הורים לתלמיד שכבר נשמר בלי משפחה
  if (body.family_mode === "new") {
    const famFields = [
      "last_name","sector","father_name","father_id_number","father_email",
      "mother_name","mother_id_number","mother_email",
      "home_phone","father_mobile","mother_mobile",
      "father_workplace","father_work_phone","mother_workplace","mother_work_phone",
      "street","house_number","apartment","city","zip_code","notes",
      "paternal_grandparents","paternal_grandparents_address",
      "maternal_grandparents","maternal_grandparents_address"
    ];
    const famCols = famFields.filter(f => body["fam_"+f] !== undefined && body["fam_"+f] !== "");
    const famVals = famCols.map(f => body["fam_"+f]);
    // ברירת מחדל: חברת גביה "קשר" (החברה הראשית) לכל משפחה חדשה, אלא אם
    // צוין אחרת - כך שלא נשארות משפחות בלי חברת גביה מוגדרת (גם לשכ"ל וגם לתרומות)
    if (!famCols.includes("billing_company")) {
      famCols.push("billing_company");
      famVals.push("קשר");
    }
    if (!famCols.includes("donation_billing_company")) {
      famCols.push("donation_billing_company");
      famVals.push("קשר");
    }
    if (famCols.length > 0) {
      const famInfo = db.prepare(
        `INSERT INTO families (${famCols.join(",")}) VALUES (${famCols.map(()=>"?").join(",")})`
      ).run(...famVals);
      body.family_id = famInfo.lastInsertRowid;
    }
  }

  const cols = STUDENT_FIELDS.filter((c) => c in body);
  const setClause = [...cols.map((c) => `${c} = ?`), "updated_at = ?"].join(", ");
  const values = [...cols.map((c) => normalizeField(c, body[c])), new Date().toISOString()];
  values.push(req.params.id);
  db.prepare(`UPDATE students SET ${setClause} WHERE id = ?`).run(...values);
  if (body.family_id && body.sector) {
    db.prepare("UPDATE families SET sector = ? WHERE id = ?").run(body.sector, body.family_id);
  }
  // גוררים את הסינון קדימה, כך ש"חזרה לרשימה" תחזיר לרשימה המסוננת
  const back = body.back ? `?back=${encodeURIComponent(body.back)}` : "";
  res.redirect(`/students/${req.params.id}${back}`);
});

// --- מחיקה ---
router.delete("/students/:id", (req, res) => {
  db.prepare("DELETE FROM students WHERE id = ?").run(req.params.id);
  res.redirect("/students");
});

// --- מחיקה מרובה (סימון ווי ברשימה) ---
router.post("/students/bulk-delete", (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM students WHERE id IN (${placeholders})`).run(...ids);
  }
  res.redirect("/students");
});

// --- הוספת רשומה לתיק תלמיד ---
router.post("/students/:id/file", (req, res) => {
  const { notes, class_name_at_time, entry_date } = req.body;
  db.prepare(
    "INSERT INTO student_file (student_id, class_name_at_time, entry_date, notes) VALUES (?,?,?,?)"
  ).run(req.params.id, class_name_at_time || null, hd.gregorianStringToSerial(entry_date) || hd.todayAccessSerial(), notes);
  res.redirect(`/students/${req.params.id}`);
});

// --- הדפסת טופס בריאות ---
router.get("/students/:id/print/health", (req, res) => {
  const student = withDates(db.prepare(STUDENT_SELECT + " WHERE s.id = ?").get(req.params.id));
  if (!student) return res.status(404).render("404");
  res.render("students/print-health", { student });
});

// --- הדפסת אנשי קשר לשעת חירום ---
router.get("/students/:id/print/emergency", (req, res) => {
  const student = withDates(db.prepare(STUDENT_SELECT + " WHERE s.id = ?").get(req.params.id));
  if (!student) return res.status(404).render("404");
  const contacts = getEmergencyContacts(student.family_id);
  res.render("students/print-emergency", { student, contacts });
});

module.exports = router;
