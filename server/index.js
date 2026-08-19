// אזור הזמן של כל התהליך - חייב להיות לפני כל require, כדי שכל מודול שנטען
// אחריו כבר יראה את השעון הנכון.
// ב-Render השרת רץ ב-UTC כברירת מחדל, ולכן כל new Date().getHours()/getDate(),
// כל toLocaleDateString וכל תזמון לפי שעה היו מוסטים בשעתיים-שלוש - מה שגרם,
// בין השאר, לשם יום ולתאריך עברי שגויים בין חצות ל-03:00 שעון ישראל.
// אפשר להגדיר TZ=Asia/Jerusalem גם כמשתנה סביבה בלוח הבקרה של Render;
// השורה כאן מבטיחה את אותה התנהגות גם בלעדיו ובהרצה מקומית.
process.env.TZ = "Asia/Jerusalem";

const express = require("express");
const path = require("path");
const methodOverride = require("method-override");
const session = require("express-session");
const hd = require("./hebrewDate");

const app = express();
const PORT = process.env.PORT || 3000;

// גרסת נכסים (CSS/JS) - מחושבת פעם אחת בהפעלת השרת, כך שכל פריסה חדשה (Render)
// מכריחה את הדפדפן למשוך קבצי עיצוב/סקריפט טריים במקום גרסה שמורה בקאש.
// ===== שער הרשאות לפי תפקיד =====
// רשימה לבנה ולא שחורה: כל נתיב שאינו ברשימה חסום. כך פיצ'ר שייבנה בעתיד
// חסום אוטומטית לתפקידים המוגבלים, ולא נגלה יום אחד שמישהו רואה נתונים
// שלא נועדו לו. deny נבדק לפני allow, לחסימת תת-נתיב בתוך מודול מותר.
const ROLE_RULES = {
  // תחזוקן חיצוני - מסך בקשות התחזוקה בלבד
  maintenance: {
    allow: ["/inventory/maintenance", "/logout"],
    deny: ["/inventory/maintenance/media"],   // ניהול נפח הדיסק הוא של המשרד
    home: "/inventory/maintenance",
  },
  // רכזת שילוב - כל הצד הפדגוגי, בלי כספים ובלי ניהול מערכת
  pedagogic: {
    allow: [
      "/",                    // דף הבית
      "/students",            // תלמידים - כולל עריכה
      "/classes",             // כיתות ומחזורים
      "/families",            // משפחות והורים
      "/reports",             // דוחות
      // נדרשים לתפעול ולא מופיעים ככרטיס: הודעות, משימות, נוכחות, קבצים
      "/messages", "/tasks", "/presence", "/uploads",
      "/users/profile",       // הפרופיל שלה בלבד
      "/logout",
    ],
    // כרטיסי דף הבית. רשימה נפרדת מ-allow בכוונה: היא רשאית לערוך תלמידים,
    // אבל "רישום תלמיד חדש" ו"חומרי לימוד" הם תת-נתיבים של מודולים מותרים
    // ולכן היו מופיעים ככרטיס. כאן נקבע מה מוצג, ושם מה מותר.
    cards: ["/families", "/classes", "/students", "/reports"],
    // תת-נתיבים כספיים שיושבים בתוך מודולים מותרים
    deny: [
      "/families/donations",
      "/families/import-external/donations",
      "/reports/tuition-by-billing-company",
    ],
    home: "/",
  },
};

const ASSET_VERSION = Date.now();
app.use((req, res, next) => {
  res.locals.assetVersion = ASSET_VERSION;
  next();
});

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
const UPLOADS_DIR = process.env.RENDER_PERSISTENT_DIR
  ? path.join(process.env.RENDER_PERSISTENT_DIR, "uploads")
  : path.join(__dirname, "uploads");
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "talmud-tora-secret-change-me",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    // בלי maxAge/expires העוגייה היא "עוגיית סשן" - הדפדפן מוחק אותה בסגירה,
    // ולכן סגירה ב-X מנתקת באמת. קודם הייתה כאן עוגייה מתמשכת של 20 דקות,
    // ששרדה סגירה ופתיחה מחדש. מגבלת חוסר הפעילות נאכפת עכשיו בשרת (למטה),
    // כך שלא איבדנו אותה.
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);

