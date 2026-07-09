// גיבוי מלא: קוד המערכת (server/) + נתונים (seed.json) יחד בקובץ ZIP אחד.
// נועד כדי שתהיה עותק שלם - גם עיצוב/קוד וגם תוכן - שאפשר להוריד ולשמור עצמאית
// (דרייב/דרופבוקס), בלי תלות בגיטהאב או ב-Render.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const JSZip = require("jszip");

const PROJECT_ROOT = path.join(__dirname, "..");

const BACKUPS_DIR = process.env.RENDER_PERSISTENT_DIR
  ? path.join(process.env.RENDER_PERSISTENT_DIR, "backups", "full")
  : path.join(__dirname, "backups-full");

// תיקיות/קבצים שלא נכנסים לגיבוי (קבצים כבדים/לא רלוונטיים/כבר מגובים בנפרד)
const EXCLUDE_DIRS = new Set(["node_modules", ".git", "backups", "backups-full", "uploads", ".npm-global"]);
const EXCLUDE_FILES = new Set(["talmud-tora.db", "talmud-tora.db-journal", "talmud-tora.db-wal", "talmud-tora.db-shm"]);
const MAX_KEPT_BACKUPS = 8; // ~2 חודשים אם רץ פעם בשבוע

function addDirToZip(zip, dirPath, zipPathPrefix) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      addDirToZip(zip, path.join(dirPath, entry.name), `${zipPathPrefix}${entry.name}/`);
    } else {
      if (EXCLUDE_FILES.has(entry.name)) continue;
      const fileData = fs.readFileSync(path.join(dirPath, entry.name));
      zip.file(`${zipPathPrefix}${entry.name}`, fileData);
    }
  }
}

function refreshSeedJson() {
  try {
    execFileSync(process.execPath, [path.join(__dirname, "exportSeed.js")], { stdio: "pipe" });
  } catch (e) {
    console.error("שגיאה ברענון seed.json לפני גיבוי מלא:", e.message);
  }
}

async function createFullBackup() {
  refreshSeedJson();

  const zip = new JSZip();
  addDirToZip(zip, PROJECT_ROOT, "");

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });

  const now = new Date();
  const stamp = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const filename = `גיבוי-מלא-${stamp}.zip`;
  const outPath = path.join(BACKUPS_DIR, filename);

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.writeFileSync(outPath, buffer);

  // שמירת המספר האחרון של גיבויים בלבד, כדי לא למלא את הדיסק
  const files = fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => f.startsWith("גיבוי-מלא-") && f.endsWith(".zip"))
    .sort();
  while (files.length > MAX_KEPT_BACKUPS) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(path.join(BACKUPS_DIR, oldest));
    } catch (e) {
      /* ignore */
    }
  }

  console.log(`[גיבוי מלא] נוצר בהצלחה: ${filename} (${(buffer.length / 1024 / 1024).toFixed(1)}MB)`);
  return outPath;
}

function scheduleWeeklyFullBackup() {
  const ONE_WEEK = 7 * 24 * 60 * 60 * 1000;
  function runBackup() {
    createFullBackup().catch((e) => console.error("שגיאה בגיבוי מלא מתוזמן:", e.message));
  }
  // גיבוי ראשון כמה דקות אחרי עליית השרת (לא מיד, כדי לא להאט את ההפעלה), ואז כל שבוע
  setTimeout(runBackup, 5 * 60 * 1000);
  setInterval(runBackup, ONE_WEEK);
  console.log("גיבוי מלא שבועי מתוזמן (כל 7 ימים)");
}

module.exports = { createFullBackup, scheduleWeeklyFullBackup, BACKUPS_DIR };
