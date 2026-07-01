#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ייבוא מלא מהמסד נתונים האמיתי (תלמוד תורה החדש מסד נתונים.accdb)
כולל: תלמידים, הורים, סבים, מלמדים, שיבוץ לכתות, כתות, מחזורים,
קטגוריות שכר לימוד, הנחות, חסידויות, ישיבות, תיק תלמיד, אנשי קשר לחירום
"""
import csv
import sqlite3
import os
import sys

csv.field_size_limit(sys.maxsize)

EXPORT_DIR = "/home/claude/export2"
DB_PATH = "/home/claude/app/server/data/talmud-tora.db"

os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
if os.path.exists(DB_PATH):
    os.remove(DB_PATH)

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

cur.executescript("""
CREATE TABLE chassidut (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE yeshivot (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE discount_types (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, price REAL);
CREATE TABLE cohorts (
    id INTEGER PRIMARY KEY, name TEXT, from_date INTEGER, to_date INTEGER, status TEXT
);
CREATE TABLE age_groups (
    id INTEGER PRIMARY KEY, name TEXT, from_date INTEGER, to_date INTEGER
);
CREATE TABLE classes (
    id INTEGER PRIMARY KEY, name TEXT, parallel TEXT, class_number TEXT,
    transfer_number TEXT, status TEXT, category_id INTEGER, branch TEXT,
    FOREIGN KEY(category_id) REFERENCES categories(id)
);
CREATE TABLE grandparents (id INTEGER PRIMARY KEY, name TEXT, address TEXT, city TEXT);

CREATE TABLE families (
    id INTEGER PRIMARY KEY,
    last_name TEXT,
    sector TEXT,
    father_name TEXT, father_id_number TEXT, father_email TEXT,
    mother_name TEXT, mother_id_number TEXT, mother_email TEXT,
    home_phone TEXT, father_mobile TEXT, mother_mobile TEXT,
    father_workplace TEXT, father_work_phone TEXT,
    mother_workplace TEXT, mother_work_phone TEXT,
    street TEXT, house_number TEXT, apartment TEXT, city TEXT, zip_code TEXT,
    notes TEXT,
    graduate_of_yeshiva_id INTEGER,
    paternal_grandparents TEXT, paternal_grandparents_address TEXT,
    maternal_grandparents TEXT, maternal_grandparents_address TEXT,
    graduate_cohort TEXT, donation TEXT,
    paternal_grandparent_id INTEGER, maternal_grandparent_id INTEGER,
    FOREIGN KEY(graduate_of_yeshiva_id) REFERENCES yeshivot(id),
    FOREIGN KEY(paternal_grandparent_id) REFERENCES grandparents(id),
    FOREIGN KEY(maternal_grandparent_id) REFERENCES grandparents(id)
);

CREATE TABLE students (
    id INTEGER PRIMARY KEY,
    last_name TEXT, first_name TEXT, nickname TEXT,
    class_id INTEGER,
    birth_date_civil INTEGER,
    id_number TEXT,
    notes TEXT,
    allergies TEXT, medications TEXT, walks_alone TEXT, health_fund TEXT,
    family_id INTEGER,
    status TEXT,
    cohort_id INTEGER,
    entry_date INTEGER, update_date INTEGER, exit_date INTEGER, addition_date INTEGER,
    registration_date INTEGER, admission_date INTEGER,
    FOREIGN KEY(class_id) REFERENCES classes(id),
    FOREIGN KEY(family_id) REFERENCES families(id),
    FOREIGN KEY(cohort_id) REFERENCES cohorts(id)
);

CREATE TABLE teachers (
    id INTEGER PRIMARY KEY,
    last_name TEXT, first_name TEXT, id_number TEXT,
    birth_date_civil INTEGER,
    street TEXT, house_number TEXT, apartment TEXT, city TEXT, zip_code TEXT,
    home_phone TEXT, mobile TEXT,
    chassidut_id INTEGER,
    notes TEXT, status TEXT,
    entry_date INTEGER, update_date INTEGER, exit_date INTEGER,
    children_count INTEGER,
    FOREIGN KEY(chassidut_id) REFERENCES chassidut(id)
);

CREATE TABLE teacher_classes (
    id INTEGER PRIMARY KEY,
    class_id INTEGER, teacher_id INTEGER, role TEXT,
    FOREIGN KEY(class_id) REFERENCES classes(id),
    FOREIGN KEY(teacher_id) REFERENCES teachers(id)
);

CREATE TABLE discounts (
    id INTEGER PRIMARY KEY,
    siblings_count INTEGER, discount_type_id INTEGER, discount_type_name TEXT, amount REAL,
    FOREIGN KEY(discount_type_id) REFERENCES discount_types(id)
);

CREATE TABLE student_file (
    id INTEGER PRIMARY KEY,
    student_id INTEGER, class_name_at_time TEXT, entry_date INTEGER, notes TEXT,
    FOREIGN KEY(student_id) REFERENCES students(id)
);

CREATE TABLE emergency_contacts (
    id INTEGER PRIMARY KEY,
    family_id INTEGER,
    contact_name TEXT, phone1 TEXT, phone2 TEXT, relation TEXT,
    FOREIGN KEY(family_id) REFERENCES families(id)
);

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    password_hash TEXT,
    display_name TEXT,
    full_name TEXT,
    role_title TEXT,
    phone TEXT,
    email TEXT,
    is_admin INTEGER DEFAULT 0,
    force_password_change INTEGER DEFAULT 0,
    created_at TEXT
);

CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    title TEXT,
    notes TEXT,
    due_date INTEGER,
    done INTEGER DEFAULT 0,
    created_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    sender_id INTEGER,
    recipient_id INTEGER,
    body TEXT,
    created_at TEXT,
    read_at TEXT,
    FOREIGN KEY(sender_id) REFERENCES users(id),
    FOREIGN KEY(recipient_id) REFERENCES users(id)
);

