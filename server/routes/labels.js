const express = require("express");
const router = express.Router();
const db = require("../db");

// הגדרות פורמטים של מדבקות TANEX
const FORMATS = {
  "2133": { name: "TANEX 2133 — 33 בדף (3×11)", cols: 3, rows: 11, perPage: 33,
    labelW: "70mm", labelH: "25.4mm", pageMarginTop: "10.65mm", pageMarginSide: "4.5mm", gap: "0mm", fontSize: "9pt" },
  "2072": { name: "TANEX 2072 — 72 בדף (6×12)", cols: 6, rows: 12, perPage: 72,
    labelW: "46.3mm", labelH: "21.2mm", pageMarginTop: "13.5mm", pageMarginSide: "3.85mm", gap: "0mm", fontSize: "7.5pt" },
  "2120": { name: "TANEX 2120 — 120 בדף (6×20)", cols: 6, rows: 20, perPage: 120,
    labelW: "38.1mm", labelH: "13mm", pageMarginTop: "15mm", pageMarginSide: "4mm", gap: "0mm", fontSize: "6pt" },
};

// דף בחירת הגדרות
router.get("/", (req, res) => {
  const classes = db.prepare("SELECT id, name, parallel FROM classes ORDER BY name, parallel").all();
  res.render("labels/setup", { formats: FORMATS, classes });
});

// הפקת מדבקות
router.get("/print", (req, res) => {
  const { format, content_type, class_id, copies } = req.query;
  const fmt = FORMATS[format] || FORMATS["2133"];
  const numCopies = parseInt(copies) || 1;

  let items = [];

  if (content_type === "families") {
    let sql = `
      SELECT DISTINCT f.last_name, f.father_name, f.street, f.house_number, f.city, f.zip_code
      FROM families f
      JOIN students s ON s.family_id = f.id
      WHERE s.status = 'פעיל'
    `;
    const params = [];
    if (class_id) { sql += " AND s.class_id = ?"; params.push(class_id); }
    sql += " ORDER BY f.last_name";
    const rows = db.prepare(sql).all(...params);
    items = rows.map(r => ({
      line1: `משפחת ${r.last_name || ""}`,
      line2: [r.street, r.house_number].filter(Boolean).join(" "),
      line3: r.city || "",
    }));

  } else if (content_type === "students") {
    let sql = `
      SELECT s.first_name, s.last_name, c.name AS class_name, c.parallel, f.last_name AS family_last
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN families f ON s.family_id = f.id
      WHERE s.status = 'פעיל'
    `;
    const params = [];
    if (class_id) { sql += " AND s.class_id = ?"; params.push(class_id); }
    sql += " ORDER BY c.name, c.parallel, s.last_name, s.first_name";
    const rows = db.prepare(sql).all(...params);
    items = rows.map(r => ({
      line1: `${r.first_name || ""} ${r.last_name || r.family_last || ""}`,
      line2: r.class_name ? r.class_name + (r.parallel ? " " + r.parallel : "") : "",
      line3: "",
    }));

  } else if (content_type === "teachers") {
    let sql = "SELECT first_name, last_name, street, house_number, city FROM teachers WHERE status='פעיל'";
    const params = [];
    if (class_id) {
      sql += " AND id IN (SELECT teacher_id FROM teacher_classes WHERE class_id=?)";
      params.push(class_id);
    }
    sql += " ORDER BY last_name, first_name";
    const rows = db.prepare(sql).all(...params);
    items = rows.map(r => ({
      line1: "לכבוד",
      line2: "הרב " + (r.first_name || "") + " " + (r.last_name || ""),
      line3: [r.street, r.house_number, r.city].filter(Boolean).join(" "),
      isTeacher: true,
    }));
  }

  // הכפלת כמות עותקים
  const allItems = [];
  for (const item of items) {
    for (let i = 0; i < numCopies; i++) allItems.push(item);
  }

  // קבלת כיתה לתצוגה
  const cls = class_id ? db.prepare("SELECT name, parallel FROM classes WHERE id=?").get(class_id) : null;
  const clsLabel = cls ? cls.name + (cls.parallel ? " " + cls.parallel : "") : "כל הכיתות";

  res.render("labels/print", { fmt, format, items: allItems, content_type, clsLabel });
});

module.exports = router;
