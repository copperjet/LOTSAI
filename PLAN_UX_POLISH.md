# Plan — production polish, uploads, logo

Written 2026-08-30 at the end of the artefact-engine session (commit `00ca8d1`). Eight tasks,
in the order they should be done. Delete this file once it is worked through.

## Decisions already made — do not re-litigate

- **Logo**: add `sharp` as a devDependency and generate the assets with a one-off script
  (task 7, option A). Confirmed by the user 2026-08-30. Do not ship the 1.2 MB source.
- **Artefact serving**: one shared `/api/artefact/view` route, not three per-artefact routes.
- **Approval model**: study packs and worksheets are approved by their author, not an HOD. Already
  built; nothing in this plan changes it.
- **Drive**: stays mocked (`MOCK_DRIVE=1`) until the service-account credential is set. Out of scope
  here — see `~/.claude/projects/.../memory/drive-delivery.md`.

## Context

The engine, study packs, worksheets and Drive delivery all work end to end. What is left is the
gap between "the pipeline is correct" and "a teacher would believe this is a finished product":
a broken artefact link, demo-grade explanatory copy, a technical loading state, and a placeholder
logo. Plus two real features — image upload with OCR, and a task list that gets out of the way.

---

## 1. "Open the study pack" shows raw HTML  *(bug — do first)*

**Root cause, confirmed by measurement.** Supabase Storage serves the stored `.html` as
`Content-Type: text/plain`, overriding the `text/html; charset=utf-8` we upload it with (it does
this deliberately, so user HTML cannot execute on their domain):

```
$ curl -sI "<signed url>"
HTTP/1.1 200 OK
Content-Type: text/plain
Content-Length: 33892
```

That is why the browser prints the source, and — because `text/plain` carries no charset — why the
title renders `Weeks 10â€"12` instead of `Weeks 10–12`. Both symptoms, one cause. Nothing is wrong
with the generated HTML.

**Fix — serve artefacts from our own domain.** Add one shared route rather than three:

- `GET /api/artefact/view?kind=<kind>&id=<uuid>` in `app/api/artefact/view/route.ts`
- `kind` ∈ `studypack-html` | `studypack-pdf` | `worksheet` | `planner`; each maps to a storage
  path and a content type (reuse the `FORMAT` map in `lib/pdf/store.ts` — export it).
- Look the row up (authorise via `currentUser()`), `db.storage.from('artefacts').download(path)`,
  return the bytes with the right `Content-Type` and `Content-Disposition: inline`.
- Keep the `reuse=1` increment behaviour that currently lives on the GET handlers, or leave those
  handlers as the JSON/metadata endpoints and have the view route handle bytes only. Prefer the
  latter: `generate` GET keeps returning `{title, path, url}` where `url` is now the view route.

**Then** point `openPack` / `openWorksheet` / `openPackPdf` at the view route instead of the signed
URL. Signed URLs stay for anything that genuinely should download.

Files: new `app/api/artefact/view/route.ts`; `lib/pdf/store.ts` (export `FORMAT`);
`app/api/{studypack/generate,studypack/pdf,worksheet/generate}/route.ts`; `app/page.tsx`.

---

## 2. Em dashes → hyphens

`—` appears in ~250 places. Three sources, and all three need handling or it comes back:

1. **UI copy** — 52 in `app/page.tsx`, plus `app/gate/page.tsx`, `app/layout.tsx`. Sweep the JSX
   strings by hand (code comments can be left alone, or swept too — harmless either way).
2. **Model output** — the generated titles, key ideas and tasks contain them. Add a line to each
   system prompt (`lib/studypack.ts`, `lib/worksheet.ts`, `lib/planner.ts`, `lib/evaluation.ts`):
   *"Never use an em dash or en dash. Use a plain hyphen."*
3. **Belt and braces at render time** — models will ignore rule 2 sometimes. Normalise in the two
   places every artefact passes through:
   - `sanitizeWinAnsi()` in `lib/pdf/layout.ts` — map `—` `–` `‒` `―` to `-` before the cp1252
     pass. Covers every PDF (planner, study pack, worksheet).
   - `esc()` in `lib/studypack_html.ts` — same mapping. Covers the interactive HTML.

Doing 3 alone would fix what a teacher sees; do all three so the data is clean too.

---

## 3. Strip the explanatory copy

The screens read like a product demo. Remove the paragraphs that explain *why the system works
that way*; keep the ones that tell a teacher *what will happen if they click*.

**Remove** (line numbers as of `00ca8d1`, `app/page.tsx`):

