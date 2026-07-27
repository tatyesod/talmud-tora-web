const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");

function withCriteria(campaign) {
  const criteria = db.prepare("SELECT * FROM campaign_criteria WHERE campaign_id = ? ORDER BY sort_order, id").all(campaign.id);
  const classes = db.prepare(`
    SELECT c.id, c.name, c.parallel, c.branch FROM campaign_classes cc
    JOIN classes c ON cc.class_id = c.id WHERE cc.campaign_id = ?
    ORDER BY c.branch, c.name, c.parallel
  `).all(campaign.id);
  const totalAwards = db.prepare("SELECT COUNT(*) c FROM campaign_awards WHERE campaign_id = ?").get(campaign.id).c;
  return { ...campaign, criteria, classes, totalAwards };
}

// ============ רשימת מבצעים ============
router.get("/", (req, res) => {
  const campaigns = db.prepare("SELECT * FROM campaigns ORDER BY status = 'הסתיים', created_at DESC").all().map(withCriteria);
  res.render("campaigns/list", { campaigns });
});

// ============ יצירת מבצע חדש ============
router.get("/new", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes WHERE status = 'פעיל' AND name NOT LIKE 'עדיין לא נכנסו%' ORDER BY branch, name, parallel").all();
  res.render("campaigns/form", { campaign: { criteria: [{ name: "", points: "" }] }, classes, selectedClassIds: [], mode: "new" });
});