// ניתוק אחרי חוסר פעילות. קודם זה נשען על תפוגת העוגייה; מרגע שהעוגייה היא
// עוגיית סשן אין לה תפוגה משלה, ולכן הבדיקה נעשית כאן מול חותמת זמן בסשן.
const IDLE_LIMIT_MS = 1000 * 60 * 20; // 20 דקות
// לתחזוקן הטאבלט יושב במשרד ומוצג לאורך היום, ולכן ניתוק כל 20 דקות היה
// מקבל אותו במסך התחברות בכל פעם. התפקיד שלו מקבל חלון ארוך במקום.
const IDLE_LIMIT_MAINTENANCE_MS = 1000 * 60 * 60 * 12; // 12 שעות
app.use((req, res, next) => {
  if (!req.session.userId) return next();
  const now = Date.now();
  const limit = req.session.userRole === "maintenance" ? IDLE_LIMIT_MAINTENANCE_MS : IDLE_LIMIT_MS;
  if (req.session.lastSeen && now - req.session.lastSeen > limit) {
    return req.session.destroy(() => res.redirect("/login"));
  }
  req.session.lastSeen = now;
  next();
});

// --- אימות מבוסס מסד נתונים, ריבוי משתמשים ---
app.use((req, res, next) => {
  if (req.session.userId) {
    const db = require("./db");
    const u = db.prepare("SELECT id, username, display_name, full_name, role_title, is_admin, force_password_change, drive_letter, nav_order, role FROM users WHERE id = ?").get(req.session.userId);
    if (u) {
      req.currentUser = u;
      res.locals.user = u.display_name || u.username;
      res.locals.currentUserId = u.id;
      res.locals.currentUserFullName = u.full_name || u.display_name || u.username;
      res.locals.isAdmin = !!u.is_admin;
      res.locals.userRole = u.role || "";
      res.locals.isMaintenanceUser = u.role === "maintenance";
      db.prepare(
        "INSERT INTO user_presence (user_id, last_seen) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen"
      ).run(u.id, new Date().toISOString());
    } else {
      res.locals.user = null;
      res.locals.currentUserId = null;
      res.locals.isAdmin = false;
    }
  } else {
    res.locals.user = null;
    res.locals.currentUserId = null;
    res.locals.isAdmin = false;
  }
  res.locals.sortUrl = (col) => {
    const params = new URLSearchParams(req.query);
    const curSort = req.query.sort;
    const curDir = req.query.dir || "asc";
    const dir = curSort === col && curDir === "asc" ? "desc" : "asc";
    params.set("sort", col);
    params.set("dir", dir);
    return "?" + params.toString();
  };
  res.locals.sortIndicator = (col) => {
    if (req.query.sort !== col) return "";
    return req.query.dir === "desc" ? " ▼" : " ▲";
  };
  res.locals.phoneLink = (number) => {
    if (!number) return "";
    const clean = String(number).trim();
    if (!clean) return "";
    return `<a href="tel:${clean}" class="phone-link" data-phone="${clean}">${clean}</a>`;
  };
  res.locals.emailLink = (email) => {
    if (!email) return "";
    const clean = String(email).trim();
    if (!clean) return "";
    const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(clean)}`;
    return `<a href="${gmailUrl}" target="_blank" class="email-link">${clean}</a>`;
  };
  // תאריך היום בעברית - זמין בכל תבנית EJS, כדי שכל מכתב/דוח/מסמך שמציג
  // "היום" יציג תאריך עברי במקום לועזי (המגזר משתמש בתאריכים עבריים בלבד)
  res.locals.todayHebrewStr = hd.serialToHebrewString(hd.todayAccessSerial());
  res.locals.toHebDate = hd.anyDateToHebrewString;
  res.locals.linkify = (text) => {
    if (!text) return "";
    const collapsed = String(text).replace(/\n{3,}/g, "\n\n");
    const escapeHtml = (s) => String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const urlPattern = /((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
    return collapsed.split(urlPattern).map((part, i) => {
      if (i % 2 === 1) {
        // חלק זוגי-אי הוא כתובת אתר שנתפסה ע"י ה-regex
        let href = part.replace(/[.,;:!?)\]]+$/, ""); // מסיר סימני פיסוק שדבוקים בסוף
        const trailing = part.slice(href.length);
        if (!/^https?:\/\//i.test(href)) href = "https://" + href;
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(part.slice(0, part.length - trailing.length))}</a>${escapeHtml(trailing)}`;
      }
      return escapeHtml(part);
    }).join("").replace(/\n/g, "<br>");
  };
  next();
});

function requireLogin(req, res, next) {
  // דלג על נתיבי proxy ציבוריים, וגם על פיד היומן (מוגן בטוקן סודי בכתובת
  // עצמה, לא בהתחברות - כי שרתי גוגל קלנדר לא יכולים "להתחבר" למערכת)
  if (req.path.startsWith("/api/proxy") || req.path.startsWith("/api/jewish-calendar") || req.path.startsWith("/events/feed/")) return next();
  if (req.session.userId) return next();
  return res.redirect("/login");
}

