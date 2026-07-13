// התאמה וייבוא נתונים חיצוניים ממערכת הסליקה (תרומות + מיילים) -
// מריצים רק ידנית דרך /families/import-external, לא אוטומטית בעליית שרת,
// כי מדובר בעדכון נתונים כספיים/אישיים אמיתיים שדורש בדיקה אנושית של התוצאה.
const { DONATIONS_IMPORT, EMAILS_IMPORT } = require("./externalImportSeed");

function normalizeId(id) {
  return (id || "").toString().replace(/\D/g, "").replace(/^0+/, "");
}

function loadFamilies(db) {
  return db.prepare(`
    SELECT id, last_name, street, house_number, father_id_number, mother_id_number,
           father_email, mother_email, monthly_donation_amount
    FROM families
  `).all();
}

// מוצא משפחה מתאימה **לפי ת"ז בלבד** (אב או אם) - זו הדרך המהימנה היחידה
// לעדכון אוטומטי. שמות משפחה (גם משולבים עם כתובת) לא מספיק ייחודיים -
// יש הרבה משפחות עם אותו שם משפחה בישראל, וטעות כאן משמעה לייחס תרומה/מייל
// למשפחה הלא נכונה. לכן התאמה לפי שם מוצגת כ"הצעה לבדיקה ידנית" בלבד,
// ולעולם לא נכתבת אוטומטית למסד הנתונים.
function findFamilyMatch(families, { idNumber }) {
  const normId = normalizeId(idNumber);
  if (!normId) return null;
  const byId = families.find(
    (f) => (f.father_id_number && normalizeId(f.father_id_number) === normId) ||
           (f.mother_id_number && normalizeId(f.mother_id_number) === normId)
  );
  if (!byId) return null;
  const matchedVia = (byId.father_id_number && normalizeId(byId.father_id_number) === normId) ? "father" : "mother";
  return { family: byId, matchedVia };
}

// מוצא הצעות אפשריות (לא ודאיות) לפי שם משפחה, לצורך בדיקה ידנית בלבד -
// אף פעם לא נכתב אוטומטית.
function findNameSuggestions(families, { lastNameGuess, address }) {
  if (!lastNameGuess) return [];
  const clean = lastNameGuess.trim();
  let candidates = families.filter((f) => f.last_name && f.last_name.trim() === clean);
  if (candidates.length > 1 && address) {
    const narrowed = candidates.filter((f) => f.street && address.includes(f.street.trim()));
    if (narrowed.length > 0) candidates = narrowed;
  }
  return candidates;
}

function runDonationsImport(db) {
  const families = loadFamilies(db);
  const update = db.prepare("UPDATE families SET monthly_donation_amount = ? WHERE id = ?");
  const results = { updated: [], suggestions: [], skipped: [] };

  for (const row of DONATIONS_IMPORT) {
    const lastNameGuess = (row.name || "").trim().split(/\s+/)[0];
    const idMatch = findFamilyMatch(families, { idNumber: row.idNumber });
    if (idMatch) {
      update.run(row.amount, idMatch.family.id);
      results.updated.push({
        familyId: idMatch.family.id,
        familyLastName: idMatch.family.last_name,
        sourceName: row.name,
        amount: row.amount,
        method: "id",
      });
      continue;
    }
    const suggestions = findNameSuggestions(families, { lastNameGuess, address: row.address });
    if (suggestions.length > 0) {
      results.suggestions.push({ ...row, candidates: suggestions.map((f) => ({ id: f.id, lastName: f.last_name, street: f.street })) });
    } else {
      results.skipped.push({ ...row, reason: "לא נמצאה משפחה תואמת (לא לפי ת\"ז ולא לפי שם)" });
    }
  }
  return results;
}

function runEmailsImport(db) {
  const families = loadFamilies(db);
  const updateFather = db.prepare("UPDATE families SET father_email = ? WHERE id = ?");
  const updateMother = db.prepare("UPDATE families SET mother_email = ? WHERE id = ?");
  const results = { updated: [], suggestions: [], skipped: [] };

  for (const row of EMAILS_IMPORT) {
    const idMatch = findFamilyMatch(families, { idNumber: row.idNumber });
    if (idMatch) {
      const field = idMatch.matchedVia; // "father" or "mother" - מעדכנים בדיוק את מייל אותו הורה שהת"ז שלו תאמה
      if (field === "father") updateFather.run(row.email, idMatch.family.id);
      else updateMother.run(row.email, idMatch.family.id);
      results.updated.push({
        familyId: idMatch.family.id,
        familyLastName: idMatch.family.last_name,
        sourceName: `${row.firstName} ${row.lastName}`,
        email: row.email,
        field,
        method: "id",
      });
      continue;
    }
    const suggestions = findNameSuggestions(families, { lastNameGuess: row.lastName, address: null });
    if (suggestions.length > 0) {
      results.suggestions.push({ ...row, candidates: suggestions.map((f) => ({ id: f.id, lastName: f.last_name, street: f.street })) });
    } else {
      results.skipped.push({ ...row, reason: "לא נמצאה משפחה תואמת (לא לפי ת\"ז ולא לפי שם משפחה)" });
    }
  }
  return results;
}

module.exports = { runDonationsImport, runEmailsImport };
