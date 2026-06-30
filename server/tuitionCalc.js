const db = require("./db");

// מחזיר את אחוז ההנחה המתאים למספר הילדים הפעילים במשפחה
// לפי טבלת discounts (siblings_count -> amount%), עם ברירת מחדל 0%
function getDiscountPercent(activeChildrenCount) {
  if (activeChildrenCount <= 1) return 0;
  const rows = db
    .prepare("SELECT siblings_count, amount FROM discounts ORDER BY siblings_count ASC")
    .all();
  let percent = 0;
  for (const r of rows) {
    if (activeChildrenCount >= r.siblings_count) {
      percent = r.amount;
    }
  }
  return percent;
}

// מחשב שכר לימוד למשפחה אחת: רשימת ילדים פעילים עם מחיר קטגוריה, סה"כ, הנחה, סכום סופי
function calcFamilyTuition(familyId) {
  const children = db
    .prepare(`
      SELECT s.id, s.first_name, s.last_name, c.name AS class_name,
             cat.name AS category_name, cat.price
      FROM students s
      LEFT JOIN classes c ON s.class_id = c.id
      LEFT JOIN categories cat ON c.category_id = cat.id
      WHERE s.family_id = ? AND s.status = 'פעיל'
      ORDER BY s.birth_date_civil
    `)
    .all(familyId);

  const activeCount = children.length;
  const discountPercent = getDiscountPercent(activeCount);
  const grossTotal = children.reduce((sum, c) => sum + (c.price || 0), 0);
  const discountAmount = Math.round(grossTotal * (discountPercent / 100) * 100) / 100;
  const netTotal = Math.round((grossTotal - discountAmount) * 100) / 100;

  return {
    children,
    activeCount,
    discountPercent,
    grossTotal,
    discountAmount,
    netTotal,
  };
}

// מחשב שכר לימוד לכל המשפחות בעלות ילדים פעילים
function calcAllFamiliesTuition() {
  const families = db
    .prepare(`
      SELECT DISTINCT f.id, f.last_name, f.father_name, f.home_phone
      FROM families f
      JOIN students s ON s.family_id = f.id
      WHERE s.status = 'פעיל'
      ORDER BY f.last_name
    `)
    .all();

  return families.map((f) => ({
    ...f,
    ...calcFamilyTuition(f.id),
  }));
}

module.exports = { getDiscountPercent, calcFamilyTuition, calcAllFamiliesTuition };
