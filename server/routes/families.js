const express = require("express");
const router = express.Router();
const db = require("../db");
const { calcFamilyTuition } = require("../tuitionCalc");
const { buildOrderBy } = require("../sortHelper");

router.get("/", (req, res) => {
  const { q, sector, branch } = req.query;
  const status = req.query.status !== undefined ? req.query.status : "פעיל";
  let sql = "SELECT DISTINCT f.* FROM families f WHERE 1=1";
  const params = [];
  if (q) {
    sql += " AND (f.last_name LIKE ? OR f.father_name LIKE ? OR f.home_phone LIKE ? OR f.father_mobile LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like);
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
  const families = db.prepare(sql).all(...params);
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
      SELECT s.*, c.name AS class_name FROM students s
      LEFT JOIN classes c ON s.class_id = c.id WHERE s.family_id = ?
      ORDER BY s.birth_date_civil
    `)
    .all(req.params.id);
  const contacts = db.prepare("SELECT * FROM emergency_contacts WHERE family_id = ?").all(req.params.id);
  const tuition = calcFamilyTuition(req.params.id);
  const eldest = db.prepare(`
    SELECT s.*, c.name AS class_name, c.parallel FROM students s
    LEFT JOIN classes c ON s.class_id = c.id
    WHERE s.family_id = ?
    ORDER BY (s.birth_date_civil IS NULL), s.birth_date_civil ASC
    LIMIT 1
  `).get(req.params.id);
  res.render("families/view", { family, students, contacts, tuition, eldest });
});

router.get("/:id/edit", (req, res) => {
  const family = db.prepare("SELECT * FROM families WHERE id = ?").get(req.params.id);
  if (!family) return res.status(404).render("404");
  res.render("families/form", { family });
});

const FAMILY_FIELDS = [
  "last_name", "sector", "father_name", "father_id_number", "father_email",
  "mother_name", "mother_id_number", "mother_email",
  "home_phone", "father_mobile", "mother_mobile", "father_workplace", "father_work_phone",
  "mother_workplace", "mother_work_phone", "street", "house_number", "apartment", "city", "zip_code",
  "notes",
];

router.put("/:id", (req, res) => {
  const body = req.body;
  const cols = FAMILY_FIELDS.filter((c) => c in body);
  const setClause = cols.map((c) => `${c} = ?`).join(", ");
  const values = cols.map((c) => (body[c] === "" ? null : body[c]));
  values.push(req.params.id);
  db.prepare(`UPDATE families SET ${setClause} WHERE id = ?`).run(...values);
  res.redirect(`/families/${req.params.id}`);
});

router.delete("/:id", (req, res) => {
  // מנתק תלמידים מהמשפחה (לא מוחק אותם) ומוחק אנשי קשר לשעת חירום של המשפחה
  db.prepare("UPDATE students SET family_id = NULL WHERE family_id = ?").run(req.params.id);
  db.prepare("DELETE FROM emergency_contacts WHERE family_id = ?").run(req.params.id);
  db.prepare("DELETE FROM families WHERE id = ?").run(req.params.id);
  res.redirect("/families");
});

module.exports = router;