CREATE TABLE user_presence (
    user_id INTEGER PRIMARY KEY,
    last_seen TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE year_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year_label TEXT,
    created_at TEXT,
    data TEXT
);

CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY,
    name TEXT,
    category TEXT,
    contact_person TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    notes TEXT,
    status TEXT,
    created_at TEXT
);

-- ניהול כוח אדם
CREATE TABLE teacher_attendance (
    id INTEGER PRIMARY KEY,
    teacher_id INTEGER,
    att_date INTEGER,
    status TEXT,
    notes TEXT,
    FOREIGN KEY(teacher_id) REFERENCES teachers(id)
);

CREATE TABLE teacher_file (
    id INTEGER PRIMARY KEY,
    teacher_id INTEGER,
    entry_date INTEGER,
    category TEXT,
    notes TEXT,
    FOREIGN KEY(teacher_id) REFERENCES teachers(id)
);

-- תקשורת הורים ופניות
CREATE TABLE parent_requests (
    id INTEGER PRIMARY KEY,
    family_id INTEGER,
    student_id INTEGER,
    subject TEXT,
    body TEXT,
    status TEXT,
    response TEXT,
    created_at TEXT,
    resolved_at TEXT,
    handled_by_user_id INTEGER,
    FOREIGN KEY(family_id) REFERENCES families(id),
    FOREIGN KEY(student_id) REFERENCES students(id)
);

-- אירועים ולוח שנה
CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    title TEXT,
    description TEXT,
    event_date INTEGER,
    event_date_end INTEGER,
    category TEXT,
    class_id INTEGER,
    requires_registration INTEGER DEFAULT 0,
    price REAL,
    created_at TEXT,
    FOREIGN KEY(class_id) REFERENCES classes(id)
);

CREATE TABLE event_registrations (
    id INTEGER PRIMARY KEY,
    event_id INTEGER,
    student_id INTEGER,
    paid INTEGER DEFAULT 0,
    notes TEXT,
    created_at TEXT,
    FOREIGN KEY(event_id) REFERENCES events(id),
    FOREIGN KEY(student_id) REFERENCES students(id)
);

