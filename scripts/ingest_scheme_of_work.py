#!/usr/bin/env python3
"""
Cambridge schemes of work -> the per-objective activity bank.

    python scripts/ingest_scheme_of_work.py "<folder or file> ..." --out supabase/seed

The school's own overview says which objectives a week covers. Cambridge's scheme of
work says what to actually do with each objective - a suggested teaching activity, the
resources it needs, and a note about what learners should already know. LOTS AI's
planner has had a slot for exactly that since it was written (lib/planner.ts, "Suggested
activities from the overview") and almost nothing to put in it: 15 of 377 weeks. This
fills it from the documents the department already has.

Nothing here is mapped to a week, and nothing needs to be. The join is the objective:

  ref    0059 and 0860 attach activities to the objective code - 7CT.01 in the scheme
         of work is 7CT.01 in the school's LS1 overview, verbatim
  topic  0417 and 9626 have no objective codes; both they and the school's overviews
         organise by numbered syllabus topic - "4.1 Networks", "1.2 Quality of
         information"

So no one has to decide which unit falls in which week. The school's overview already
said, and this says what to teach when it gets there.

Read positionally rather than as tables. PyMuPDF's table finder recovers these pages
inconsistently - a 112 page scheme gives clean rows on one page, one merged cell on the
next - but the page layout itself is rigid: a header row names the columns, every column
keeps its x range down the whole document, and an entry runs from one key in the left
column to the next. So the columns are found once from the header words, and blocks are
assigned to them by where they sit.

Writes seed/scheme_of_work.json and seed/scheme_of_work_report.json. Loads nothing.
"""

import argparse, json, re, sys
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError:
    sys.exit('pip install pymupdf')

# Same pattern the overview importer uses, and it has to stay the same: a key written
# one way here and another way there is a bank nothing can look up.
REF = re.compile(r'\b(\d{1,2}[A-Z]{1,2}[a-z]{0,2}\.\d{2})\b')

# "4.1 Networks", "1.2 Quality of information", "17. Document production" - a numbered
# syllabus topic wherever it appears in the key column, not only at the head of a cell.
# 0417 runs two of them into one block ("13.2 Tables 17. Document production"), and a
# leading-only match dropped the second: topics 3, 17 and 19 were cited by the school's
# own IGCSE overviews and had nothing in the bank behind them.
#
# The trailing lookahead is what keeps it honest. A number is a topic here only when a
# capitalised word follows it, which is true of every heading in these documents and
# false of a figure inside a sentence.
TOPIC = re.compile(r'(?:^|\s)(\d{1,2}\.\d{1,2}|\d{1,2}\.)(?=\s+[A-Z])')

# The code is in the filename on every one of these documents, and it is the one thing
# that says which syllabus the activities belong to.
CODE = re.compile(r'\b(0059|0860|0417|9626)\b')

# Which key each syllabus is written against. Mirrors subject_curriculum.joins_on in
# migration 0021 - the same fact, and it has to agree.
KEY_KIND = {'0059': 'ref', '0860': 'ref', '0417': 'topic', '9626': 'topic'}

SYLLABUS = {
    '0059': 'Cambridge Primary Computing 0059',
    '0860': 'Cambridge Lower Secondary Computing 0860',
    '0417': 'Cambridge IGCSE Information and Communication Technology 0417',
    '9626': 'Cambridge International AS & A Level Information Technology 9626',
}

# The column headings these documents use, and what each column is for. Matched against
# the run of words on the header line, lower-cased.
HEADINGS = [
    ('syllabus ref',        'key'),
    ('key concepts',        'skip'),
    ('learning objectives', 'objectives'),
    ('suggested teaching',  'activities'),
    ('additional notes',    'notes'),
]

STAGE = re.compile(r'\bstage\s*(\d{1,2})\b', re.I)

# How far below the last activity line a key has to sit before it counts as a new
# table row rather than another objective of the current one.
#
# Measured off the documents. Stage 7 page 15 puts 7CT.04 at y254, 7CT.05 at y323 and
# 7CT.09 at y367, threaded down the left of one activity sequence running y254 to
# y455 - within a row a key is never more than a line or two below the activity above
# it. A new row starts after that cell ends, which is a wider gap. Points, at 72 to
# the inch, so a little under half a centimetre.
ROW_GAP = 30


