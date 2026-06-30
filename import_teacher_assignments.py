#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ייבוא שיבוץ מלמדים מתוך 'שיבוץ_מלמדים_תשפ"ז.xlsx'
מעדכן: סניף לכל כיתה, ומשבץ מלמד בוקר / אחה"צ / עוזר (יוצר מלמד חדש אם לא קיים)
מריץ אחרי import_data.py
"""
import sqlite3
import json
import os
import re

DB_PATH = "/home/claude/app/server/data/talmud-tora.db"
DATA_PATH = "/home/claude/app/teacher_assignments_data.json"

with open(DATA_PATH, encoding="utf-8") as f:
    rows = json.load(f)

conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()


def parse_class_label(label):
    """'מכינה א'1' -> ('מכינה א'', '1'); 'א'1' -> ('כיתה א'', '1')"""
    m = re.match(r"^(.*?)(\d+)$", label.strip())
    if not m:
        return label.strip(), None
    base, parallel = m.group(1).strip(), m.group(2)
    if base.startswith("מכינה"):
        name = base
    else:
        name = "כיתה " + base
    return name, parallel


def find_or_create_teacher(full_name):
    if not full_name:
        return None
    full_name = full_name.strip()
    parts = full_name.split()
    last_name = parts[-1]
    first_name = " ".join(parts[:-1]) if len(parts) > 1 else full_name

    cur.execute(
        "SELECT id FROM teachers WHERE first_name = ? AND last_name = ?",
        (first_name, last_name),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        "INSERT INTO teachers (first_name, last_name, status) VALUES (?,?,?)",
        (first_name, last_name, "פעיל"),
    )
    return cur.lastrowid


def find_class(name, parallel):
    cur.execute(
        "SELECT id FROM classes WHERE name = ? AND parallel = ?",
        (name, parallel),
    )
    row = cur.fetchone()
    return row[0] if row else None


updated_branch = 0
assigned = 0
created_teachers = 0
unmatched_classes = []

cur.execute("SELECT COUNT(*) FROM teachers")
teachers_before = cur.fetchone()[0]

for branch, class_label, morning, afternoon, assistant in rows:
    name, parallel = parse_class_label(class_label)
    class_id = find_class(name, parallel)
    if not class_id:
        unmatched_classes.append((class_label, name, parallel))
        continue

    if branch:
        cur.execute("UPDATE classes SET branch = ? WHERE id = ?", (branch, class_id))
        updated_branch += 1

    # מנקה שיבוצים קודמים לכיתה זו לפני שיבוץ מחדש (כדי שלא יהיו כפילויות אם רצים שוב)
    cur.execute("DELETE FROM teacher_classes WHERE class_id = ?", (class_id,))

    for teacher_name, role in [(morning, "בוקר"), (afternoon, 'אחה"צ'), (assistant, "עוזר")]:
        if not teacher_name:
            continue
        teacher_id = find_or_create_teacher(teacher_name)
        cur.execute(
            "INSERT INTO teacher_classes (class_id, teacher_id, role) VALUES (?,?,?)",
            (class_id, teacher_id, role),
        )
        assigned += 1

cur.execute("SELECT COUNT(*) FROM teachers")
teachers_after = cur.fetchone()[0]
created_teachers = teachers_after - teachers_before

conn.commit()
conn.close()

print(f"סניפים עודכנו: {updated_branch} כיתות")
print(f"שיבוצים שנוצרו: {assigned}")
print(f"מלמדים חדשים שנוצרו: {created_teachers}")
if unmatched_classes:
    print("כיתות שלא נמצאה התאמה עבורן:")
    for c in unmatched_classes:
        print("  ", c)
print("הושלם ->", DB_PATH)
