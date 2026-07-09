const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");
const { createFullBackup, BACKUPS_DIR } = require("../fullBackup");

router.get("/", (req, res) => {
  let files = [];
  if (fs.existsSync(BACKUPS_DIR)) {
    files = fs
      .readdirSync(BACKUPS_DIR)
      .filter((f) => f.endsWith(".zip"))
      .map((f) => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, f));
        return { name: f, sizeMb: (stat.size / 1024 / 1024).toFixed(1), mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
  res.render("backups/index", { files, justCreated: req.query.created === "1" });
});

router.post("/create", async (req, res) => {
  try {
    await createFullBackup();
    res.redirect("/backups?created=1");
  } catch (e) {
    res.status(500).send("שגיאה ביצירת גיבוי: " + e.message);
  }
});

router.get("/download/:filename", (req, res) => {
  const filename = req.params.filename;
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    return res.status(400).send("שם קובץ לא תקין");
  }
  const filePath = path.join(BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("קובץ לא נמצא");
  res.download(filePath, filename);
});

module.exports = router;
