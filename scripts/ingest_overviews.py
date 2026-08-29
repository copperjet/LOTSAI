#!/usr/bin/env python3
"""
Curriculum ingestion — Addendum C Section C7.

Reads the school's own Curriculum Overview documents and emits:
  - seed/curriculum.json        rows ready for the curriculum_week table
  - seed/readiness_report.json  what could not be imported, and why

Rules this script enforces, from the spec:
  * Where a .docx and a .pdf claim the same subject/year/semester, the .docx wins.
  * Syllabus references are extracted by pattern. They are never inferred.
    A row with no reference imports as topic-only and is flagged for the HOD.
  * Files labelled with a previous academic year are excluded and reported.
  * Duplicates are reported for a human decision. The script never guesses.
  * Week labels are normalised to the Monday of that school week.

Usage:
    python scripts/ingest_overviews.py "../CURRICULUM OVERVIEWS" --year 2026-27
"""

import argparse, json, re, sys
from pathlib import Path
from collections import defaultdict

try:
    from docx import Document
except ImportError:
    sys.exit("pip install python-docx")

# Cambridge references: 4Np.01, 9E.02, 4Gt.04, 6Ni.07 ...
REF = re.compile(r'\b(\d{1,2}[A-Z][a-z]{0,2}\.\d{2})\b')

WORD_NUM = {'one':1,'two':2,'three':3,'four':4,'five':5,'six':6,'seven':7,'eight':8,
            'nine':9,'ten':10,'eleven':11,'twelve':12,'thirteen':13,'fourteen':14,'fifteen':15}

YEAR_GROUPS = ['CP1','CP2','CP3','CP4','CP5','CP6','LS1','LS2','LS3',
               'IGCSE 1','IGCSE 2','AS Level','A Level','AS','EY1','EY2','EY3','Acorns']

SUBJECT_HINTS = {
    'MATH':'Mathematics', 'MATHEMATIC':'Mathematics', 'ENGLISH':'English',
    'SCIENCE':'Science', 'COMPUTING':'Computing', 'ICT':'ICT',
    'GLOBAL PERSPECTIVE':'Global Perspectives', 'G.P':'Global Perspectives', 'GP ':'Global Perspectives',
    'FRENCH':'French', 'ART':'Art and Design', 'MDD':'Music, Dance and Drama',
    'P.E':'Physical Education', 'PHYSICAL EDUCATION':'Physical Education', 'PE ':'Physical Education',
}

# Semester 1 2026/27, Mondays. The calendar is the single source of truth
# (Addendum A Section A9) — overview dates are matched to it, never the reverse.
WEEK_MONDAYS = {
    1:'2026-08-24',  2:'2026-08-31',  3:'2026-09-07',  4:'2026-09-14',  5:'2026-09-21',
    6:'2026-09-28',  7:'2026-10-05',  8:'2026-10-12',  9:'2026-10-26', 10:'2026-11-02',
    11:'2026-11-09', 12:'2026-11-16', 13:'2026-11-23', 14:'2026-11-30',
}
TEACHING_WEEKS = set(range(1, 12))   # 11 teaching weeks; 12 is revision, 13-14 exams


FOLDER_YEAR = {'ACORNS': 'Acorns', 'NURSERY': 'EY1', 'MIDDLE': 'EY2', 'RECEPTION': 'EY3',
               'A LEVEL': 'A Level', 'AS LEVEL': 'AS Level', 'IGCSE 1': 'IGCSE 1', 'IGCSE 2': 'IGCSE 2'}


def find_year(text: str):
    # lookahead, not a word boundary: "cp1OVER VIEW MDD" has no boundary after CP1
    flat = text.upper().replace('_', ' ').replace('CP ', 'CP')
    return next((y for y in YEAR_GROUPS
                 if re.search(rf'(?<![A-Z0-9]){re.escape(y)}(?![0-9])', flat)), None)