router.post("/", (req, res) => {
  const { name, notes, conversion_rate } = req.body;
  if (!name || !name.trim()) return res.redirect("/campaigns/new");

  let classIds = req.body.class_ids || [];
  if (!Array.isArray(classIds)) classIds = [classIds];

  let critNames = req.body.criterion_name || [];
  let critPoints = req.body.criterion_points || [];
  if (!Array.isArray(critNames)) critNames = [critNames];
  if (!Array.isArray(critPoints)) critPoints = [critPoints];

  db.exec("BEGIN TRANSACTION");
  try {
    const info = db.prepare("INSERT INTO campaigns (name, notes, conversion_rate, status, created_at) VALUES (?,?,?,?,?)").run(
      name.trim(), notes || null, conversion_rate ? parseFloat(conversion_rate) : null, "פעיל", new Date().toISOString()
    );
    const campaignId = info.lastInsertRowid;

    const insertClass = db.prepare("INSERT OR IGNORE INTO campaign_classes (campaign_id, class_id) VALUES (?,?)");
    classIds.forEach((cid) => insertClass.run(campaignId, cid));

    const insertCrit = db.prepare("INSERT INTO campaign_criteria (campaign_id, name, points, sort_order) VALUES (?,?,?,?)");
    critNames.forEach((cname, i) => {
      if (cname && cname.trim()) insertCrit.run(campaignId, cname.trim(), parseFloat(critPoints[i]) || 0, i);
    });

    db.exec("COMMIT");
    res.redirect(`/campaigns/${campaignId}`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
});

// ============ עריכת מבצע ============
router.get("/:id/edit", (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id);
  if (!campaign) return res.status(404).render("404");
  const enriched = withCriteria(campaign);
  const classes = db.prepare("SELECT id, name, parallel, branch FROM classes WHERE status = 'פעיל' AND name NOT LIKE 'עדיין לא נכנסו%' ORDER BY branch, name, parallel").all();
  res.render("campaigns/form", {
    campaign: { ...campaign, criteria: enriched.criteria.length ? enriched.criteria : [{ name: "", points: "" }] },
    classes, selectedClassIds: enriched.classes.map((c) => c.id), mode: "edit",
  });
});

router.put("/:id", (req, res) => {
  const { name, notes, conversion_rate, status } = req.body;
  if (!name || !name.trim()) return res.redirect(`/campaigns/${req.params.id}/edit`);

  let classIds = req.body.class_ids || [];
  if (!Array.isArray(classIds)) classIds = [classIds];
  let critIds = req.body.criterion_id || [];
  let critNames = req.body.criterion_name || [];
  let critPoints = req.body.criterion_points || [];
  if (!Array.isArray(critIds)) critIds = [critIds];
  if (!Array.isArray(critNames)) critNames = [critNames];
  if (!Array.isArray(critPoints)) critPoints = [critPoints];

  db.exec("BEGIN TRANSACTION");
  try {
    db.prepare("UPDATE campaigns SET name=?, notes=?, conversion_rate=?, status=? WHERE id=?").run(
      name.trim(), notes || null, conversion_rate ? parseFloat(conversion_rate) : null, status || "פעיל", req.params.id
    );

    db.prepare("DELETE FROM campaign_classes WHERE campaign_id = ?").run(req.params.id);
    const insertClass = db.prepare("INSERT OR IGNORE INTO campaign_classes (campaign_id, class_id) VALUES (?,?)");
    classIds.forEach((cid) => insertClass.run(req.params.id, cid));

    // קריטריונים קיימים (עם id) מתעדכנים, חדשים (בלי id, id="new") נוספים -
    // לא מוחקים קריטריונים קיימים שיש עליהם כבר כרטיסים, כדי לא לאבד היסטוריה
    const updateCrit = db.prepare("UPDATE campaign_criteria SET name=?, points=?, sort_order=? WHERE id=? AND campaign_id=?");
    const insertCrit = db.prepare("INSERT INTO campaign_criteria (campaign_id, name, points, sort_order) VALUES (?,?,?,?)");
    critNames.forEach((cname, i) => {
      if (!cname || !cname.trim()) return;
      const points = parseFloat(critPoints[i]) || 0;
      const id = critIds[i];
      if (id && id !== "new") {
        updateCrit.run(cname.trim(), points, i, id, req.params.id);
      } else {
        insertCrit.run(req.params.id, cname.trim(), points, i);
      }
    });

    db.exec("COMMIT");
    res.redirect(`/campaigns/${req.params.id}`);
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
});

router.delete("/:id", (req, res) => {
  db.exec("BEGIN TRANSACTION");
  try {
    db.prepare("DELETE FROM campaign_awards WHERE campaign_id = ?").run(req.params.id);
    db.prepare("DELETE FROM campaign_criteria WHERE campaign_id = ?").run(req.params.id);
    db.prepare("DELETE FROM campaign_classes WHERE campaign_id = ?").run(req.params.id);
    db.prepare("DELETE FROM campaigns WHERE id = ?").run(req.params.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  res.redirect("/campaigns");
});

// ============ עמוד מבצע - הענקת כרטיסים לתלמידים ============
router.get("/:id", (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id);
  if (!campaign) return res.status(404).render("404");
  const enriched = withCriteria(campaign);

  const classId = req.query.class_id || (enriched.classes[0] && enriched.classes[0].id);
  const students = classId
    ? db.prepare("SELECT id, first_name, last_name FROM students WHERE class_id = ? AND status = 'פעיל' ORDER BY last_name, first_name").all(classId)
    : [];

  const awards = db.prepare(`
    SELECT student_id, criterion_id, COUNT(*) AS cnt FROM campaign_awards
    WHERE campaign_id = ? GROUP BY student_id, criterion_id
  `).all(req.params.id);
  const awardMap = {};
  awards.forEach((a) => { awardMap[`${a.student_id}_${a.criterion_id}`] = a.cnt; });

  const studentRows = students.map((s) => {
    const counts = enriched.criteria.map((c) => awardMap[`${s.id}_${c.id}`] || 0);
    const totalPoints = counts.reduce((sum, cnt, i) => sum + cnt * enriched.criteria[i].points, 0);
    return { ...s, counts, totalPoints };
  });

  res.render("campaigns/detail", { campaign: enriched, classId: classId ? String(classId) : "", students: studentRows, saved: req.query.saved === "1" });
});

router.post("/:id/set-counts", (req, res) => {
  const { class_id } = req.body;
  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const insert = db.prepare("INSERT INTO campaign_awards (campaign_id, criterion_id, student_id, awarded_date, created_at) VALUES (?,?,?,?,?)");
  const del = db.prepare("DELETE FROM campaign_awards WHERE id = ?");
  const selectExisting = db.prepare("SELECT id FROM campaign_awards WHERE campaign_id=? AND student_id=? AND criterion_id=? ORDER BY id");

  // כל שדות count_<student_id>_<criterion_id> בטופס - שומר את כל הטבלה
  // בבת אחת, בלי צורך לשמור כל תא בנפרד
  db.exec("BEGIN TRANSACTION");
  try {
    Object.keys(req.body).forEach((key) => {
      const m = key.match(/^count_(\d+)_(\d+)$/);
      if (!m) return;
      const [, studentId, criterionId] = m;
      const target = Math.max(0, parseInt(req.body[key], 10) || 0);
      const existing = selectExisting.all(req.params.id, studentId, criterionId);
      if (existing.length < target) {
        const toAdd = target - existing.length;
        for (let i = 0; i < toAdd; i++) insert.run(req.params.id, criterionId, studentId, today, nowIso);
      } else if (existing.length > target) {
        existing.slice(0, existing.length - target).forEach((row) => del.run(row.id));
      }
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  res.redirect(`/campaigns/${req.params.id}?class_id=${encodeURIComponent(class_id || "")}&saved=1`);
});

router.post("/:id/award", (req, res) => {
  const { student_id, criterion_id, class_id } = req.body;
  if (student_id && criterion_id) {
    db.prepare("INSERT INTO campaign_awards (campaign_id, criterion_id, student_id, awarded_date, created_at) VALUES (?,?,?,?,?)").run(
      req.params.id, criterion_id, student_id, new Date().toISOString().slice(0, 10), new Date().toISOString()
    );
  }
  res.redirect(`/campaigns/${req.params.id}?class_id=${encodeURIComponent(class_id || "")}&saved=1`);
});

router.post("/:id/unaward", (req, res) => {
  const { student_id, criterion_id, class_id } = req.body;
  const last = db.prepare(
    "SELECT id FROM campaign_awards WHERE campaign_id=? AND student_id=? AND criterion_id=? ORDER BY id DESC LIMIT 1"
  ).get(req.params.id, student_id, criterion_id);
  if (last) db.prepare("DELETE FROM campaign_awards WHERE id = ?").run(last.id);
  res.redirect(`/campaigns/${req.params.id}?class_id=${encodeURIComponent(class_id || "")}&saved=1`);
});

// ============ דוח מבצע - סיכום כיתתי, המרה לכסף ============
router.get("/:id/report", (req, res) => {
  const campaign = db.prepare("SELECT * FROM campaigns WHERE id = ?").get(req.params.id);
  if (!campaign) return res.status(404).render("404");
  const enriched = withCriteria(campaign);

  const classSections = enriched.classes.map((cls) => {
    const students = db.prepare("SELECT id, first_name, last_name FROM students WHERE class_id = ? AND status = 'פעיל' ORDER BY last_name, first_name").all(cls.id);
    const awards = db.prepare(`
      SELECT student_id, criterion_id, COUNT(*) AS cnt FROM campaign_awards
      WHERE campaign_id = ? AND student_id IN (${students.map(() => "?").join(",") || "0"})
      GROUP BY student_id, criterion_id
    `).all(req.params.id, ...students.map((s) => s.id));
    const awardMap = {};
    awards.forEach((a) => { awardMap[`${a.student_id}_${a.criterion_id}`] = a.cnt; });

    const rows = students.map((s) => {
      const counts = enriched.criteria.map((c) => awardMap[`${s.id}_${c.id}`] || 0);
      const cardCount = counts.reduce((sum, c) => sum + c, 0);
      const totalPoints = counts.reduce((sum, cnt, i) => sum + cnt * enriched.criteria[i].points, 0);
      const money = campaign.conversion_rate ? Math.round(totalPoints * campaign.conversion_rate * 100) / 100 : null;
      return { name: `${s.last_name || ""} ${s.first_name || ""}`.trim(), cardCount, totalPoints, money };
    }).sort((a, b) => b.totalPoints - a.totalPoints);

    return { className: cls.name + (cls.parallel ? " " + cls.parallel : ""), rows };
  });

  res.render("campaigns/report", { campaign, classSections });
});

router.post("/:id/conversion-rate", (req, res) => {
  const { conversion_rate } = req.body;
  db.prepare("UPDATE campaigns SET conversion_rate = ? WHERE id = ?").run(conversion_rate ? parseFloat(conversion_rate) : null, req.params.id);
  res.redirect(`/campaigns/${req.params.id}/report`);
});

module.exports = router;
