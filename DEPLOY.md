# Deploying to lotsai.dennysepiso.com

Target: **https://lotsai.dennysepiso.com**, on Vercel, functions pinned to `cpt1` (Cape Town) — the
closest Vercel region to Lusaka, and the difference between a plan appearing in two seconds and in
five.

## State of play

| | |
|---|---|
| Vercel project | `copperjets-projects/lots-ai` |
| Production URLs | `lotsai.dennysepiso.com` and `lots-ai.vercel.app`, both aliased to the newest production deployment |
| How a deploy happens | pushing `main` to `github.com/copperjet/LOTSAI`; the Git integration builds and promotes it. `vercel --prod` also works. |
| Supabase project | created, migrations through 0010 applied |
| Model calls | real. Production has `LLM_PROVIDER=openai` and `OPENAI_API_KEY`, and no `MOCK_LLM`. |
| Google Drive | mocked, because `GOOGLE_SERVICE_ACCOUNT_JSON` is unset. `driveMocked()` treats a missing credential as mock, so nothing is uploaded and approval still succeeds. |
| Anthropic credits | not available — the card keeps failing, so the app runs on OpenAI (`LLM_PROVIDER=openai`) |
| Study pack PDFs | the designed PDF is the pack's own page printed by headless Chromium, which needs roughly 1.7 GB. This plan's function memory cap is below that (`memory: 3009` was rejected — see commit `e66a466`), so production falls back to the plain pdf-lib rendering. It is complete, it just is not the designed page. `study_pack.render_note` records the reason on each pack, and the teacher is told which PDF they have. Raising the plan's memory limit, or setting `memory` on `app/api/studypack/**` to whatever the cap now allows, is what switches the designed one on. |

`lotsai.igaprep.com` was the original target and is **not** part of this project. That domain is not
in the `copperjets-projects` team and 404s; do not point anything at it.

## 1. Sign the CLI into the account that owns the project

```bash
vercel login
```

Then confirm you are in the right team:

```bash
vercel domains ls
```

`dennysepiso.com` must appear. If it does not, the CLI is in the wrong account or the wrong team —
use `vercel switch` to pick `copperjets-projects`.

## 2. Create the Supabase project

Already done for the live site; this is what to repeat for a new environment.

At supabase.com, create a project in the region closest to Zambia (`eu-central-1` or
`af-south-1` where offered). Then, in its SQL editor, run every file in
`supabase/migrations/` in numerical order, `0001_init.sql` through `0010_worksheet.sql`. There is
no migration runner: the DDL is applied by hand, so a new environment is only as current as the
last file somebody ran.

Take three values from **Project Settings → API**: the project URL, the anon key, and the service
role key.

Load the school's own curriculum and calendar into it, from this machine:

```bash
npm run ingest
npm run seed
```

`npm run seed` reads `.env.local`, so that file has to exist locally with the Supabase values in it
even though the deployment reads its own copy from Vercel.

## 3. Environment variables on Vercel

Set these for **Production** (and Preview, if previews should work):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | from Supabase → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Supabase → API |
| `SUPABASE_SERVICE_ROLE_KEY` | from Supabase → API. Server-only; never prefixed `NEXT_PUBLIC_`. |
| `DEMO_USER_EMAIL` | the seeded user every visitor is signed in as, e.g. the teacher account |
| `LLM_PROVIDER` | `openai`. Unset or `anthropic` uses Anthropic. |
| `OPENAI_API_KEY` | from platform.openai.com. Server-only. |
| `MOCK_LLM` | `1` to stay on fixtures; unset to make real calls. `MOCK_CLAUDE` is the old name, still honoured. |
| `ANTHROPIC_API_KEY` | only when switching back to `LLM_PROVIDER=anthropic` |
| `OPENAI_MODEL_SMALL` / `_STANDARD` / `_LARGE` | optional per-tier overrides |

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add DEMO_USER_EMAIL production
vercel env add LLM_PROVIDER production
vercel env add OPENAI_API_KEY production
```

## 4. Deploy

From `lots-ai/`:

```bash
vercel link
vercel --prod
```

## 5. The domain

`lotsai.dennysepiso.com` is already attached and aliased to production, so there is nothing to do
here on an existing deployment. Confirm with:

```bash
vercel alias ls
```

To move the site to a different hostname later, `vercel domains add <host>` in this team; the record
and certificate are created for you within a minute or two. The same hostname cannot serve two
projects, so detach it from the old one first.

## The door

There is one door: a personal sign-in. `middleware.ts` requires a session cookie for everything —
pages and API routes alike — and sends anyone without one to `/signin`, where they pick their name
and enter their PIN. Only the cookie's presence is checked at the edge; `currentUser()` in
`lib/supabase.ts` settles whether the token is real, unexpired and attached to an active person.

The shared school password that used to stand in front of this is gone: `SITE_PASSWORD`,
`lib/sitegate.ts`, `app/gate/` and `app/api/gate/` were removed once every member of staff had
their own PIN. `/signin` is now the first page a stranger reaches, and it lists staff names — no
email addresses, no PINs.

Locally, `DEMO_USER_EMAIL` still stands in for a session so `npm run dev` and the seed scripts keep
working. In production it does not.

## Checks after the first deploy

1. `https://lotsai.dennysepiso.com` redirects to `/signin`.
2. A wrong PIN is refused; the right one lets you through and stays through a reload.
3. `curl -s -o /dev/null -w '%{http_code}' https://lotsai.dennysepiso.com/api/agenda` is `307`, not
   `200` — the API is behind the sign-in too.
4. Signed in, the agenda loads and the today box lists the week's work.
5. Plan a week, edit a methodology cell, reload: the edit persisted, and `select count(*) from
   edit_event;` in Supabase is 1.
6. `select workflow, provider, model from ai_usage;` shows rows for every call — metering is on the
   path even in mock mode, where provider and model are both `mock`.
7. Upload a `.pdf` and a `.docx` and reconcile them. This is worth checking on the deployment
   specifically: pdfjs loads its worker through a computed dynamic `import()` that Next's tracer
   cannot follow, so the file has to be named in `outputFileTracingIncludes` (`next.config.mjs`) or
   every PDF fails in the lambda while working locally.

## The mock switch

Production is **already on the real API**: `LLM_PROVIDER=openai` and `OPENAI_API_KEY` are set and
neither `MOCK_LLM` nor `MOCK_CLAUDE` is. Every teacher action spends real credit.

To put it back on fixtures, set `MOCK_LLM=1`. Both names are honoured, `MOCK_CLAUDE` being the older
one. Order matters when moving a live site the other way: add `MOCK_LLM` **first**, deploy, confirm
the site still serves fixtures, and only then remove `MOCK_CLAUDE`. Removing the old name first
would take production from fixtures to real API calls in the gap between the two commands.

Then watch `ai_usage`: if `cached_tokens` is zero on a second generation for the same subject and
week, the cache prefix has drifted and the cost model in Addendum D §D8 no longer holds. The OpenAI
cache discount is smaller than Anthropic's — correct §D8 from these rows, not from an estimate.

Switching back to Anthropic once the card clears is `LLM_PROVIDER=anthropic` plus
`ANTHROPIC_API_KEY`. No code changes.
