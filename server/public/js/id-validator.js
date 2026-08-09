// בדיקת תקינות מספר ת"ז ישראלי לפי נוסחת ספרת הביקורת הרשמית.
// שימו לב: זו בדיקת *מבנה* בלבד - מוודאת שהמספר לא הוקלד בטעות, לא מוודאת
// שהוא שייך בפועל לאדם שהוזן, ולא בודקת מול שום מאגר חיצוני.
function isValidIsraeliId(id) {
  if (id == null) return false;
  const clean = String(id).trim();
  if (!/^\d{1,9}$/.test(clean)) return false;
  const padded = clean.padStart(9, "0");
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let digit = Number(padded[i]) * ((i % 2) + 1);
    if (digit > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}

// מחבר בדיקה חיה לכל שדה עם class="israeli-id-input" - בעת יציאה מהשדה
// (blur), אם יש ערך והוא לא תקין, מציג שגיאה אדומה מתחת לשדה. שדה ריק לא
// נחשב שגיאה (לא כל שדה ת"ז הוא חובה).
function attachIsraeliIdValidation() {
  document.querySelectorAll(".israeli-id-input").forEach((input) => {
    let errorSpan = input.parentElement.querySelector(".israeli-id-error");
    if (!errorSpan) {
      errorSpan = document.createElement("div");
      errorSpan.className = "israeli-id-error";
      errorSpan.style.cssText = "color:#a94442; font-size:0.82em; margin-top:3px; display:none;";
      errorSpan.textContent = "מספר ת\"ז לא תקין - יש לבדוק שוב";
      input.insertAdjacentElement("afterend", errorSpan);
    }
    const validate = () => {
      const val = input.value.trim();
      if (val === "" || isValidIsraeliId(val)) {
        errorSpan.style.display = "none";
        input.style.borderColor = "";
      } else {
        errorSpan.style.display = "block";
        input.style.borderColor = "#a94442";
      }
    };
    input.addEventListener("blur", validate);
    input.addEventListener("input", () => {
      // מסתירים את השגיאה מיד כשמתחילים לתקן, לא מציקים תוך כדי הקלדה
      if (errorSpan.style.display === "block") errorSpan.style.display = "none";
      input.style.borderColor = "";
    });
    if (input.value.trim() !== "") validate(); // בדיקה גם על ערך קיים בטעינת הדף
  });
}

document.addEventListener("DOMContentLoaded", attachIsraeliIdValidation);