def columns(page):
    """
    Where each column starts, and what it holds, from the header line.

    Returns ([(x_start, role), ...], header_y), or None on a page with no header. The
    header repeats on every content page of these documents, so the first layout that
    parses is used for the whole file and pages that lack it inherit it - but the y is
    read per page, because that line is itself a block and everything at or above it is
    furniture rather than content.
    """
    words = page.get_text('words')          # (x0, y0, x1, y1, word, ...)
    if not words:
        return None
    line_y = min((w[1] for w in words if w[4].lower().startswith('objective')), default=None)
    if line_y is None:
        return None
    band = sorted((w for w in words if abs(w[1] - line_y) < 4), key=lambda w: w[0])

    found = []
    text = ' '.join(w[4] for w in band).lower()
    for phrase, role in HEADINGS:
        at = text.find(phrase)
        if at < 0:
            continue
        # Which word the phrase starts on, so the x is the real one rather than measured
        # from a character offset.
        before = text[:at].split()
        if len(before) < len(band):
            found.append((band[len(before)][0], role))
    if not found:
        return None
    found.sort()

    # A column the header does not name. 9626 heads only Learning objectives and
    # Suggested teaching activities, and puts the syllabus ref and key concepts in an
    # unlabelled column to their left - which is the column the key lives in, so it
    # cannot be the one that gets dropped.
    left = min(w[0] for w in words if w[1] > line_y)
    if found[0][0] - left > 20:
        found.insert(0, (left, 'key'))

    # 0059 and 0860 have no separate ref column: the code is the first thing in the
    # objectives cell, so that column is both.
    if not any(role == 'key' for _, role in found):
        found = [(x, 'key' if role == 'objectives' else role) for x, role in found]
    return found, line_y


def role_at(cols, x):
    """Which column an x sits in."""
    role = None
    for start, r in cols:
        if x >= start - 4:
            role = r
        else:
            break
    return role


def read_scheme(path: Path, code: str):
    """
    Every entry in one scheme of work, in document order.

    Read as rows, not as a running list of keys. Cambridge groups objectives that are
    taught together into one table row with one activities cell behind them - stage 7's
    row for 7CT.04, 7CT.05 and 7CT.09 is a single sequence of flowchart activities meant
    for all three. Attributing each activity block to whichever key was seen last put the
    whole of that cell under 7CT.09 and left the other two with the fragments that
    happened to sort above them.

    So a row is buffered: keys accumulate, then activities. The next key after an
    activity closes the row, and every key in it gets the row's activities. That is what
    the document says, and it is why one activity can appear under three objectives.
    """
    kind = KEY_KIND[code]
    pattern = REF if kind == 'ref' else TOPIC
    doc = fitz.open(path)

    stage = STAGE.search(path.stem)
    source = SYLLABUS[code] + (f' Stage {stage.group(1)}' if stage else '') + ' Scheme of Work'

    entries = []
    row = {'keys': [], 'activities': [], 'resources': [], 'notes': [], 'page': 1}
    # How far down the page the current row's activities cell reaches. A row's keys
    # sit beside that cell, not above it: stage 7 stacks 7CT.04, 7CT.05 and 7CT.09
    # down the left column while one activity sequence runs the whole height beside
    # them. In y order those interleave, so a key on its own cannot mean a new row -
    # a key still inside the activities it belongs to is part of the same row, and
    # only one below all of them starts the next.
    act_y = float('-inf')

    def flush():
        for key, text in row['keys']:
            entries.append({
                'syllabus_code': code, 'key_kind': kind, 'key': key,
                'objective_text': text.strip(' -.'),
                'activities': list(row['activities']),
                'resources': list(row['resources']),
                'notes': list(row['notes']),
                'source': source, 'source_page': row['page'],
            })
        row['keys'], row['activities'], row['resources'], row['notes'] = [], [], [], []

    cols = None
    for pno in range(doc.page_count):
        page = doc[pno]
        head = columns(page)
        if head:
            cols, header_y = head
        elif cols:
            header_y = None
        else:
            continue

        height = page.rect.height
        # Everything down to and including the header line is furniture: the running
        # title, and the header row itself. It is one block spanning the full width, so
        # left unskipped it lands in whichever column it starts in and is read as part
        # of an objective - "...presented as flowcharts Learning objectives Suggested
        # teaching activities and resources".
        top = (header_y + 6) if header_y is not None else 60
        blocks = []
        for b in page.get_text('blocks'):
            x0, y0, raw = b[0], b[1], b[4]
            text = ' '.join((raw or '').split())
            if not text or y0 < top or y0 > height - 45:
                continue
            blocks.append((y0, x0, text))
        blocks.sort()
        # A page break is a new visual frame: the first key on it starts a row.
        act_y = float('-inf')

        for y0, x0, text in blocks:
            role = role_at(cols, x0)
            if role in (None, 'skip'):
                continue

            if role == 'key':
                # Every key in the cell, not only the first. One block can carry two
                # headings - 0417 runs "13.2 Tables 17. Document production" together -
                # and the text between them belongs to the first.
                marks = list(pattern.finditer(text))
                if marks:
                    if y0 > act_y + ROW_GAP and (row['activities'] or row['resources'] or row['notes']):
                        flush()
                        act_y = float('-inf')
                    if not row['keys']:
                        row['page'] = pno + 1
                    for n, m in enumerate(marks):
                        stop = marks[n + 1].start() if n + 1 < len(marks) else len(text)
                        row['keys'].append((m.group(1).rstrip('.'), text[m.end():stop]))
                    continue
                # A key cell wrapping onto another line. Bounded: a long paragraph in
                # this column is prose that landed on the wrong side of a boundary, not
                # the tail of an objective, and appending it produced objectives with a
                # page of activities inside them.
                if row['keys'] and len(text) < 200:
                    key, was = row['keys'][-1]
                    row['keys'][-1] = (key, f'{was} {text}'.strip())
                continue

            if not row['keys']:
                continue
            if role == 'objectives':
                key, was = row['keys'][-1]
                row['keys'][-1] = (key, f'{was} {text}'.strip())
            elif role == 'activities':
                # Cambridge names resources inside the activity prose and in lines that
                # open "Resources:". Kept apart where the document does; the planner is
                # told to adapt either to the school's own inventory.
                (row['resources'] if re.match(r'resources?\b[: ]', text, re.I)
                 else row['activities']).append(text)
                act_y = max(act_y, y0)
            elif role == 'notes':
                row['notes'].append(text)

    flush()
    return entries


