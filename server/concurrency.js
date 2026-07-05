// מנגנון "נעילה אופטימית" - מונע מצב שבו שני משתמשים עורכים את אותה רשומה
// בו-זמנית ואחד דורס בשקט את השינוי של השני.
//
// איך זה עובד:
// 1. בכל טופס עריכה יש שדה נסתר updated_at עם הערך שהיה ברשומה כשהטופס נטען.
// 2. בזמן שמירה, בודקים אם הערך הזה עדיין תואם למה שבפועל שמור במסד הנתונים כרגע.
// 3. אם כן - השמירה מתבצעת כרגיל, וה-updated_at מתעדכן לזמן הנוכחי.
// 4. אם לא (מישהו אחר כבר שמר שינוי אחרי שהטופס שלנו נטען) - השמירה נחסמת,
//    והמשתמש מופנה בחזרה לטופס העריכה עם אזהרה במקום לדרוס את השינוי של האחר.

const db = require("./db");

// בודק אם מותר לשמור. מחזיר true אם אין התנגשות, false אם יש (ואז לא מבצעים את העדכון).
function checkNoConflict(table, id, clientUpdatedAt) {
  const row = db.prepare(`SELECT updated_at FROM ${table} WHERE id = ?`).get(id);
  if (!row) return true; // הרשומה לא נמצאה - נטפל בזה בנפרד בראוט עצמו
  if (!clientUpdatedAt) return true; // טופס ישן בלי השדה - לא חוסמים (נפילה רכה לאחור)
  if (!row.updated_at) return true; // אין עדיין ערך במסד - לא חוסמים
  return String(row.updated_at) === String(clientUpdatedAt);
}

module.exports = { checkNoConflict };
