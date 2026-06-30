const express = require("express");
const path = require("path");
const methodOverride = require("method-override");
const session = require("express-session");
const hd = require("./hebrewDate");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "talmud-tora-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 },
  })
);

// --- אימות מבוסס מסד נתונים, ריבוי משתמשים ---
app.use((req, res, next) => {
  if (req.session.userId) {
    const db = require("./db");
    const u = db.prepare("SELECT id, username, display_name, is_admin FROM users WHERE id = ?").get(req.session.userId);
    if (u) {
      req.currentUser = u;
      res.locals.user = u.display_name || u.username;
      res.locals.currentUserId = u.id;
      res.locals.isAdmin = !!u.is_admin;
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
  next();
});

function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  return res.redirect("/login");
}

function requireAdmin(req, res, next) {
  if (req.currentUser && req.currentUser.is_admin) return next();
  return res.status(403).render("403");
}

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
    return res.redirect("/");
  }
  res.render("login", { error: "שם משתמש או סיסמה שגויים" });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.use(requireLogin);

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
      SELECT COALESCE(c.branch, 'לא משויך') AS branch, COUNT(*) AS count
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      WHERE s.status = 'פעיל'
      GROUP BY c.branch
      ORDER BY count DESC
    `)
    .all();
  const monthlyTotal = calcAllFamiliesTuition().reduce((sum, f) => sum + f.netTotal, 0);
  const currentYear = yearManager.getCurrentYear();
  const hebrewDateToday = hd.serialToHebrewString(hd.todayAccessSerial());
  const dayNames = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
  const dayName = dayNames[new Date().getDay()];

  const myTasks = db
    .prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY done ASC, due_date IS NULL, due_date ASC, id DESC")
    .all(req.currentUser.id)
    .map((t) => ({ ...t, due_date_str: t.due_date ? hd.serialToGregorianString(t.due_date) : "" }));

  const unreadCount = db
    .prepare("SELECT COUNT(*) c FROM messages WHERE recipient_id = ? AND read_at IS NULL")
    .get(req.currentUser.id).c;

  res.render("home", {
    stats, branchStats, monthlyTotal, currentYear, hebrewDateToday, dayName,
    myTasks, unreadCount,
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
app.use("/presence", require("./routes/presence"));
app.use("/users", requireAdmin, require("./routes/users"));
app.use("/suppliers", require("./routes/suppliers"));
app.use("/parent-comm", require("./routes/parent-comm"));
app.use("/events", require("./routes/events"));
app.use("/inventory", require("./routes/inventory"));
app.use("/expenses", require("./routes/expenses"));

app.use((req, res) => {
  res.status(404).render("404");
});

app.listen(PORT, () => {
  console.log(`מערכת תלמוד תורה פועלת על http://localhost:${PORT}`);
});