def classify(path: Path):
    """
    Infer year group, subject and semester. The filename is tried first; where it
    is silent the containing folder is used, because the folder tree is the one
    piece of structure the school has actually kept consistent.
    """
    name = path.stem.upper().replace('_', ' ')
    year = find_year(name)
    if not year:
        folder = path.parent.name.upper()
        year = next((v for k, v in FOLDER_YEAR.items() if k in folder), None) or find_year(folder)
    subject = next((v for k, v in SUBJECT_HINTS.items() if k in name), None)
    if not subject and year in ('Acorns', 'EY1', 'EY2', 'EY3'):
        subject = 'Early Years (integrated)'   # EY overviews are not split by subject
    if 'SEMESTER 2' in name or ' S2 ' in name or name.startswith('S2'):
        semester = 2
    elif 'ALL YEAR' in name:
        semester = 0                                  # both semesters in one file
    else:
        semester = 1
    prior_year = bool(re.search(r'202[0-5]\s*[-–]\s*202[0-6]', name)) and '2026' not in name.split('202')[-1]
    return year, subject, semester, prior_year


def week_number(cell: str):
    """'Week Three*  7th to 11th' -> 3"""
    t = cell.strip().lower()
    m = re.search(r'week\s*(\d{1,2})', t)
    if m:
        return int(m.group(1))
    m = re.search(r'week\s+([a-z]+)', t)
    if m and m.group(1) in WORD_NUM:
        return WORD_NUM[m.group(1)]
    return None


def split_objectives(text: str):
    """
    Return [{ref, text}]. A reference is copied verbatim when present.
    When absent the objective still imports — as topic-only, flagged.
    """
    body = re.split(r'\bResources\b', text, flags=re.I)[0]
    lines = [l.strip(' -•\t') for l in body.split('\n') if l.strip(' -•\t')]
    out = []
    for line in lines:
        if len(line) < 12:
            continue
        m = REF.search(line)
        out.append({'ref': m.group(1) if m else None,
                    'text': REF.sub('', line).strip(' .-') if m else line})
    return out


def header_map(table):
    """Find which column holds what. Overviews vary; the header row does not lie."""
    heads = [c.text.strip().lower() for c in table.rows[0].cells]
    if not any('week' in h for h in heads) and len(table.rows) > 1:
        heads = [c.text.strip().lower() for c in table.rows[1].cells]
        offset = 2
    else:
        offset = 1
    col = {}
    for i, h in enumerate(heads):
        if 'week' in h and 'week' not in col:              col['week'] = i
        elif 'objective' in h or 'topic' in h or 'unit' in h: col.setdefault('obj', i)
        elif 'activit' in h:                                col.setdefault('act', i)
        elif 'resource' in h:                               col.setdefault('res', i)
    return (col, offset) if 'week' in col and 'obj' in col else (None, offset)