def merge(entries):
    """One row per (code, key). An objective runs over several pages and its activities
       arrive in pieces; the bank wants the whole of it under the key once."""
    out = {}
    for e in entries:
        at = out.get((e['syllabus_code'], e['key']))
        if not at:
            out[(e['syllabus_code'], e['key'])] = e
            continue
        # The first page it appears on is the one to cite.
        at['objective_text'] = at['objective_text'] or e['objective_text']
        for field in ('activities', 'resources', 'notes'):
            at[field] += [x for x in e[field] if x not in at[field]]
    return list(out.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('paths', nargs='+', help='scheme of work PDFs, or folders of them')
    ap.add_argument('--out', default='supabase/seed')
    args = ap.parse_args()

    files = []
    for p in args.paths:
        path = Path(p)
        files += sorted(path.rglob('*.pdf')) if path.is_dir() else [path]

    read, skipped, entries = [], [], []
    for path in files:
        code = CODE.search(path.name)
        if not code:
            skipped.append({'file': path.name, 'why': 'no syllabus code in the filename'})
            continue
        found = read_scheme(path, code.group(1))
        if not found:
            skipped.append({'file': path.name, 'why': 'no entries found - needs a human look'})
            continue
        entries += found
        read.append({'file': path.name, 'syllabus_code': code.group(1), 'entries': len(found)})

    rows = merge(entries)
    rows.sort(key=lambda r: (r['syllabus_code'], r['key']))

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / 'scheme_of_work.json').write_text(json.dumps(rows, indent=1), encoding='utf-8')

    by_code = {}
    for r in rows:
        at = by_code.setdefault(r['syllabus_code'], {'keys': 0, 'with_activities': 0})
        at['keys'] += 1
        if r['activities']:
            at['with_activities'] += 1

    report = {'files_read': read, 'skipped': skipped, 'by_syllabus': by_code}
    (out / 'scheme_of_work_report.json').write_text(json.dumps(report, indent=1), encoding='utf-8')

    for code, at in sorted(by_code.items()):
        print(f"  {code}  {at['keys']:4} objectives, {at['with_activities']} with activities")
    for s in skipped:
        print(f"  ! {s['file']}: {s['why']}")
    print(f"\n{len(rows)} entries -> {out/'scheme_of_work.json'}")


if __name__ == '__main__':
    main()