-- מלאי וציוד
CREATE TABLE inventory_items (
    id INTEGER PRIMARY KEY,
    name TEXT,
    class_id INTEGER,
    location TEXT,
    quantity INTEGER,
    condition TEXT,
    notes TEXT,
    updated_at TEXT,
    FOREIGN KEY(class_id) REFERENCES classes(id)
);

CREATE TABLE maintenance_requests (
    id INTEGER PRIMARY KEY,
    description TEXT,
    class_id INTEGER,
    location TEXT,
    status TEXT,
    reported_by_user_id INTEGER,
    created_at TEXT,
    resolved_at TEXT,
    notes TEXT,
    FOREIGN KEY(class_id) REFERENCES classes(id)
);

-- הוצאות מול ספקים
CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    supplier_id INTEGER,
    description TEXT,
    amount REAL,
    expense_date INTEGER,
    category TEXT,
    paid INTEGER DEFAULT 0,
    invoice_number TEXT,
    notes TEXT,
    created_at TEXT,
    FOREIGN KEY(supplier_id) REFERENCES suppliers(id)
);

-- מחירון בסיס לספרים
CREATE TABLE book_prices (
    id INTEGER PRIMARY KEY,
    item_name TEXT NOT NULL,
    publisher TEXT,
    price REAL NOT NULL DEFAULT 0,
    notes TEXT,
    updated_at TEXT
);