function requireAdmin(req, res, next) {
  if (req.currentUser && req.currentUser.is_admin) return next();
  return res.status(403).render("403");
}

// הגשת קבצים מצורפים (/uploads) - רק אחרי אימות משתמש, כדי שאי אפשר יהיה לגשת
// לקבצים ישירות דרך כתובת בלי להתחבר. "תיק עובד" (חוזי העסקה וכד') מוגן במיוחד -
// מנהלים בלבד, גם אם המשתמש מחובר, כי זה חומר אישי רגיש.
app.use("/uploads/teachers", (req, res, next) => {
  if (req.currentUser && req.currentUser.is_admin) return next();
  return res.status(403).send("אין הרשאה לצפות בקובץ זה - תיק עובד זמין למנהלים בלבד");
});
app.use("/uploads", (req, res, next) => {
  if (req.currentUser) return next();
  return res.redirect("/login");
});
app.use("/uploads", express.static(UPLOADS_DIR));

// אם המשתמש חייב לשנות סיסמה — מנתב לעמוד שינוי סיסמה בלבד
function checkForcePasswordChange(req, res, next) {
  // התחזוקן אינו מנהל את הסיסמה שלו - המשרד קובע אותה דרך מסך המשתמשים.
  // הפטור כאן קריטי: בלעדיו הוא נשלח לעמוד שינוי סיסמה, השער חוסם אותו
  // ומחזיר למסך שלו, ונוצר לופ שמונע ממנו להיכנס בכלל.
  if (req.currentUser && req.currentUser.role === "maintenance") return next();
  if (
    req.currentUser &&
    req.currentUser.force_password_change &&
    req.path !== "/force-change-password" &&
    req.path !== "/logout"
  ) {
    return res.redirect("/force-change-password");
  }
  next();
}

app.get("/force-change-password", requireLogin, (req, res) => {
  res.render("force-change-password", { error: null });
});

app.post("/force-change-password", requireLogin, (req, res) => {
  const { password, password2 } = req.body;
  const db = require("./db");
  const { hashPassword } = require("./auth");
  if (!password || password.length < 6) {
    return res.render("force-change-password", { error: "הסיסמה חייבת להכיל לפחות 6 תווים" });
  }
  if (password !== password2) {
    return res.render("force-change-password", { error: "הסיסמאות אינן תואמות" });
  }
  db.prepare("UPDATE users SET password_hash = ?, force_password_change = 0 WHERE id = ?").run(
    hashPassword(password), req.currentUser.id
  );
  res.redirect((ROLE_RULES[req.currentUser.role] && ROLE_RULES[req.currentUser.role].home) || "/");
});

