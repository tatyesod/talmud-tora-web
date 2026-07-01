#!/usr/bin/env python3
import sqlite3, os

DATA_DIR = os.environ.get("RENDER_PERSISTENT_DIR", os.path.join(os.path.dirname(__file__), "server", "data"))
DB_PATH = os.path.join(DATA_DIR, "talmud-tora.db")
YEAR = 'תשפ"ז'

# ===== מחירון בסיס =====
PRICES = [
    ("סידור (כרוך) עוז והדר", "עוז והדר", 34),
    ("תהילים (כרוך) עוז והדר", "עוז והדר", 36),
    ("חומש (כרוך) הדר", "הדר", 28),
    ("חמישה חומשי תורה (כרוך) הדר", "הדר", 62),
    ("גמרא מפעל המשניות", "מפעל המשניות והתלמוד", 17),
    ("גמרא בבא קמא (כרוך) עוז והדר", "עוז והדר (בלי מהרש\"א)", 46),
    ("גמרא בבא מציעא (כרוך) עוז והדר", "עוז והדר (בלי מהרש\"א)", 46),
    ("גמרא בבא קמא (כרוך) טלמן", "טלמן (עם מהרש\"א)", 63),
    ("גמרא בבא מציעא (כרוך) טלמן", "טלמן (עם מהרש\"א)", 64),
    ("גמרא קידושין (כרוך) טלמן", "טלמן עם רי\"ף", 83),
    ("גמרא סוכה (כרוך) טלמן", "טלמן עם מהרש\"א", 65),
    ("משניות", "מפעל המשניות והתלמוד", 15),
    ("משניות סדר מועד (כרוך) עוז והדר", "עוז והדר", 35),
    ("משניות סדר קדשים (כרוך) עוז והדר", "עוז והדר", 35),
    ("משניות סדר נזיקין (כרוך) עוז והדר", "עוז והדר", 35),
    ("משנה ברורה (כרוך)", "לשם / עוז והדר", 58),
    ("קיצור שולחן ערוך (כרוך)", "אורות חיים", 44),
    ("נביא", "", 20),
    ("כתיב וכתב", "", 17),
    ("קרא כצבי", "", 44),
    ("בואו חשבון", "", 32),
    ("סודות הלשון", "הלפרין", 33),
    ("אורחות צדיקים", "", 15),
    ("מסילת ישרים", "", 15),
    ("שערי תשובה", "", 15),
    ("תורת הבית לחפץ חיים", "", 22),
    ("כלי כתיבה - כיתות א-ג", "", 30),
    ("כלי כתיבה - כיתות ד-ז", "", 50),
]

# ===== קטלוג לפי כיתות =====
CATALOG = {
    "כיתה א'": [
        ("חומש \"בראשית\" (כרוך)", "הדר", 28, 0),
        ("כלי כתיבה (חובה) - לכל השנה", "", 30, 1),
    ],
    "כיתה ב'": [
        ("חומש \"שמות\" (כרוך)", "הדר", 28, 0),
        ("משניות ברכות", "מפעל המשניות והתלמוד", 15, 0),
        ("קיצור שולחן ערוך לתלמידים (כרוך)", "אורות חיים", 44, 0),
        ("כתיב וכתב 2", "", 17, 0),
        ("קרא כצבי חלק 1", "", 44, 0),
        ("בואו חשבון חלק 1", "", 32, 0),
        ("בואו חשבון חלק 2", "", 32, 0),
        ("כלי כתיבה (חובה) - לכל השנה", "", 40, 1),
    ],
    "כיתה ג'": [
        ("גמרא אלו מציאות", "מפעל המשניות והתלמוד", 17, 0),
        ("חומש \"ויקרא\" (כרוך)", "הדר", 28, 0),
        ("משניות כרך סדר מועד (כרוך)", "עוז והדר", 35, 0),
        ("קרא כצבי חלק 2", "", 44, 0),
        ("בואו חשבון חלק 3", "", 32, 0),
        ("כתיב וכתב 3", "", 17, 0),
        ("כלי כתיבה (חובה) - לכל השנה", "", 50, 1),
    ],
    "כיתה ד'": [
        ("גמרא הכונס", "מפעל המשניות והתלמוד", 17, 0),
        ("חומש \"במדבר\" (כרוך)", "הדר", 28, 0),
        ("משניות כרך סדר מועד (כרוך)", "עוז והדר", 35, 0),
        ("נביא יהושע שופטים", "", 20, 0),
        ("קרא כצבי חלק 3", "", 44, 0),
        ("בואו חשבון חלק 4", "", 32, 0),
        ("כתיב וכתב 4", "", 17, 0),
        ("סודות הלשון ד'", "הלפרין", 33, 0),
        ("כלי כתיבה (חובה) - לכל השנה", "", 50, 1),
    ],
    "כיתה ה'": [
        ("גמרא בבא מציעא (כרוך)", "עוז והדר (בלי מהרש\"א)", 46, 0),
        ("חומש \"דברים\" (כרוך)", "הדר", 28, 0),
        ("משניות כרך סדר מועד (כרוך)", "עוז והדר", 35, 0),
        ("נביא שמואל", "", 20, 0),
        ("אורחות צדיקים", "", 15, 0),
        ("קרא כצבי חלק 4", "", 44, 0),
        ("בואו חשבון חלק 5", "", 32, 0),
        ("כתיב וכתב 5", "", 17, 0),
        ("סודות הלשון ה'", "הלפרין", 33, 0),
        ("כלי כתיבה (חובה) - לכל השנה", "", 50, 1),
    ],
    "כיתה ו'": [
        ("גמרא בבא קמא (כרוך)", "עוז והדר (בלי מהרש\"א)", 46, 0),
        ("גמרא בבא מציעא (כרוך)", "עוז והדר (בלי מהרש\"א)", 46, 0),
        ("משניות כרך סדר מועד (כרוך)", "עוז והדר", 35, 0),
        ("נביא מלכים", "", 20, 0),
        ("תורת הבית לחפץ חיים", "", 22, 0),
        ("מסילת ישרים", "", 15, 0),
        ("קרא כצבי חלק 5", "", 44, 0),
        ("בואו חשבון חלק 6", "", 32, 0),
        ("כתיב וכתב 6", "", 17, 0),
        ("סודות הלשון ו'", "הלפרין", 33, 0),
        ("כלי כתיבה (חובה) - לכל השנה", "", 50, 1),
    ],
    "כיתה ז'": [
        ("גמרא בבא קמא (כרוך)", "טלמן (עם מהרש\"א)", 63, 0),
        ("גמרא בבא מציעא (כרוך)", "טלמן (עם מהרש\"א)", 64, 0),
        ("משניות כרך סדר קדשים (כרוך)", "עוז והדר", 35, 0),
        ("משנה ברורה חלק א' (כרוך)", "לשם / עוז והדר", 58, 0),
        ("משנה ברורה חלק ו' (כרוך)", "לשם / עוז והדר", 58, 0),
        ("נביא ישעיה", "", 20, 0),
        ("שערי תשובה", "", 15, 0),
        ("קרא כצבי חלק 6 (2 חלקים)", "", 44, 0),
        ("בואו חשבון חלק 7", "", 32, 0),
        ("כתיב וכתב 7", "", 17, 0),
        ("סודות הלשון ז'", "הלפרין", 33, 0),
    ],
    "כיתה ח'": [
        ("גמרא קידושין (כרוך)", "טלמן עם רי\"ף", 83, 0),
        ("גמרא סוכה (כרוך)", "טלמן עם מהרש\"א", 65, 0),
        ("חמישה חומשי תורה (כרוך)", "הדר", 62, 0),
        ("משניות כרך סדר נזיקין (כרוך)", "עוז והדר", 35, 0),
        ("משנה ברורה חלק א' (כרוך)", "לשם / עוז והדר", 58, 0),
        ("משנה ברורה חלק ו' (כרוך)", "לשם / עוז והדר", 58, 0),
    ],
}

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