| Line | Copy |
|---|---|
| 393 | "`{claimedBy}` is planning this same week right now — so you two will not write it twice…" |
| 564, 704 | "Drive is in demo mode — no file was actually uploaded. Set the Google service-account credential…" → replace with a small "Demo" pill, or nothing |
| 772, 946 | the two `<div className="note">` blocks (the recap-flag explanation, the `ai_usage` ledger explanation) |
| 936 | "Denominators count teaching weeks only — 11 in Semester 1, not 14 or 15." |
| 961 | the second paragraph of `boundary()` — "I only do the school's repeated work…" (screenshot 3). Keep the first line. |
| 870, 882, 904 | the registry-screen explanations of what conflict / unreadable / unplaced mean |
| 1369, 1443 | the PackCard and WorksheetCard footers ("Open it to check it first. Approving puts it in the shared bank and sends…") |
| 1777 | the PlannerCard footer under the quality gate — "Every field here is editable in place — type into it and click away…" (the gate screen the user named) |
| 1832 | "I never write in your comment box, and never in the teacher's." |

**Keep**: cost hints (`about $0.03`), "free - no AI call", "A returned planner needs a reason
attached" (it explains a disabled button), the offline notice, and the `.pdf or .docx` file hint.

Rule of thumb for anything not listed: if deleting the sentence would leave a teacher unsure what a
button does, keep it; if it only explains the product's philosophy, cut it.

---

## 4. Optimistic chat bubble instead of "Checking the registry…"

Today every long action sets a technical string and renders a spinner:

```jsx
setBusy('Checking the registry, then the shared bank…');
{busy && <div className="turn"><img className="crest" …/><div className="think"><span className="sp"/>{busy}</div></div>}
```

Change to a proper assistant bubble that reads like a person answering:

- **Copy** — replace each `setBusy(...)` string with warm, first-person, non-technical copy:
  "Checking the registry, then the shared bank…" → *"On it. Let me see if someone has already done
  this one."*; "Pulling the objectives from the registry and writing the pack…" → *"Right, writing
  it now. This takes about a minute."*; the worksheet one → *"Writing the tasks, in three levels."*
- **Shape** — render it as a normal `.turn` bubble (same styling as a real answer) with an animated
  three-dot typing indicator, not a spinner. Add `.dots` CSS next to `.think` in `app/globals.css`
  (three spans, staggered `@keyframes` opacity; respect the existing `prefers-reduced-motion` rule).
- **Staged messages** — generation takes 20-60s. Hold an array of phases per action and advance
  every ~6s (`useEffect` + `setInterval`, cleared on completion) so the bubble changes rather than
  freezing: *"Reading the week's objectives…"* → *"Writing the tasks…"* → *"Nearly there."*
- **Real-time feel** — the user's own turn already appears instantly via `said()`. Add: scroll the
  new turn into view immediately (`behavior: 'auto'` for the user's own message, `'smooth'` for the
  reply), and give `.turn` a short fade/rise-in animation so turns arrive rather than blink.

Files: `app/page.tsx` (a small `useBusyPhases` helper + every `setBusy` call site),
`app/globals.css`.

---

## 5. Upload documents **and images** → extract → build a study pack

Today `/api/ingest/upload` takes `.pdf`/`.docx` only. Add images (photo of a worksheet, a textbook
page, a whiteboard) with OCR through a vision model.

**Provider layer** — add image support to the shared call path so OCR is metered like everything
else (`ai_usage` row per call), rather than calling an SDK directly:

- `lib/llm.ts`: add `images?: { mediaType: string; base64: string }[]` to `CallOpts`.
- `lib/providers/openai.ts`: attach as `image_url` content parts with a `data:` URI.
- `lib/providers/anthropic.ts`: attach as `image` blocks (`source: {type:'base64', media_type, data}`).
- `lib/mocks.ts`: a `mockOcr()` fixture for workflow `ocr_extract`, so it runs free under `MOCK_LLM`.

**Extraction** — new `lib/ingest/ocr.ts`: `extractTextFromImage(bytes, mediaType, userId)`, tier
`standard`, workflow `ocr_extract`, system prompt = *"Transcribe all text in this image verbatim.
Preserve objective codes exactly. Do not summarise, do not invent."*

**Route** — extend `app/api/ingest/upload/route.ts`:
- accept `image/png`, `image/jpeg`, `image/webp` (and keep the 415 for anything else);
- accept **multiple files** in one request (`form.getAll('file')`), extract each, concatenate the
  text, then reconcile once — so a three-page photographed worksheet becomes one study pack;
- store `kind: 'image'` on `source_upload` and record per-file text lengths in `extracted`.
- Size guard: reject over ~10 MB per image before base64, and cap at, say, 5 files.

**The founding rule is unchanged and must stay explicit**: OCR text is *evidence*, not truth. Every
objective code it yields still goes through `reconcile()`; unresolved codes are shown and never seed
a pack. `/api/studypack/from-upload` already enforces this — no change needed there.

