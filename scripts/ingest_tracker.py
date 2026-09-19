"""
Read the whole-school KPI curriculum coverage tracker into the registry's shape.

    python scripts/ingest_tracker.py "<path to the tracker .xlsx>" --out supabase/seed

The school keeps two records of what it teaches and they do not overlap. The
curriculum overviews (scripts/ingest_overviews.py) are per year group and cover
Early Years to A Level; the tracker is per *class stream* and covers CP5 to A2 and
the Lower Secondary years only, but for those it was filled in by the teachers
themselves. Neither is complete. So this reads the tracker and the loader writes
only into weeks the overviews left empty.

What it is not is a second opinion. Where both hold objectives for the same week,
the loader reports the disagreement to the head of department and writes nothing;
picking a winner here is exactly the confident wrongness the sign-off gate exists
to catch.

Emits supabase/seed/tracker_curriculum.json and tracker_report.json. Writes to no
database - scripts/load_tracker.mjs does that, and only with --write.
"""
import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit('openpyxl is needed to read the tracker: pip install openpyxl')

# The nine department sheets. The others - Dashboard, Teachers, Objectives Audit -
# are summaries built from these with formulas, and hold no curriculum of their own.
DEPARTMENTS = [
    'Mathematics', 'Science', 'ICT', 'English', 'Expressive Arts',
    'Foreign Languages', 'Physical Education',
    'Humanities and Social Sciences', 'Business',
]

# Columns, by position. The header row is row 4 and every department sheet shares it:
# Subject | Section | Level | Class | Term | Week | Unit No. | Syllabus Code | Topic |
# Sub-topic | Learning Objectives | Teacher | ...
SUBJECT, SECTION, LEVEL, CLASS, TERM, WEEK, UNIT, CODE, TOPIC, SUBTOPIC, OBJECTIVES = range(11)
FIRST_ROW = 5

# The tracker's subject names against the ids in the `subject` table. The names on
# the two sides genuinely differ - the tracker writes ampersands where
# ingest_overviews.py emits 'and' - so this maps to the id and the loader never has
# to match a name.
SUBJECT_ID = {
    'Accounting': 'ACC', 'Art & Design': 'ART', 'Biology': 'BIO',
    'Business Studies': 'BUS', 'Chemistry': 'CHEM', 'Economics': 'ECON',
    'English': 'ENG', 'English Literature': 'ENGLIT', 'French': 'FR',
    'Geography': 'GEOG', 'Global Perspectives': 'GP', 'History': 'HIST',
    'ICT': 'ICT', 'Information Technology': 'IT', 'Mathematics': 'MATH',
    'Music': 'MUS', 'Music, Dance & Drama': 'MDD', 'PE Tennis': 'TEN',
    'Physical Education': 'PE', 'Physics': 'PHYS', 'Reading': 'READ',
    'Science': 'SCI',
}

# The tracker's Level column against the registry's year_group. Only three differ;
# CP5, CP6, LS1-3 and AS are written the same way in both.
YEAR_GROUP = {'IG1': 'IGCSE 1', 'IG2': 'IGCSE 2', 'A2': 'A Level'}

# A Cambridge objective code: 5Nc.01, 7CT.04, 4SLp.02. The same expression
# ingest_overviews.py uses, including the two-capital strand that CP4 English needs.
#
# The optional 'LO' in front of it is the tracker's own habit - 'LO 7Ra.01 - Enjoy
# reading ... LO 7Wp.01 - Sustain a fast ...'. It is part of the boundary rather than
# part of the objective, and leaving it out of the match stranded it on the end of
# the objective before ('... a wide range of texts. LO').
REF = re.compile(r'(?:\bL\.?O\.?[:\s]*)?\b(\d{1,2}[A-Z]{1,2}[a-z]{0,2}\.\d{2})\b')

# Bullets the tracker writes objectives with, on one line rather than one per line.
BULLET = re.compile(r'[●○•▪·‣⁃]+')

# Punctuation and dashes left at either end of an objective by wherever it was cut.
TRIM = ' .;:,–—-\n\t●•'

# Shorter than this and it is a fragment left over from a split, not an objective.
MIN_OBJECTIVE = 12


def split_objectives(cell):
    """One cell of objectives into the registry's [{ref, text}].

    The tracker runs its objectives together on one line - '5Nc.01 Count on and
    count back ... 5Nc.02 Recognise the use of objects ...' - rather than one per
    line as the overviews do. So where the cell carries codes, the codes are the
    boundaries; where it carries none, the lines are, and a cell with neither is one
    objective written as a paragraph.
    """
    text = str(cell).replace('\r', '\n').strip()
    if not text:
        return []

    marks = list(REF.finditer(text))
    if marks:
        out = []
        # Anything before the first code is a preamble, not an objective. Each
        # objective runs from the end of its own code to the start of the next
        # code's lead-in, which is m.start() rather than the code itself.
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
            body = text[m.end():end].strip(TRIM)
            if len(body) >= MIN_OBJECTIVE:
                out.append({'ref': m.group(1), 'text': body})
        if out:
            return out

    # No codes, so the writer's own punctuation is the boundary: a bulleted list run
    # together on one line is still a list, and treating it as one objective put a
    # week's whole curriculum into a single sentence.
    parts = [p for chunk in text.split('\n') for p in BULLET.split(chunk)]
    parts = [p.strip(TRIM) for p in parts]
    parts = [p for p in parts if len(p) >= MIN_OBJECTIVE]
    if len(parts) > 1:
        return [{'ref': None, 'text': p} for p in parts]
    return [{'ref': None, 'text': parts[0]}] if parts else []