# יצירת טבלאות אם לא קיימות
cur.execute("""CREATE TABLE IF NOT EXISTS book_catalog (
    id INTEGER PRIMARY KEY, year_label TEXT NOT NULL, class_name TEXT NOT NULL,
    item_name TEXT NOT NULL, publisher TEXT, price REAL NOT NULL DEFAULT 0,
    is_mandatory INTEGER DEFAULT 0, sort_order INTEGER DEFAULT 0)""")
cur.execute("""CREATE TABLE IF NOT EXISTS book_orders (
    id INTEGER PRIMARY KEY, year_label TEXT NOT NULL, student_id INTEGER NOT NULL,
    catalog_id INTEGER NOT NULL, ordered INTEGER DEFAULT 1, created_at TEXT,
    UNIQUE(year_label, student_id, catalog_id))""")
cur.execute("""CREATE TABLE IF NOT EXISTS book_prices (
    id INTEGER PRIMARY KEY, item_name TEXT NOT NULL UNIQUE, publisher TEXT,
    price REAL NOT NULL DEFAULT 0, notes TEXT, updated_at TEXT)""")
cur.execute("""CREATE TABLE IF NOT EXISTS book_order_extras (
    id INTEGER PRIMARY KEY, year_label TEXT NOT NULL, student_id INTEGER NOT NULL,
    item_name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT)""")
try:
    cur.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_book_prices_name ON book_prices(item_name)")
except: pass

# ===== מחירון — הכנסה/עדכון =====
now = __import__('datetime').datetime.now().isoformat()
for (item_name, publisher, price) in PRICES:
    cur.execute("""INSERT INTO book_prices (item_name, publisher, price, updated_at)
        VALUES (?,?,?,?) ON CONFLICT(item_name) DO UPDATE SET price=excluded.price, updated_at=excluded.updated_at""",
        (item_name, publisher, price, now))
print(f"מחירון: {len(PRICES)} פריטים עודכנו")

# ===== קטלוג לפי שנה =====
existing = cur.execute("SELECT COUNT(*) FROM book_catalog WHERE year_label=?", (YEAR,)).fetchone()[0]
if existing > 0:
    print(f"קטלוג לשנת {YEAR} כבר קיים ({existing} פריטים) — מדלג")
    conn.commit(); conn.close(); exit(0)

total = 0
for class_name, items in CATALOG.items():
    for i, (item_name, publisher, price, is_mandatory) in enumerate(items):
        cur.execute(
            "INSERT INTO book_catalog (year_label, class_name, item_name, publisher, price, is_mandatory, sort_order) VALUES (?,?,?,?,?,?,?)",
            (YEAR, class_name, item_name, publisher, price, is_mandatory, i))
        total += 1

conn.commit(); conn.close()
print(f"קטלוג ספרים לשנת {YEAR} נוצר: {total} פריטים ב-{len(CATALOG)} כיתות")
