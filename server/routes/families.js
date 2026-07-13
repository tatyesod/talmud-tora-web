const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");
const { calcFamilyTuition } = require("../tuitionCalc");
const { buildOrderBy } = require("../sortHelper");
const { checkNoConflict } = require("../concurrency");

// ============ תרומות - סכום חודשי שכל משפחה אמורה לתרום ============
router.get("/donations", (req, res) => {
  const { q } = req.query;
  let sql = `
    SELECT f.id, f.last_name, f.father_name, f.mother_name, f.monthly_donation_amount
    FROM families f
    WHERE EXISTS (SELECT 1 FROM students s WHERE s.family_id = f.id AND s.status NOT IN ('ארכיון', 'לא התקבל'))
  `;
  const params = [];
  if (q) {
    sql += " AND (f.last_name LIKE ? OR f.father_name LIKE ? OR f.mother_name LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += " ORDER BY f.last_name";
  const families = db.prepare(sql).all(...params);
  const totalMonthly = families.reduce((sum, f) => sum + (f.monthly_donation_amount || 0), 0);
  res.render("families/donations", { families, q: q || "", totalMonthly, saved: req.query.saved === "1" });
});

router.post("/donations/save", (req, res) => {
  let ids = req.body.family_id || [];
  let amounts = req.body.monthly_donation_amount || [];
  if (!Array.isArray(ids)) ids = [ids];
  if (!Array.isArray(amounts)) amounts = [amounts];
  const update = db.prepare("UPDATE families SET monthly_donation_amount = ? WHERE id = ?");
  ids.forEach((id, i) => {
    const amt = parseFloat(amounts[i]);
    update.run(isNaN(amt) || amt === 0 ? null : amt, id);
  });
  res.redirect(`/families/donations?saved=1${req.body.q ? "&q=" + encodeURIComponent(req.body.q) : ""}`);
});

router.get("/", (req, res) => {
  const { q, sector, branch } = req.query;
  const status = req.query.status !== undefined ? req.query.status : "פעיל";
  let sql = "SELECT DISTINCT f.* FROM families f WHERE 1=1";
  const params = [];
  if (q) {
    sql += " AND (f.last_name LIKE ? OR f.father_name LIKE ? OR f.mother_name LIKE ? OR f.home_phone LIKE ? OR f.father_mobile LIKE ? OR f.mother_mobile LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  if (sector) {
    sql += " AND f.sector = ?";
    params.push(sector);
  }
  if (branch || status) {
    sql += " AND EXISTS (SELECT 1 FROM students s LEFT JOIN classes c ON s.class_id = c.id WHERE s.family_id = f.id";
    if (branch) {
      sql += " AND c.branch = ?";
      params.push(branch);
    }
    if (status) {
      sql += " AND s.status = ?";
      params.push(status);
    }
    sql += ")";
    // "לא פעיל" ו"ארכיון" צריכים להיות בלעדיים ל"פעיל" - משפחה שיש לה ילד פעיל
    // אחד (גם אם יש לה גם ילדים לא-פעילים/בארכיון) תסווג כ"פעיל" בלבד, כדי שהסטטוסים
    // לא יחפפו זה עם זה (זו הייתה הבעיה: משפחה עם ילד פעיל וילד לא-פעיל הופיעה בשניהם)
    if (status && status !== "פעיל") {
      sql += " AND NOT EXISTS (SELECT 1 FROM students s2 WHERE s2.family_id = f.id AND s2.status = 'פעיל')";
    }
  }
  sql += " " + buildOrderBy(
    req,
    {
      last_name: "f.last_name",
      sector: "f.sector",
      father_name: "f.father_name",
      mother_name: "f.mother_name",
      home_phone: "f.home_phone",
      city: "f.city",
    },
    "ORDER BY f.last_name"
  );
  const families = db.prepare(sql).all(...params).map((f) => ({
    ...f,
    tuitionTotal: calcFamilyTuition(f.id).netTotal,
  }));
  res.render("families/list", {
    families, q: q || "", sector: sector || "", branch: branch || "", status: status || "",
    sort: req.query.sort || "", dir: req.query.dir || "",
  });
});

router.get("/:id", (req, res) => {
  const family = db.prepare("SELECT * FROM families WHERE id = ?").get(req.params.id);
  if (!family) return res.status(404).render("404");
  const students = db
    .prepare(`
      SELECT s.*, c.name AS class_name, c.parallel AS class_parallel, COALESCE(c.branch, s.branch) AS branch, co.name AS cohort_name
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN cohorts co ON s.cohort_id = co.id
      WHERE s.family_id = ?
      ORDER BY (s.birth_date_civil IS NULL), s.birth_date_civil ASC
    `)
    .all(req.params.id)
    .map(s => ({
      ...s,
      birth_date_str: hd.serialToGregorianString(s.birth_date_civil),
      age: (() => {
        if (!s.birth_date_civil) return null;
        const epoch = new Date(1899, 11, 30);
        const date = new Date(epoch.getTime() + s.birth_date_civil * 86400000);
        const today = new Date();
        let age = today.getFullYear() - date.getFullYear();
        const m = today.getMonth() - date.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < date.getDate())) age--;
        return age;
      })()
    }));
  const contacts = db.prepare("SELECT * FROM emergency_contacts WHERE family_id = ?").all(req.params.id);
  const tuition = calcFamilyTuition(req.params.id);
  const eldest = db.prepare(`
    SELECT s.*, c.name AS class_name, c.parallel FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    WHERE s.family_id = ?
    ORDER BY (s.birth_date_civil IS NULL), s.birth_date_civil ASC
    LIMIT 1
  `).get(req.params.id);

  // ניווט חצים בין משפחות - לפי אותו סדר ברירת מחדל כמו ברשימת המשפחות (שם משפחה),
  // עם אפשרות לסנן לפי סטטוס תלמידים (כמו ברשימה הראשית) כדי שהניווט יעבור רק בין
  // משפחות שמתאימות לסטטוס שנבחר
  const statusFilter = req.query.status || "";
  let orderedIdsSql = "SELECT f.id FROM families f WHERE 1=1";
  const orderedIdsParams = [];
  if (statusFilter) {
    orderedIdsSql += " AND EXISTS (SELECT 1 FROM students s WHERE s.family_id = f.id AND s.status = ?)";
    orderedIdsParams.push(statusFilter);
    if (statusFilter !== "פעיל") {
      orderedIdsSql += " AND NOT EXISTS (SELECT 1 FROM students s2 WHERE s2.family_id = f.id AND s2.status = 'פעיל')";
    }
  }
  orderedIdsSql += " ORDER BY f.last_name, f.id";
  const orderedIds = db.prepare(orderedIdsSql).all(...orderedIdsParams).map((r) => r.id);
  const curIdx = orderedIds.findIndex((id) => String(id) === String(req.params.id));
  const currentMatchesFilter = !statusFilter || curIdx !== -1;
  const prevFamilyId = curIdx > 0 ? orderedIds[curIdx - 1] : null;
  const nextFamilyId = curIdx >= 0 && curIdx < orderedIds.length - 1 ? orderedIds[curIdx + 1] : null;

  res.render("families/view", { family, students, contacts, tuition, eldest, prevFamilyId, nextFamilyId, statusFilter, currentMatchesFilter });
});

