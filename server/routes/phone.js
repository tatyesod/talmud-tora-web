const express = require("express");
const router = express.Router();
const db = require("../db");

// נרמול מספר להשוואה: משאירים ספרות בלבד ומתעלמים מקידומת בינלאומית.
// 3CX מעביר מספר נכנס בפורמטים שונים - 03-6185020, 036185020, +97236185020 -
// ובמסד הוא שמור בפורמט שהמזכירות הקלידו. בלי נרמול, רוב השיחות לא יימצאו.
function normalize(n) {
  let d = String(n || "").replace(/\D/g, "");
  if (d.startsWith("972")) d = "0" + d.slice(3);
  return d;
}
// השוואה על שבע הספרות האחרונות: מכסה הבדלי קידומת ואפס מוביל
const tail = (n) => normalize(n).slice(-7);

// חיפוש בכל שדות הטלפון במערכת
function findByPhone(number) {
  const t = tail(number);
  if (t.length < 7) return [];
  const results = [];

  const families = db.prepare(`
    SELECT id, last_name, father_name, mother_name,
           home_phone, father_mobile, mother_mobile, mother_work_phone
    FROM families
  `).all();
  for (const f of families) {
    const fields = [
      ["טלפון בית", f.home_phone], ["נייד אב", f.father_mobile],
      ["נייד אם", f.mother_mobile], ["עבודת האם", f.mother_work_phone],
    ];
    for (const [label, val] of fields) {
      if (val && tail(val) === t) {
        results.push({
          kind: "family", id: f.id, matchedField: label,
          title: "משפחת " + (f.last_name || ""),
          subtitle: [f.father_name, f.mother_name].filter(Boolean).join(" ו"),
          url: "/families/" + f.id,
        });
        break;
      }
    }
  }

  const teachers = db.prepare(
    "SELECT id, first_name, last_name, mobile, home_phone FROM teachers"
  ).all();
  for (const t2 of teachers) {
    const hit = tail(t2.mobile) === t ? "נייד" : (tail(t2.home_phone) === t ? "טלפון בית" : null);
    if (hit) {
      results.push({
        kind: "teacher", id: t2.id, matchedField: hit,
        title: ((t2.first_name || "") + " " + (t2.last_name || "")).trim(),
        subtitle: "מלמד", url: "/teachers/" + t2.id,
      });
    }
  }

  return results;
}

// ============ שיחה נכנסת ============
// זהו היעד שמוגדר באפליקציית 3CX. היא פותחת אותו עם מספר המתקשר,
// והמסך מפנה ישירות לכרטיס המתאים - בלי שהמזכירה מחפשת.
router.get("/incoming", (req, res) => {
  // כשהפנייה מגיעה דרך סוג הקישור הייחודי, הפרמטר מכיל את הכתובת המלאה -
  // web+ttcall://0501234567 - ולא רק את המספר. מנקים את הקידומת.
  const raw = req.query.number || req.query.n || "";
  const number = String(raw).replace(/^web\+ttcall:\/*/i, "").trim();
  const matches = findByPhone(number);

  // התאמה אחת - ישר לכרטיס. זה המקרה הרווח, ואין טעם במסך ביניים.
  if (matches.length === 1) return res.redirect(matches[0].url + "?call=" + encodeURIComponent(number));

  // כמה התאמות (למשל אותו טלפון בית לשתי משפחות) או אף אחת - מסך בחירה
  res.render("phone/incoming", { number, matches });
});

// ============ בדיקת JSON ============
// לשימוש עתידי אם תוגדר אינטגרציית CRM מלאה ב-3CX, שמצפה ל-JSON.
router.get("/lookup.json", (req, res) => {
  const number = req.query.number || "";
  const matches = findByPhone(number);
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  res.json({
    number,
    count: matches.length,
    contacts: matches.map((m) => ({
      id: String(m.id),
      firstName: m.title,
      lastName: "",
      phone: number,
      url: base + m.url,
    })),
  });
});

module.exports = router;