**UI** — `UploadCard` in `app/page.tsx`: `accept=".pdf,.docx,image/*"`, `multiple`, a drop zone
(`onDragOver`/`onDrop`), a thumbnail strip for images, and per-file progress. Reuse the existing
resolved/unresolved pill display exactly as it is.

---

## 6. Hide the Today box when nothing is pending

`TodayBox` currently returns `null` only when there are zero tasks, so a fully-ticked list still
occupies the corner (screenshots 2 and 3 show "2 of 4 done" hanging there with no rows).

```tsx
// app/page.tsx, TodayBox
if (!tasks.length || tasks.every(t => t.done)) return null;
```

Keep the tick-flash animation for the moment the last task completes, then let the box disappear on
the next `loadAgenda()` — i.e. do not unmount mid-animation. Simplest: delay the unmount by the
existing 1600 ms flash timeout when the final task flips.

---

## 7. New logo

`lots ai.png` is **1254 × 1254, 1.2 MB** — 1.6 MB as a base64 data URI, versus the 12 KB crest it
replaces. It cannot be inlined as-is; a Lusaka connection would feel every byte.

**Single swap point**: everything reads `CREST` from `lib/crest.ts` — the rail, the turn avatars
(`app/page.tsx`), the interactive HTML (`lib/studypack_html.ts`), and the PDF header
(`lib/pdf/branding.ts`, `lib/pdf/renderers/planner.ts`). Replace that one constant and every
surface updates.

**Steps** (option A, confirmed):

1. `npm i -D sharp` — build-time only, never shipped to the browser or the server bundle.
2. Move the source out of the repo root, into `assets/lots-ai-source.png` (no space in the
   filename). Commit it: it is the master the script regenerates from.
3. Write `scripts/make_logo.mjs` — reads `assets/lots-ai-source.png`, emits both:
   - `public/lots-ai.png` at 256×256, and
   - `lib/crest.ts`, regenerated as a 192×192 PNG data URI (~30-50 KB, comparable to the 12 KB
     crest it replaces, so the "a slow connection never renders a broken page" property survives).

   Keep the file's existing one-line comment at the top of the generated `lib/crest.ts`, and add
   *"Generated by scripts/make_logo.mjs from assets/lots-ai-source.png — do not edit by hand."*
4. Run it once and commit the output. The script is re-runnable, not part of the build.
5. Check the logo on every surface: rail, chat avatars, gate page, study-pack HTML header, and all
   three PDFs. The PDF header scales by **height** and the new logo is square where the crest was
   not, so it will sit differently — adjust `h` in `drawHeader` (`lib/pdf/branding.ts`) and in the
   planner's own landscape header (`lib/pdf/renderers/planner.ts`, `header()`), and re-check the
   text offset `x` that follows it.

---

## 8. Also worth doing while in there

- The browser tab title of the study pack comes out as `CP4 English Study Pack: Weeks 10â€"12 â€"
  LOTS Study Pack`. Task 1 fixes the encoding and task 2 the dashes; check the title afterwards.
- `lots ai.png` is currently untracked at the repo root — task 7 step 2 moves it to
  `assets/lots-ai-source.png`. Do not commit it where it is.
- This plan file is itself untracked. Commit it with the first task, or delete it when the list is
  worked through.

---

## Suggested order

1 (bug, blocks demoing the pack) → 6 (one line) → 2 → 3 → 7 → 4 → 5 (biggest).

## Verification

Run the server from a shell so the model calls are real where it matters:

```bash
MOCK_LLM=0 MOCK_CLAUDE=0 LLM_PROVIDER=openai npm run dev
```

- **1**: `curl -sI "http://localhost:3000/api/artefact/view?kind=studypack-html&id=<id>"` →
  `text/html; charset=utf-8`; open it in the browser pane and confirm it renders as a page, with
  the title reading `Weeks 10-12`.
- **2**: `grep -rn "—" app lib --include="*.tsx" --include="*.ts"` shows only comments; generate a
  pack and a worksheet and confirm no `—` in the PDF text or the HTML.
- **3**: walk the planner, gate, coverage, registry, pack and worksheet screens — no paragraph
  explains the system to the reader.
- **4**: click "Make a study pack" and watch: your own message appears instantly, the reply bubble
  types, the phase text advances, nothing jumps.
- **5**: upload a photo of a worksheet (and a two-image set); resolved refs appear as pills,
  unresolved as warnings, and "Build from N resolved" produces a pack from the resolved refs only.
- **6**: complete every task in the Today box; it disappears.
- **7**: logo correct on rail, avatars, gate, pack HTML, and all three PDFs.
- Always finish with `npx tsc --noEmit` and `npx next build`.