router.get("/:id/edit", (req, res) => {
  const family = db.prepare("SELECT * FROM families WHERE id = ?").get(req.params.id);
  if (!family) return res.status(404).render("404");

  const orderedIds = db.prepare("SELECT id FROM families ORDER BY last_name, id").all().map((r) => r.id);
  const curIdx = orderedIds.findIndex((id) => String(id) === String(req.params.id));
  const prevFamilyId = curIdx > 0 ? orderedIds[curIdx - 1] : null;
  const nextFamilyId = curIdx >= 0 && curIdx < orderedIds.length - 1 ? orderedIds[curIdx + 1] : null;

  res.render("families/form", {
    family, conflict: req.query.conflict === "1", saved: req.query.saved === "1",
    prevFamilyId, nextFamilyId,
  });
});

const FAMILY_FIELDS = [
  "last_name", "sector", "father_name", "father_id_number", "father_email",
  "mother_name", "mother_id_number", "mother_email",
  "home_phone", "father_mobile", "mother_mobile", "father_workplace", "father_work_phone",
  "mother_workplace", "mother_work_phone", "street", "house_number", "apartment", "city", "zip_code",
  "notes", "billing_company",
];

router.put("/:id", (req, res) => {
  const body = req.body;
  if (!checkNoConflict("families", req.params.id, body.updated_at)) {
    return res.redirect(`/families/${req.params.id}/edit?conflict=1`);
  }
  // חברת גביה: אם נבחר "אחר" - לוקחים את הטקסט שהוקלד ידנית, אחרת את הבחירה עצמה
  if ("billing_company_choice" in body) {
    body.billing_company = body.billing_company_choice === "אחר"
      ? (body.billing_company_other || "").trim()
      : body.billing_company_choice;
  }
  const cols = FAMILY_FIELDS.filter((c) => c in body);
  const setClause = [...cols.map((c) => `${c} = ?`), "updated_at = ?"].join(", ");
  const values = [...cols.map((c) => (body[c] === "" ? null : body[c])), new Date().toISOString()];
  values.push(req.params.id);
  db.prepare(`UPDATE families SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect(`/families/${req.params.id}/edit?saved=1`);
});

// מוחק משפחה **וכל** הנתונים תחתיה: כל הילדים, הזמנות ספרים, תשלומים,
// תיק תלמיד, רישום לאירועים, פניות הורים, ואנשי קשר לשעת חירום.
// זו פעולה הרסנית ובלתי הפיכה בכוונה (לפי בקשת המשתמש) - שונה מהתנהגות
// קודמת שרק ניתקה את התלמידים מהמשפחה בלי למחוק אותם.
function deleteFamilyCascade(familyId) {
  const studentIds = db.prepare("SELECT id FROM students WHERE family_id = ?").all(familyId).map((s) => s.id);
  for (const sid of studentIds) {
    db.prepare("DELETE FROM student_file WHERE student_id = ?").run(sid);
    db.prepare("DELETE FROM book_orders WHERE student_id = ?").run(sid);
    db.prepare("DELETE FROM book_order_extras WHERE student_id = ?").run(sid);
    db.prepare("DELETE FROM event_registrations WHERE student_id = ?").run(sid);
  }
  db.prepare("DELETE FROM book_payments WHERE family_id = ?").run(familyId);
  db.prepare("DELETE FROM parent_requests WHERE family_id = ?").run(familyId);
  db.prepare("DELETE FROM emergency_contacts WHERE family_id = ?").run(familyId);
  db.prepare("DELETE FROM students WHERE family_id = ?").run(familyId);
  db.prepare("DELETE FROM families WHERE id = ?").run(familyId);
}

router.delete("/:id", (req, res) => {
  deleteFamilyCascade(req.params.id);
  res.redirect("/families");
});

// --- מחיקה מרובה (סימון ווי ברשימה) - אותה מחיקה מלאה כמו מחיקה בודדת ---
router.post("/bulk-delete", (req, res) => {
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map((v) => parseInt(v, 10)).filter((v) => !isNaN(v));
  for (const id of ids) {
    deleteFamilyCascade(id);
  }
  res.redirect("/families");
});

module.exports = router;