def week_of(term, week, term3_offset):
    """The tracker's (term, week) as the registry's (semester, week_number).

    The school runs three terms and the database holds two semesters, and week
    numbers restart in both - so terms 2 and 3 are both semester 2 and their week
    numbers collide head-on. Term 3's weeks are shifted past Term 2's by the number
    of semester-2 weeks that come before Term 3 starts, which is read from the
    calendar rather than written down here: a calendar that changes must not need
    this file changed with it.
    """
    if term == 1:
        return 1, week
    if term == 2:
        return 2, week
    return 2, week + term3_offset


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tracker')
    ap.add_argument('--out', default='supabase/seed')
    ap.add_argument('--year', default=None, help='academic year id; default: the calendar\'s')
    args = ap.parse_args()

    out = Path(args.out)
    calendar = json.loads((out / 'calendar.json').read_text(encoding='utf-8'))
    year = args.year or calendar['academic_year']

    last_week = {}
    for w in calendar['weeks']:
        last_week[w['semester']] = max(last_week.get(w['semester'], 0), w['week'])

    term3 = next((t for t in calendar.get('terms', []) if t['term'] == 3), None)
    if not term3:
        sys.exit('the calendar holds no term 3, so term 3 weeks cannot be placed')
    after = [w for w in calendar['weeks']
             if w['semester'] == term3['semester'] and w['commencing'] >= term3['starts_on']]
    if not after:
        sys.exit('no semester week commences on or after term 3 starts')
    term3_offset = min(w['week'] for w in after) - 1

    wb = openpyxl.load_workbook(args.tracker, read_only=True, data_only=True)

    rows = {}
    skipped = Counter()
    unknown_subjects = Counter()

    for sheet in DEPARTMENTS:
        if sheet not in wb.sheetnames:
            skipped['missing_sheet'] += 1
            continue
        for r in wb[sheet].iter_rows(min_row=FIRST_ROW, values_only=True):
            if not r or not r[SUBJECT]:
                continue

            subject_id = SUBJECT_ID.get(str(r[SUBJECT]).strip())
            if not subject_id:
                unknown_subjects[str(r[SUBJECT]).strip()] += 1
                continue

            objectives = split_objectives(r[OBJECTIVES]) if r[OBJECTIVES] else []
            if not objectives:
                skipped['no_objectives'] += 1
                continue

            try:
                term = int(str(r[TERM]).strip().split()[-1])
                week = int(r[WEEK])
            except (TypeError, ValueError, IndexError):
                skipped['unreadable_week'] += 1
                continue

            level = str(r[LEVEL]).strip()
            year_group = YEAR_GROUP.get(level, level)
            semester, week_number = week_of(term, week, term3_offset)
            if week_number > last_week.get(semester, 0):
                skipped['past_calendar'] += 1
                continue

            # The registry is keyed by year group, not by class stream, so CP5A and
            # CP5B teaching the same subject are one row. They are the same course;
            # where the two streams were filled in differently the objectives are
            # merged and the disagreement, if any, is one for the head of department.
            key = (year_group, subject_id, semester, week_number)
            row = rows.get(key)
            if not row:
                rows[key] = {
                    'academic_year': year,
                    'year_group': year_group,
                    'subject_id': subject_id,
                    'semester': semester,
                    'week': week_number,
                    'topic_label': str(r[TOPIC]).strip() if r[TOPIC] else '',
                    'objectives': objectives,
                    'streams': [str(r[CLASS]).strip()] if r[CLASS] else [],
                    'source_file': Path(args.tracker).name,
                }
                continue

            seen = {(o['ref'] or '') + '|' + o['text'] for o in row['objectives']}
            for o in objectives:
                if (o['ref'] or '') + '|' + o['text'] not in seen:
                    row['objectives'].append(o)
            if r[CLASS] and str(r[CLASS]).strip() not in row['streams']:
                row['streams'].append(str(r[CLASS]).strip())
            if not row['topic_label'] and r[TOPIC]:
                row['topic_label'] = str(r[TOPIC]).strip()

    registry = sorted(rows.values(),
                      key=lambda w: (w['subject_id'], w['year_group'], w['semester'], w['week']))

    out.mkdir(parents=True, exist_ok=True)
    (out / 'tracker_curriculum.json').write_text(
        json.dumps(registry, indent=1, ensure_ascii=False), encoding='utf-8')

    by_semester = Counter(w['semester'] for w in registry)
    coded = sum(1 for w in registry if any(o['ref'] for o in w['objectives']))
    report = {
        'source': str(args.tracker),
        'academic_year': year,
        'term3_week_offset': term3_offset,
        'weeks_emitted': len(registry),
        'weeks_with_syllabus_refs': coded,
        'objectives_emitted': sum(len(w['objectives']) for w in registry),
        'weeks_per_semester': dict(sorted(by_semester.items())),
        'skipped': dict(skipped),
        'unknown_subjects': dict(unknown_subjects),
    }
    (out / 'tracker_report.json').write_text(
        json.dumps(report, indent=1, ensure_ascii=False), encoding='utf-8')

    print(f'{len(registry)} weeks, {report["objectives_emitted"]} objectives, '
          f'{coded} weeks carrying references')
    print(f'  semesters: {dict(sorted(by_semester.items()))}, term 3 shifted by {term3_offset}')
    for reason, n in skipped.items():
        print(f'  ! {n} rows skipped: {reason}')
    for name, n in unknown_subjects.items():
        print(f'  ! {n} rows for "{name}" - no id in SUBJECT_ID')
    print(f'written to {out / "tracker_curriculum.json"}')


if __name__ == '__main__':
    main()