app.get("/login", (req, res) => {
  res.render("login", { error: null });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const db = require("./db");
  const { verifyPassword } = require("./auth");
  const u = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (u && verifyPassword(password, u.password_hash)) {
    req.session.userId = u.id;
    // התפקיד נשמר בסשן כי בדיקת חוסר הפעילות רצה לפני שליפת המשתמש מהמסד,
    // ובלעדיו הפטור של התחזוקן לא היה נכנס לתוקף לעולם.
    req.session.userRole = u.role || "";
    // התחזוקן נשלח ישר למסך היחיד שלו, כדי שהטאבלט ייפתח על מה שהוא צריך
    return res.redirect((ROLE_RULES[u.role] && ROLE_RULES[u.role].home) || "/");
  }
  res.render("login", { error: "שם משתמש או סיסמה שגויים" });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// תמיכה בניתוק אוטומטי מ-JS (POST)
app.get("/logout-get", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

// נתיבי proxy ציבוריים — לא דורשים התחברות
app.use("/api/proxy", (req, res, next) => next());
app.use("/api/jewish-calendar", (req, res, next) => next());

app.use(requireLogin);

// canAccess זמינה בכל התצוגות: התפריט וכרטיסי דף הבית מסתירים לפיה פריטים,
// והיא נגזרת מאותה ROLE_RULES של השער עצמו. כך אי אפשר שהתפריט יציג משהו
// שהשער חוסם, או שיסתיר משהו שמותר - שניהם נגזרים ממקור אחד.
function pathAllowedForRole(role, p) {
  const rules = ROLE_RULES[role];
  if (!rules) return true;                 // מנהל ומזכירים - הכל
  const matches = (list) =>
    (list || []).some((base) =>
      base === "/" ? p === "/" : (p === base || p.startsWith(base + "/"))
    );
  if (matches(rules.deny)) return false;
  return matches(rules.allow);
}

app.use((req, res, next) => {
  const role = req.currentUser && req.currentUser.role;
  res.locals.canAccess = (p) => pathAllowedForRole(role, p);
  // showCard נפרדת מ-canAccess: תפקיד יכול להיות רשאי לנתיב בלי שהוא יופיע
  // ככרטיס בדף הבית. בלי רשימת cards מוצג כל מה שמותר.
  res.locals.showCard = (p) => {
    const rules = ROLE_RULES[role];
    if (!rules) return true;
    if (!rules.cards) return pathAllowedForRole(role, p);
    return rules.cards.includes(p);
  };
  next();
});

app.use((req, res, next) => {
  const rules = req.currentUser && ROLE_RULES[req.currentUser.role];
  if (!rules) return next();

  // התאמה מדויקת או תת-נתיב.
  // "/" מטופל כהתאמה מדויקת בלבד: אחרת base.replace הופך אותו למחרוזת ריקה,
  // כל נתיב "מתחיל" בו, והשער כולו מתבטל בשקט. זה נתפס בבדיקה.
  const matches = (list) =>
    (list || []).some((base) =>
      base === "/" ? req.path === "/" : (req.path === base || req.path.startsWith(base + "/"))
    );

  if (matches(rules.deny || [])) return res.redirect(rules.home);
  if (matches(rules.allow)) return next();
  return res.redirect(rules.home);
});

app.use(checkForcePasswordChange);

app.get("/", (req, res) => {
  const db = require("./db");
  const yearManager = require("./yearManager");
  const { calcAllFamiliesTuition } = require("./tuitionCalc");
  const stats = {
    students: db.prepare("SELECT COUNT(*) c FROM students WHERE status = 'פעיל'").get().c,
    classes: db.prepare("SELECT COUNT(*) c FROM classes WHERE status = 'פעיל'").get().c,
    teachers: db.prepare("SELECT COUNT(*) c FROM teachers WHERE status = 'פעיל'").get().c,
    families: db.prepare("SELECT COUNT(DISTINCT family_id) c FROM students WHERE status = 'פעיל' AND family_id IS NOT NULL").get().c,
  };
  const branchStats = db
    .prepare(`
      SELECT COALESCE(c.branch, s.branch) AS branch, COUNT(*) AS count
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      WHERE s.status = 'פעיל' AND COALESCE(c.branch, s.branch) IS NOT NULL
      GROUP BY COALESCE(c.branch, s.branch)
      ORDER BY count DESC
    `)
    .all();
  // "לא משויך" - תלמידים פעילים שאמורים כבר להיות משובצים לכיתה (מ"עדיין לא
  // נכנסו" ועד כיתה ח') אבל אין להם class_id בכלל. זה עוסק אך ורק בכיתה -
  // לא משנה אם יש להם סניף או לא. תלמידים שעדיין לא הגיע זמנם (סטטוס לא
  // פעיל, כמו קטנים שטרם הגיעו לגיל "עדיין לא נכנסו") לא נכללים בכלל.
  const unassignedClassCount = db
    .prepare("SELECT COUNT(*) c FROM students WHERE status = 'פעיל' AND class_id IS NULL")
    .get().c;
  // "שיבוץ שגוי" - תלמידים בכיתה אמיתית (לא "עדיין לא נכנסו") שיש להם בכל
  // זאת שדה סניף ישיר שסותר את הסניף האמיתי של הכיתה שלהם - טעות שדורשת תיקון ידני.
  const mismatchedBranchCount = db
    .prepare(`
      SELECT COUNT(*) c FROM students s JOIN classes c2 ON s.class_id = c2.id
      WHERE c2.name NOT LIKE 'עדיין לא נכנסו%' AND s.branch IS NOT NULL AND TRIM(s.branch) != '' AND s.branch != c2.branch
    `)
    .get().c;
  const monthlyTotal = calcAllFamiliesTuition().reduce((sum, f) => sum + f.netTotal, 0);
  const currentYear = yearManager.getCurrentYear();
  const hebrewDateToday = hd.serialToHebrewString(hd.todayAccessSerial());
  const dayNames = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const { year: todayY, month: todayM, day: todayD } = (() => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date());
    const map = {};
    parts.forEach((p) => { map[p.type] = p.value; });
    return { year: Number(map.year), month: Number(map.month), day: Number(map.day) };
  })();
  const dayName = dayNames[new Date(todayY, todayM - 1, todayD).getDay()];
  const hour = hd.israelHour();
  let greeting;
  if (hour >= 5 && hour < 12) greeting = "בוקר טוב";
  else if (hour >= 12 && hour < 17) greeting = "צהריים טובים";
  else if (hour >= 17 && hour < 22) greeting = "ערב טוב";
  else greeting = "לילה טוב";
  const fullName = req.currentUser
    ? (req.currentUser.full_name || req.currentUser.display_name || req.currentUser.username)
    : "";

  const myTasks = db
    .prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY done ASC, due_date IS NULL, due_date ASC, id DESC")
    .all(req.currentUser.id)
    .map((t) => ({ ...t, due_date_str: t.due_date ? hd.serialToGregorianString(t.due_date) : "" }));

  const unreadCount = db
    .prepare("SELECT COUNT(*) c FROM messages WHERE recipient_id = ? AND read_at IS NULL")
    .get(req.currentUser.id).c;

  const allUsers = db.prepare("SELECT id, username, display_name FROM users ORDER BY display_name").all();

  const { upcomingBirthdays, daysAwayLabel } = require("./birthdays");
  const studentBirthdayRows = db
    .prepare(`
      SELECT s.id, s.first_name, s.last_name, s.birth_date_civil, c.name AS class_name, c.parallel AS class_parallel
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      WHERE s.status = 'פעיל' AND s.birth_date_civil IS NOT NULL
    `)
    .all()
    .map((s) => ({
      id: s.id,
      name: [s.first_name, s.last_name].filter(Boolean).join(" "),
      subLabel: [s.class_name, s.class_parallel].filter(Boolean).join(" "),
      birth_date_civil: s.birth_date_civil,
      href: `/students/${s.id}`,
    }));
  const STUDENT_CLASS_ORDER = [
    "עדיין לא נכנסו", "מכינה א'", "מכינה ב'",
    "כיתה א'", "כיתה ב'", "כיתה ג'", "כיתה ד'",
    "כיתה ה'", "כיתה ו'", "כיתה ז'", "כיתה ח'",
  ];
  function classRank(className) {
    if (!className) return 999;
    const idx = STUDENT_CLASS_ORDER.findIndex((s) => className.startsWith(s));
    return idx === -1 ? 998 : idx;
  }
  const studentBirthdays = upcomingBirthdays(studentBirthdayRows)
    .map((b) => ({ ...b, daysLabel: daysAwayLabel(b.daysAway) }))
    .sort((a, b) => classRank(a.subLabel) - classRank(b.subLabel) || a.subLabel.localeCompare(b.subLabel, "he") || a.name.localeCompare(b.name, "he"));

  const teacherBirthdayRows = db
    .prepare(`SELECT id, first_name, last_name, birth_date_civil FROM teachers WHERE status = 'פעיל' AND birth_date_civil IS NOT NULL`)
    .all()
    .map((t) => ({
      id: t.id,
      name: [t.first_name, t.last_name].filter(Boolean).join(" "),
      subLabel: "",
      birth_date_civil: t.birth_date_civil,
      href: `/teachers/${t.id}`,
    }));
  const teacherBirthdays = upcomingBirthdays(teacherBirthdayRows).map((b) => ({ ...b, daysLabel: daysAwayLabel(b.daysAway) }));

  let pendingOrders = [];
  if (req.currentUser && req.currentUser.is_admin) {
    pendingOrders = db.prepare(`
      SELECT o.*, s.name AS supplier_name, u.display_name AS creator_name
      FROM supplier_orders o
      JOIN suppliers s ON o.supplier_id = s.id
      LEFT JOIN users u ON o.created_by = u.id
      WHERE o.status = 'ממתין לאישור'
      ORDER BY o.created_at ASC
    `).all();
  }

  // הזמנות שהמשתמש הנוכחי שלח, שאושרו (וטרם נשלחו לספק) או נדחו (וטרם "נראו") - צריך תשומת לב שלו
  let myOrderUpdates = [];
  if (req.currentUser) {
    myOrderUpdates = db.prepare(`
      SELECT o.*, s.name AS supplier_name, s.email AS supplier_email, a.display_name AS approver_name
      FROM supplier_orders o
      JOIN suppliers s ON o.supplier_id = s.id
      LEFT JOIN users a ON o.approved_by = a.id
      WHERE o.created_by = ? AND o.dismissed_by_creator = 0
        AND ((o.status = 'אושר' AND o.sent_at IS NULL) OR o.status = 'נדחה')
      ORDER BY o.approved_at DESC
    `).all(req.currentUser.id).map((o) => {
      const mailSubject = encodeURIComponent("הזמנה - תלמוד תורה החדש");
      const mailBody = encodeURIComponent(`שלום,\n\nברצוננו להזמין:\n${o.description}\n\n${o.notes || ""}\n\nתודה.`);
      return {
        ...o,
        mailtoLink: o.supplier_email ? `mailto:${o.supplier_email}?subject=${mailSubject}&body=${mailBody}` : null,
      };
    });
  }

  const upcomingEventsCount = db.prepare(
    "SELECT COUNT(*) c FROM events WHERE event_date >= ?"
  ).get(hd.todayAccessSerial()).c;

  res.render("home", {
    stats, branchStats, unassignedClassCount, mismatchedBranchCount, monthlyTotal, currentYear, hebrewDateToday, dayName,
    // סדר כרטיסי הניווט של המשתמש, נשמר בשרת ולכן זהה בכל המחשבים שלו
    navOrder: (req.currentUser && req.currentUser.nav_order) || "",
    myTasks, unreadCount, greeting, fullName, allUsers,
    studentBirthdays, teacherBirthdays, pendingOrders, myOrderUpdates, upcomingEventsCount,
  });
});

app.use("/", require("./routes/students"));
app.use("/classes", require("./routes/classes"));
app.use("/teachers", require("./routes/teachers"));
app.use("/families", require("./routes/families"));
app.use("/tuition", require("./routes/tuition"));
app.use("/reports", require("./routes/reports"));
app.use("/year", require("./routes/year"));
app.use("/tasks", require("./routes/tasks"));
app.use("/messages", require("./routes/messages"));
// שמירת סדר כרטיסי דף הבית, לכל משתמש בנפרד. נשמר בשרת ולא בדפדפן, כדי
// שהסדר יהיה זהה בכל מחשב שהמשתמש עובד בו.
app.post("/api/nav-order", express.json(), (req, res) => {
  const order = req.body && req.body.order;
  // אימות קפדני: מערך של נתיבים פנימיים בלבד. בלעדיו ניתן לדחוף לעמודה
  // כתובות חיצוניות שיוצגו אחר כך כקישורים בדף הבית.
  if (!Array.isArray(order) || order.length > 60) return res.status(400).json({ ok: false });
  const clean = order.filter((h) => typeof h === "string" && h.startsWith("/") && h.length <= 120);
  // db נטען כאן ולא ברמת הקובץ - כך זה בשאר המסלולים בקובץ הזה
  const db = require("./db");
  db.prepare("UPDATE users SET nav_order = ? WHERE id = ?")
    .run(JSON.stringify(clean), req.currentUser.id);
  res.json({ ok: true });
});

app.use("/presence", require("./routes/presence"));
app.use("/users", requireAdmin, require("./routes/users"));
app.use("/backups", requireAdmin, require("./routes/backups"));
app.get("/profile", requireLogin, (req, res) => {
  const db = require("./db");
  const { hashPassword } = require("./auth");
  const profileUser = db.prepare("SELECT * FROM users WHERE id = ?").get(req.currentUser.id);
  res.render("users/profile", { profileUser, success: req.query.saved });
});
app.post("/profile", requireLogin, (req, res) => {
  const db = require("./db");
  const body = req.body;
  const PROFILE_FIELDS = ["display_name", "full_name", "role_title", "phone", "email"];
  const cols = PROFILE_FIELDS.filter((c) => c in body);
  const values = cols.map((c) => (body[c] === "" ? null : body[c]));
  if (body.new_password && body.new_password.trim()) {
    const { hashPassword } = require("./auth");
    const allCols = [...cols, "password_hash"];
    const allVals = [...values, hashPassword(body.new_password.trim()), req.currentUser.id];
    db.prepare(`UPDATE users SET ${allCols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...allVals);
  } else {
    values.push(req.currentUser.id);
    if (cols.length > 0) {
      db.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...values);
    }
  }
  res.redirect("/profile?saved=1");
});
app.use("/suppliers", require("./routes/suppliers"));
app.use("/letters", require("./routes/letters"));
app.use("/parent-comm", require("./routes/parent-comm"));
app.use("/events", require("./routes/events"));
app.use("/campaigns", require("./routes/campaigns"));
app.use("/inventory", require("./routes/inventory"));
app.use("/expenses", require("./routes/expenses"));
app.use("/books", require("./routes/books"));
app.use("/labels", require("./routes/labels"));


// ===== Proxy endpoints — כל ה-APIs החיצוניים (עוקפים חסימות אינטרנט כשר) =====
(function() {
  const https = require("https");

  async function proxyFetch(url, res) {
    try {
      const data = await new Promise((resolve, reject) => {
        https.get(url, { headers: { "User-Agent": "TalmudToraApp/1.0" } }, (r) => {
          let body = "";
          r.on("data", d => body += d);
          r.on("end", () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
        }).on("error", reject);
      });
      res.setHeader("Cache-Control", "public, max-age=1800");
      res.json(data);
    } catch(e) {
      res.status(502).json({});
    }
  }

  // דף יומי + לוח עברי
  app.get("/api/proxy/hebcal", (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyFetch("https://www.hebcal.com/hebcal?" + q, res);
  });

  // מזג אוויר
  app.get("/api/proxy/weather", (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyFetch("https://api.open-meteo.com/v1/forecast?" + q, res);
  });

  // זמני היום
  app.get("/api/proxy/zmanim", (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyFetch("https://www.hebcal.com/zmanim?" + q, res);
  });

  // זמני שבת
  app.get("/api/proxy/shabbat", (req, res) => {
    const q = new URLSearchParams(req.query).toString();
    proxyFetch("https://www.hebcal.com/shabbat?" + q, res);
  });
})();

// ===== שמירת סדר כרטיסי הניווט בדף הבית (לכל משתמש) =====
// ===== Proxy לנתוני לוח שנה יהודי (Sefaria) =====
app.get("/api/jewish-calendar", async (req, res) => {
  try {
    const https = require("https");
    // diaspora=0 - לוח ארץ ישראל. עם diaspora=1 (מה שהיה כאן) הפרשה סוטה בשבוע
    // שלם מול ישראל בתקופה שאחרי פסח ואחרי שבועות, עד שהלוחות מתאזנים.
    //
    // year/month/day + timezone מפורשים: בלעדיהם Sefaria מנחש מהו "היום" לפי
    // אזור הזמן של מי ששולח את הבקשה. שלושת פרמטרי התאריך חייבים להישלח יחד,
    // אחרת Sefaria מתעלם מהם וחוזר לתאריך שהוא ניחש בעצמו.
    const q = String(req.query.date || "");
    let y, m, d;
    const parts = q.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (parts && +parts[2] >= 1 && +parts[2] <= 12 && +parts[3] >= 1 && +parts[3] <= 31) {
      y = +parts[1]; m = +parts[2]; d = +parts[3];
    } else {
      // ברירת מחדל - התאריך של עכשיו בירושלים
      const t = hd.israelTodayYMD();
      y = t.year; m = t.month; d = t.day;
    }
    const url = `https://www.sefaria.org/api/calendars?diaspora=0&lang=he` +
                `&year=${y}&month=${m}&day=${d}&timezone=${encodeURIComponent("Asia/Jerusalem")}`;
    const data = await new Promise((resolve, reject) => {
      https.get(url, { headers: { "User-Agent": "TalmudToraApp/1.0" } }, (r) => {
        let body = "";
        r.on("data", d => body += d);
        r.on("end", () => {
          try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
        });
      }).on("error", reject);
    });
    res.setHeader("Cache-Control", "public, max-age=1800"); // cache חצי שעה
    res.json(data);
  } catch(e) {
    res.status(502).json({ calendar_items: [] });
  }
});

// ===== API — משימות משותפות =====
app.get("/api/shared-tasks", (req, res) => {
  const db = require("./db");
  const tasks = db.prepare(`
    SELECT st.*, 
           uc.display_name AS created_by_name,
           ud.display_name AS done_by_name
    FROM shared_tasks st
    LEFT JOIN users uc ON st.created_by = uc.id
    LEFT JOIN users ud ON st.done_by = ud.id
    ORDER BY st.done ASC, st.created_at DESC
  `).all();
  res.json(tasks);
});

app.post("/api/shared-tasks", (req, res) => {
  const db = require("./db");
  const hd = require("./hebrewDate");
  const { title, assigned_label, due_date } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: "כותרת חסרה" });
  const info = db.prepare(
    "INSERT INTO shared_tasks (title, assigned_label, created_by, created_at, due_date) VALUES (?,?,?,?,?)"
  ).run(title.trim(), assigned_label || "כולם", req.currentUser.id, new Date().toISOString(), due_date ? hd.gregorianStringToSerial(due_date) : null);
  res.json({ id: info.lastInsertRowid });
});

