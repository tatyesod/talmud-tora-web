const express = require("express");
const router = express.Router();
const db = require("../db");
const hd = require("../hebrewDate");

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

// שיחה משלוחה פנימית. 3CX שולחת מספר קצר - למשל 203 - ולא מספר טלפון.
// לכיתה יש שדה שלוחה, ולכן אפשר לזהות מאיזה חדר התקשרו.
//
// מי המלמד: לפי שעת השיחה. לפני 14:00 מלמד הבוקר, אחריה אחה"צ.
// שני המלמדים מוצגים תמיד, עם סימון מי הצפוי - כי מלמד הבוקר עשוי
// להישאר אחרי הצהריים, ואז שם שגוי גרוע מהצגת שניהם.
const AFTERNOON_FROM_HOUR = 14;

function findByExtension(ext) {
  const clean = String(ext || "").replace(/\D/g, "");
  // מספר ארוך אינו שלוחה. הסף נמוך בכוונה: שלוחות הן 2-4 ספרות.
  if (!clean || clean.length > 4) return [];

  const all = db.prepare(`
    SELECT c.id, c.name, c.parallel, c.branch, c.extension
    FROM classes c
    WHERE c.status = 'פעיל' AND COALESCE(c.extension,'') <> ''
  `).all();
  // ההשוואה בצד ה-JS ולא ב-SQL: הקוד מנקה מהמספר הנכנס כל תו שאינו
  // ספרה, אבל ב-SQL ניקינו רווחים בלבד. שלוחה שנשמרה כ-"203-" או עם
  // תו כיווניות נסתר לא הייתה מתאימה לעולם.
  const cls = all.filter((c) => String(c.extension).replace(/\D/g, "") === clean);
  if (!cls.length) return [];

  // שעה מקומית בישראל, לא של השרת - Render רץ ב-UTC
  const hour = hd.israelHour ? hd.israelHour() : new Date().getHours();
  const expectedRole = hour >= AFTERNOON_FROM_HOUR ? 'אחה"צ' : "בוקר";

  return cls.map((c) => {
    const teachers = db.prepare(`
      SELECT t.first_name, t.last_name, tc.role,
             COALESCE(NULLIF(t.mobile,''), t.home_phone) AS mobile
      FROM teacher_classes tc
      JOIN teachers t ON tc.teacher_id = t.id
      WHERE tc.class_id = ?
      ORDER BY (tc.role = ?) DESC, tc.id
    `).all(c.id, expectedRole).map((t) => ({
      name: ("הרב " + (t.first_name || "") + " " + (t.last_name || "")).trim(),
      role: t.role || "",
      mobile: t.mobile || "",
      likely: t.role === expectedRole,
    }));

    const likely = teachers.find((t) => t.likely);
    return {
      kind: "class",
      id: c.id,
      matchedField: "שלוחה " + c.extension,
      title: (c.name + " " + (c.parallel || "")).trim(),
      subtitle: (c.branch ? c.branch + " · " : "") +
                (likely ? likely.name : (teachers[0] ? teachers[0].name : "אין מלמד משויך")),
      url: "/classes/" + c.id,
      teachers,
      expectedRole,
    };
  });
}

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
  // שלוחה פנימית קודמת: מספר קצר לעולם אינו טלפון, ולכן אין התנגשות.
  let matches = findByExtension(number);
  if (!matches.length) matches = findByPhone(number);

  // חלון קומפקטי תמיד, גם בהתאמה יחידה. קודם הפניתי ישירות לכרטיס
  // המלא, וזה השתלט על החלון שעובדים בו באמצע עבודה. עכשיו נפתח חלון
  // קטן שמראה מי מתקשר, וממנו נכנסים לכרטיס רק אם צריך.
  //
  // לכל התאמה מצורפים גם התלמידים, כי בשיחה מהורה זה המידע שמחפשים.
  for (const m of matches) {
    if (m.kind === "family") {
      m.students = db.prepare(`
        SELECT s.first_name, s.nickname, s.status, COALESCE(f.last_name, s.last_name) AS last_name,
               c.name AS class_name, c.parallel
        FROM students s
        LEFT JOIN families f ON s.family_id = f.id
        LEFT JOIN classes c ON s.class_id = c.id
        WHERE s.family_id = ? AND s.status <> 'ארכיון'
        ORDER BY s.status <> 'פעיל', c.grade_order, s.first_name`).all(m.id).map((s) => ({
          name: ((s.last_name || "") + " " + (s.nickname || s.first_name || "")).trim(),
          cls: s.class_name ? (s.class_name + " " + (s.parallel || "")).trim() : "",
          inactive: s.status !== "פעיל",
        }));
    }
  }

  res.render("phone/popup", { number, matches });
});

// ============ בדיקת JSON ============
// לשימוש עתידי אם תוגדר אינטגרציית CRM מלאה ב-3CX, שמצפה ל-JSON.
router.get("/lookup.json", (req, res) => {
  const number = req.query.number || "";
  // גם כאן שלוחה קודמת, כדי ששני המסלולים יתנהגו זהה
  let matches = findByExtension(number);
  if (!matches.length) matches = findByPhone(number);
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
