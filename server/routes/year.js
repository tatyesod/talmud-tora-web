const express = require("express");
const router = express.Router();
const yearManager = require("../yearManager");
const db = require("../db");

router.get("/", (req, res) => {
  const currentYear = yearManager.getCurrentYear();
  const snapshots = yearManager.listSnapshots();
  res.render("year/index", { currentYear, snapshots, result: null });
});

// ============ מפת המעברים ============
// מציגה לכל כיתה לאן היא עולה, ומאפשרת לשנות מקבילה לפני ההעלאה.
// עד היום החריגה נקבעה בשדה בתוך טופס הכיתה, כלומר צריך היה לפתוח כל
// כיתה בנפרד ואי אפשר היה לראות את התמונה כולה.
router.get("/transfers", (req, res) => {
  const { GRADE_ORDER } = require("../yearManager");
  const classes = db.prepare(`
    SELECT c.*, COUNT(s.id) AS student_count
    FROM classes c
    LEFT JOIN students s ON s.class_id = c.id AND s.status = 'פעיל'
    WHERE c.status = 'פעיל'
    GROUP BY c.id
    ORDER BY c.grade_order, c.name, c.parallel
  `).all();

  // חישוב היעד בפועל - אותה לוגיקה שההעלאה משתמשת בה
  const rows = classes.map((c) => {
    const isWaiting = c.class_kind === "waiting" ||
      (!c.class_kind && c.name && c.name.startsWith("עדיין לא נכנסו"));
    const target = (c.transfer_number !== null && c.transfer_number !== undefined &&
                    c.transfer_number !== "") ? c.transfer_number : c.parallel;

    let targetName = null, note = "";
    if (isWaiting) {
      targetName = "מכינה א'";
    } else {
      const idx = GRADE_ORDER.indexOf(c.name);
      if (idx === -1) { note = "כיתה שאינה בסדר הקידום — לא תזוז"; }
      else if (idx === GRADE_ORDER.length - 1) { note = "סיום — התלמידים יעברו לבוגרים"; }
      else targetName = GRADE_ORDER[idx + 1];
    }

    // האם כיתת היעד קיימת בפועל
    let targetExists = true, targetLabel = "";
    if (targetName) {
      targetLabel = targetName + " " + target;
      const found = db.prepare(`SELECT id FROM classes WHERE name = ? AND parallel = ?
        AND status = 'פעיל' AND COALESCE(class_kind,'regular') = 'regular' LIMIT 1`)
        .get(targetName, String(target));
      if (!found) {
        const fb = db.prepare(`SELECT parallel FROM classes WHERE name = ? AND status = 'פעיל'
          AND COALESCE(class_kind,'regular') = 'regular' ORDER BY parallel LIMIT 1`).get(targetName);
        targetExists = false;
        note = fb ? ("מקבילה " + target + " אינה קיימת — יעברו ל" + targetName + " " + fb.parallel)
                  : ("אין כיתת " + targetName + " פעילה — התלמידים לא יזוזו!");
      }
    }
    return {
      ...c, isWaiting, targetName, targetLabel, targetExists, note,
      customTransfer: c.transfer_number !== null && c.transfer_number !== undefined && c.transfer_number !== "",
    };
  });

  // המקבילות הקיימות, לבורר
  const parallels = [...new Set(classes.map((c) => String(c.parallel || "")).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "he", { numeric: true }));

  res.render("year/transfers", {
    rows, parallels,
    currentYear: require("../yearManager").getCurrentYear(),
    saved: req.query.saved ? parseInt(req.query.saved, 10) : null,
  });
});

router.post("/transfers", (req, res) => {
  let ids = req.body.class_id || [];
  let vals = req.body.transfer_number || [];
  if (!Array.isArray(ids)) ids = [ids];
  if (!Array.isArray(vals)) vals = [vals];

  const upd = db.prepare("UPDATE classes SET transfer_number = ? WHERE id = ?");
  let changed = 0;
  db.exec("BEGIN");
  try {
    ids.forEach((id, i) => {
      const raw = String(vals[i] || "").trim();
      // ריק = ברירת מחדל (אותה מקבילה). שומרים NULL ולא מחרוזת ריקה,
      // כדי שהבדיקה בהעלאת השנה תזהה זאת נכון.
      changed += upd.run(raw === "" ? null : raw, id).changes;
    });
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    console.error("שמירת מפת המעברים נכשלה:", e.message);
  }
  res.redirect("/year/transfers?saved=" + changed);
});

router.post("/promote", (req, res) => {
  const result = yearManager.promoteYear();
  const currentYear = yearManager.getCurrentYear();
  const snapshots = yearManager.listSnapshots();
  res.render("year/index", { currentYear, snapshots, result });
});

router.get("/snapshots/:id", (req, res) => {
  const snapshot = yearManager.getSnapshot(req.params.id);
  if (!snapshot) return res.status(404).render("404");
  res.render("year/snapshot", { snapshot });
});

module.exports = router;