app.post("/api/shared-tasks/:id/done", (req, res) => {
  const db = require("./db");
  db.prepare("UPDATE shared_tasks SET done=1, done_at=?, done_by=? WHERE id=?")
    .run(new Date().toISOString(), req.currentUser.id, req.params.id);
  res.json({ ok: true });
});

app.post("/api/shared-tasks/:id/undone", (req, res) => {
  const db = require("./db");
  db.prepare("UPDATE shared_tasks SET done=0, done_at=NULL, done_by=NULL WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.delete("/api/shared-tasks/:id", (req, res) => {
  const db = require("./db");
  db.prepare("DELETE FROM shared_tasks WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.use((req, res) => {
  res.status(404).render("404");
});

app.listen(PORT, () => {
  console.log(`מערכת תלמוד תורה פועלת על http://localhost:${PORT}`);

  // וידוא שנת הלימודים תשפ"ז
  try {
    const db = require("./db");
    const row = db.prepare("SELECT value FROM settings WHERE key = 'current_hebrew_year'").get();
    if (!row || row.value === 'תשפ"ו') {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('current_hebrew_year', ?)").run('תשפ"ז');
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('current_hebrew_year_num', ?)").run("5787");
      console.log('שנת הלימודים עודכנה לתשפ"ז');
    }
    // אכלוס מחירון וקטלוג ספרים אם ריקים
    require("./seedBooks")(db);
  } catch (e) { console.error("שגיאה בהפעלה:", e.message); }


  // גיבוי אוטומטי ל-seed.json כל לילה בחצות (מגן על הנתונים)
  function scheduleNightlyBackup() {
    const now = new Date();
    const next = new Date();
    next.setHours(2, 0, 0, 0); // 2:00 לפנות בוקר
    if (next <= now) next.setDate(next.getDate() + 1);
    const msUntilNext = next - now;
    const { execFile } = require("child_process");
    function runExport() {
      execFile(process.execPath, [path.join(__dirname, "exportSeed.js")], (err) => {
        if (err) console.error("שגיאה בגיבוי אוטומטי:", err.message);
        else console.log("[גיבוי אוטומטי] seed.json עודכן בהצלחה -", new Date().toLocaleString("he-IL"));
      });
    }
    setTimeout(() => {
      runExport();
      setInterval(runExport, 24 * 60 * 60 * 1000);
    }, msUntilNext);
    console.log(`גיבוי אוטומטי מתוכנן בעוד ${Math.round(msUntilNext / 60000)} דקות`);
  }
  scheduleNightlyBackup();

  // גיבוי מלא שבועי (קוד + נתונים יחד) - זמין להורדה תחת /backups
  try {
    require("./fullBackup").scheduleWeeklyFullBackup();
  } catch (e) {
    console.error("שגיאה בתזמון גיבוי מלא:", e.message);
  }

  // שיבוץ אוטומטי לפי אזור מגורים - רץ ברקע כל 3 שעות, בלי צורך שמישהו יבקר
  // במסך "שיבוץ לפי אזור" באופן ידני. מזיז רק תלמידי "עדיין לא נכנסו" שהרחוב
  // שלהם מזוהה (ברשימה הקבועה או שנלמד בעבר); רחובות לא מזוהים נשארים לטיפול ידני.
  try {
    const { runAutoZoneAssignment } = require("./zoneResolver");
    function runZoneAssignment() {
      try {
        const moved = runAutoZoneAssignment(db);
        if (moved > 0) console.log(`[שיבוץ אזורים אוטומטי] ${moved} תלמידים שובצו -`, new Date().toLocaleString("he-IL"));
      } catch (e) {
        console.error("שגיאה בשיבוץ אזורים אוטומטי:", e.message);
      }
    }
    setTimeout(runZoneAssignment, 2 * 60 * 1000); // ריצה ראשונה כמה דקות אחרי עליית השרת
    setInterval(runZoneAssignment, 3 * 60 * 60 * 1000); // ואז כל 3 שעות
    console.log("שיבוץ אזורים אוטומטי מתוזמן (כל 3 שעות)");
  } catch (e) {
    console.error("שגיאה בתזמון שיבוץ אזורים:", e.message);
  }
});

// ===== API — משימות משותפות =====
// ניקוי אוטומטי: מחיקת משימות שבוצעו לפני יותר מ-24 שעות
function cleanOldSharedTasks() {
  const db = require("./db");
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const del = db.prepare("DELETE FROM shared_tasks WHERE done=1 AND done_at < ?").run(cutoff);
  if (del.changes > 0) console.log(`[shared_tasks] נמחקו ${del.changes} משימות ישנות`);
}
setInterval(cleanOldSharedTasks, 60 * 60 * 1000); // כל שעה
cleanOldSharedTasks(); // גם בהפעלה
