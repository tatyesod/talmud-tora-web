const express = require("express");
const router = express.Router();
const yearManager = require("../yearManager");

router.get("/", (req, res) => {
  const currentYear = yearManager.getCurrentYear();
  const snapshots = yearManager.listSnapshots();
  res.render("year/index", { currentYear, snapshots, result: null });
});

router.post("/promote", (req, res) => {
  const result = yearManager.promoteYear();
  const currentYear = yearManager.getCurrentYear();
  const snapshots = yearManager.listSnapshots();
  res.render("year/index", { currentYear, snapshots, result });
});

router.get("/snapshots/:id", (req, res) => {
  const snapshot = yearManager.getSnapshot(req.params.id);
  if (!snapshot) return res.status(404).render("404");
  res.render("year/snapshot", { snapshot });
});

module.exports = router;
