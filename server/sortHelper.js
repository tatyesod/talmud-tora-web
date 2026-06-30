// בונה ORDER BY בטוח לפי רשימת עמודות מותרות (whitelist)
// allowedColumns: { queryParamName: "sql expression" } - יכול לכלול כמה עמודות מופרדות בפסיק
function buildOrderBy(req, allowedColumns, defaultSql) {
  const sort = req.query.sort;
  const dir = req.query.dir === "desc" ? "DESC" : "ASC";
  if (sort && allowedColumns[sort]) {
    const cols = allowedColumns[sort].split(",").map((c) => `${c.trim()} ${dir}`);
    return `ORDER BY ${cols.join(", ")}`;
  }
  return defaultSql;
}

module.exports = { buildOrderBy };