def read_overview(path: Path):
    doc = Document(str(path))
    rows, notes = [], []
    for table in doc.tables:
        col, offset = header_map(table)
        if not col:
            continue
        for r in table.rows[offset:]:
            cells = [c.text.replace('\xa0', ' ').strip() for c in r.cells]
            if len(cells) <= max(col.values()):
                continue
            wk = week_number(cells[col['week']])
            if not wk:
                continue
            objs = split_objectives(cells[col['obj']])
            if not objs:
                continue
            topic = objs[0]['text'][:90] if objs[0]['ref'] is None else cells[col['obj']].split('\n')[0][:90]
            res = cells[col['res']].split('\n') if 'res' in col else []
            if 'res' not in col:                       # Science keeps resources inside the objectives cell
                tail = re.split(r'\bResources\b', cells[col['obj']], flags=re.I)
                res = tail[1].split('\n') if len(tail) > 1 else []
            rows.append({
                'week': wk,
                'week_commencing': WEEK_MONDAYS.get(wk),
                'is_teaching_week': wk in TEACHING_WEEKS,
                'topic_label': topic.strip(),
                'objectives': objs,
                'activities': [a.strip(' 0123456789.•') for a in cells[col['act']].split('\n') if a.strip()] if 'act' in col else [],
                'resources': [x.strip(' -•') for x in res if x.strip(' -•')],
            })
    if not rows:
        notes.append('no week table found — needs a human look')
    return rows, notes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    ap.add_argument('--year', default='2026-27')
    ap.add_argument('--out', default='supabase/seed')
    args = ap.parse_args()

    root, out = Path(args.root), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    claims = defaultdict(list)          # (year_group, subject, semester) -> [paths]
    excluded, unclassified = [], []

    for path in sorted(root.rglob('*')):
        if path.suffix.lower() not in ('.docx', '.pdf') or path.name.startswith('~$'):
            continue
        if 'delete' in path.stem.lower():
            excluded.append({'file': str(path.relative_to(root)), 'why': 'named DELETE'})
            continue
        yg, subj, sem, prior = classify(path)
        if prior:
            excluded.append({'file': str(path.relative_to(root)), 'why': 'labelled with a previous academic year'})
            continue
        if not yg or not subj:
            unclassified.append({'file': str(path.relative_to(root)),
                                 'why': f'could not read {"year group" if not yg else "subject"} from the filename'})
            continue
        claims[(yg, subj, sem)].append(path)

    weeks, conflicts, failed = [], [], []

    for (yg, subj, sem), paths in sorted(claims.items()):
        docx = [p for p in paths if p.suffix.lower() == '.docx']
        chosen = docx[0] if docx else paths[0]                 # docx wins over pdf
        if len(docx) > 1 or (not docx and len(paths) > 1):
            conflicts.append({'year_group': yg, 'subject': subj, 'semester': sem,
                              'files': [str(p.relative_to(root)) for p in paths],
                              'needs': 'HOD picks which file is current — the importer will not guess'})
            continue
        if chosen.suffix.lower() == '.pdf':
            failed.append({'year_group': yg, 'subject': subj, 'semester': sem,
                           'file': str(chosen.relative_to(root)),
                           'why': 'PDF only — no Word version to import from'})
            continue
        try:
            rows, notes = read_overview(chosen)
        except Exception as e:
            failed.append({'year_group': yg, 'subject': subj, 'semester': sem,
                           'file': str(chosen.relative_to(root)), 'why': f'{type(e).__name__}: {e}'})
            continue
        if not rows:
            failed.append({'year_group': yg, 'subject': subj, 'semester': sem,
                           'file': str(chosen.relative_to(root)), 'why': notes[0] if notes else 'no rows'})
            continue
        for r in rows:
            weeks.append({'academic_year': args.year, 'year_group': yg, 'subject': subj,
                          'semester': sem, 'source_file': str(chosen.relative_to(root)), **r})

    coded = [w for w in weeks if any(o['ref'] for o in w['objectives'])]
    report = {
        'academic_year': args.year,
        'summary': {
            'weeks_imported': len(weeks),
            'weeks_with_syllabus_refs': len(coded),
            'weeks_topic_only': len(weeks) - len(coded),
            'subjects_ready': len({(w['year_group'], w['subject'], w['semester']) for w in coded}),
            'duplicate_conflicts': len(conflicts),
            'excluded_files': len(excluded),
            'unreadable': len(failed),
            'unclassified_filenames': len(unclassified),
        },
        'blocking_hod_decision': conflicts,
        'excluded': excluded,
        'could_not_import': failed,
        'unclassified': unclassified,
    }

    (out / 'curriculum.json').write_text(json.dumps(weeks, indent=1), encoding='utf-8')
    (out / 'readiness_report.json').write_text(json.dumps(report, indent=1), encoding='utf-8')

    s = report['summary']
    print(f"imported {s['weeks_imported']} weeks "
          f"({s['weeks_with_syllabus_refs']} with syllabus refs, {s['weeks_topic_only']} topic-only)")
    print(f"{s['duplicate_conflicts']} duplicate conflicts need an HOD decision")
    print(f"{s['excluded_files']} excluded, {s['unreadable']} unreadable, {s['unclassified_filenames']} unclassified")
    print(f"-> {out/'curriculum.json'}\n-> {out/'readiness_report.json'}")


if __name__ == '__main__':
    main()