-- הזמנות חידוש/נוספות לתלמיד (מחוץ לקטלוג הרגיל)
CREATE TABLE book_order_extras (
    id INTEGER PRIMARY KEY,
    year_label TEXT NOT NULL,
    student_id INTEGER NOT NULL,
    item_name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TEXT,
    FOREIGN KEY(student_id) REFERENCES students(id)
);
CREATE TABLE book_catalog (
    id INTEGER PRIMARY KEY,
    year_label TEXT NOT NULL,
    class_name TEXT NOT NULL,
    item_name TEXT NOT NULL,
    publisher TEXT,
    price REAL NOT NULL DEFAULT 0,
    is_mandatory INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE book_orders (
    id INTEGER PRIMARY KEY,
    year_label TEXT NOT NULL,
    student_id INTEGER NOT NULL,
    catalog_id INTEGER NOT NULL,
    ordered INTEGER DEFAULT 1,
    created_at TEXT,
    FOREIGN KEY(student_id) REFERENCES students(id),
    FOREIGN KEY(catalog_id) REFERENCES book_catalog(id),
    UNIQUE(year_label, student_id, catalog_id)
);

CREATE INDEX idx_book_orders_student ON book_orders(student_id, year_label);
CREATE INDEX idx_book_catalog_year_class ON book_catalog(year_label, class_name);
CREATE INDEX idx_students_class ON students(class_id);
CREATE INDEX idx_students_cohort ON students(cohort_id);
CREATE INDEX idx_students_name ON students(last_name, first_name);
CREATE INDEX idx_contacts_family ON emergency_contacts(family_id);
CREATE INDEX idx_teacherclasses_class ON teacher_classes(class_id);
CREATE INDEX idx_teacherclasses_teacher ON teacher_classes(teacher_id);
CREATE INDEX idx_studentfile_student ON student_file(student_id);
""")


def load(fname):
    with open(os.path.join(EXPORT_DIR, fname), encoding="utf-8") as f:
        return list(csv.DictReader(f))


def val(row, key):
    v = row.get(key, "")
    if v is None or str(v).strip() == "":
        return None
    return str(v).strip()


def ival(row, key):
    v = val(row, key)
    if v is None:
        return None
    try:
        return int(float(v))
    except ValueError:
        return None


def fval(row, key):
    v = val(row, key)
    if v is None:
        return None
    try:
        return float(v)
    except ValueError:
        return None


counts = {}

# --- טבלאות עזר (lookup) ---
for fname, table, col in [
    ("חסידי.csv", "chassidut", "חסידי"),
    ("ישיבות.csv", "yeshivot", "ישיבה"),
    ("סוג הנחה.csv", "discount_types", "סוג"),
]:
    rows = load(fname)
    for r in rows:
        cur.execute(f"INSERT INTO {table} (id, name) VALUES (?,?)", (ival(r, "מזהה"), val(r, col)))
    counts[table] = len(rows)

rows = load("קטגוריות.csv")
for r in rows:
    cur.execute("INSERT INTO categories (id, name, price) VALUES (?,?,?)",
                (ival(r, "מזהה"), val(r, "קטגוריה"), fval(r, "מחיר")))
counts["categories"] = len(rows)

rows = load("מחזורים.csv")
for r in rows:
    cur.execute("INSERT INTO cohorts (id, name, from_date, to_date, status) VALUES (?,?,?,?,?)",
                (ival(r, "מזהה"), val(r, "מחזור"), ival(r, "מ"), ival(r, "עד"), val(r, "סטטוס")))
counts["cohorts"] = len(rows)

rows = load("שנתונים.csv")
for r in rows:
    cur.execute("INSERT INTO age_groups (id, name, from_date, to_date) VALUES (?,?,?,?)",
                (ival(r, "מזהה"), val(r, "שנתון"), ival(r, "מ"), ival(r, "עד")))
counts["age_groups"] = len(rows)

rows = load("כתות.csv")
for r in rows:
    cur.execute(
        "INSERT INTO classes (id, name, parallel, class_number, transfer_number, status, category_id) VALUES (?,?,?,?,?,?,?)",
        (ival(r, "מזהה"), val(r, "כתה"), val(r, "מקבילה"), val(r, "מספר כתה"),
         val(r, "מספר להעברה"), val(r, "סטטוס"), ival(r, "קטגוריה")),
    )
counts["classes"] = len(rows)

rows = load("סבים.csv")
for r in rows:
    cur.execute("INSERT INTO grandparents (id, name, address, city) VALUES (?,?,?,?)",
                (ival(r, "קוד_סב"), val(r, "שם"), val(r, "כתובת"), val(r, "עיר")))
counts["grandparents"] = len(rows)

rows = load("הורים.csv")
for r in rows:
    cur.execute(
        """INSERT INTO families (
            id, last_name, father_name, father_id_number, mother_name, mother_id_number,
            home_phone, father_mobile, mother_mobile, father_workplace, father_work_phone,
            mother_workplace, mother_work_phone, street, house_number, apartment, city, zip_code,
            notes, graduate_of_yeshiva_id, paternal_grandparents, paternal_grandparents_address,
            maternal_grandparents, maternal_grandparents_address, graduate_cohort, donation,
            paternal_grandparent_id, maternal_grandparent_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            ival(r, "מזהה"), val(r, "\u200f\u200fשם משפחה"), val(r, "\u200f\u200fשם האב"), val(r, "זהות אב"),
            val(r, "שם האם"), val(r, "זהות אם"), val(r, "\u200f\u200fטלפון בבית"), val(r, "נייד אב"),
            val(r, "נייד אם"), val(r, "מקום עבודת האב"), val(r, "טלפון בעבודת האב"),
            val(r, "מקום עבודת האם"), val(r, "טלפון בעבודת האם"), val(r, "רחוב"), val(r, "מספר"),
            val(r, "דירה"), val(r, "עיר"), val(r, "מיקוד"), val(r, "הערות"), ival(r, "בוגר ישיבת"),
            val(r, "הורי האב"), val(r, "כתובת הורי האב"), val(r, "הורי האם"), val(r, "כתובת הורי האם"),
            val(r, "בוגר מחזור"), val(r, "תרומה"), ival(r, "קוד_סב_אבא"), ival(r, "קוד_סב_אמא"),
        ),
    )
counts["families"] = len(rows)

rows = load("תלמידים.csv")
for r in rows:
    cur.execute(
        """INSERT INTO students (
            id, last_name, first_name, nickname, class_id, birth_date_civil, id_number, notes,
            allergies, medications, walks_alone, health_fund, family_id, status, cohort_id,
            entry_date, update_date, exit_date, addition_date, registration_date, admission_date
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            ival(r, "מזהה"), val(r, "\u200f\u200fמשפחה"), val(r, "\u200f\u200fפרטי"), val(r, "חיבה"),
            ival(r, "כתה"), ival(r, "לידה לועזי"), val(r, "מספר זהות"), val(r, "הערות"),
            val(r, "אלרגיות"), val(r, "תרופות"), val(r, "הולך לבדו"), val(r, "קופת חולים"),
            ival(r, "הורים"), val(r, "סטטוס"), ival(r, "מחזור"),
            ival(r, "כניסה"), ival(r, "עדכון"), ival(r, "יציאה"), ival(r, "תוספת"),
            ival(r, "תאריך רישום"), ival(r, "תאריך קבלה"),
        ),
    )
counts["students"] = len(rows)

rows = load("מלמדים.csv")
for r in rows:
    cur.execute(
        """INSERT INTO teachers (
            id, last_name, first_name, id_number, birth_date_civil, street, house_number,
            apartment, city, zip_code, home_phone, mobile, chassidut_id, notes, status,
            entry_date, update_date, exit_date
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            ival(r, "מזהה"), val(r, "שם משפחה"), val(r, "שם פרטי"), val(r, "מספר זהות"),
            ival(r, "תאריך לידה לועזי"), val(r, "רחוב"), val(r, "מספר"), val(r, "דירה"),
            val(r, "עיר"), val(r, "מיקוד"), val(r, "טלפון בית"), val(r, "נייד"),
            ival(r, "חסידי"), val(r, "הערות"), val(r, "סטטוס"),
            ival(r, "תאריך כניסה"), ival(r, "תאריך עדכון"), ival(r, "תאריך יציאה"),
        ),
    )
counts["teachers"] = len(rows)

rows = load("מלמדים בכתות.csv")
for r in rows:
    cur.execute("INSERT INTO teacher_classes (id, class_id, teacher_id) VALUES (?,?,?)",
                (ival(r, "מזהה"), ival(r, "כתה"), ival(r, "מלמד")))
counts["teacher_classes"] = len(rows)

rows = load("הנחות.csv")
for r in rows:
    cur.execute(
        "INSERT INTO discounts (id, siblings_count, discount_type_id, discount_type_name, amount) VALUES (?,?,?,?,?)",
        (ival(r, "מזהה"), ival(r, "אחים"), ival(r, "סוג"), val(r, "סוג הנחה"), fval(r, "סכום")),
    )
counts["discounts"] = len(rows)

rows = load("תיק תלמיד.csv")
for r in rows:
    cur.execute(
        "INSERT INTO student_file (id, student_id, class_name_at_time, entry_date, notes) VALUES (?,?,?,?,?)",
        (ival(r, "מזהה"), ival(r, "תלמיד"), val(r, "כתה"), ival(r, "תאריך"), val(r, "הערות")),
    )
counts["student_file"] = len(rows)

rows = load("אנשי קשר לשעת חירום.csv")
for r in rows:
    cur.execute(
        "INSERT INTO emergency_contacts (id, family_id, contact_name, phone1, phone2, relation) VALUES (?,?,?,?,?,?)",
        (
            ival(r, "מזהה"), ival(r, "משפחה"), val(r, "שם איש קשר לשעת חירום"),
            val(r, "טלפון איש קשר לשעת חירום 1"), val(r, "טלפון איש קשר לשעת חירום 2"),
            val(r, "קרבת איש הקשר לשעת חירום"),
        ),
    )
counts["emergency_contacts"] = len(rows)

conn.commit()
conn.close()

print("ייבוא הושלם בהצלחה:")
for k, v in counts.items():
    print(f"  {k}: {v}")
print("->", DB_PATH)
