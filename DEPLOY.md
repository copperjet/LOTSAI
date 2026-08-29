# Deploying to lotsai.igaprep.com

Target: **https://lotsai.igaprep.com**, on Vercel, functions pinned to `cpt1` (Cape Town) — the
closest Vercel region to Lusaka, and the difference between a plan appearing in two seconds and in
five.

## State of play

| | |
|---|---|
| `igaprep.com` nameservers | `ns1.vercel-dns.com`, `ns2.vercel-dns.com` — already on Vercel |
| `lotsai.igaprep.com` | already resolves to Vercel (216.198.79.1 / .65) |
| Vercel account holding the domain | **not** `copperjets-projects` — that team holds only escholr.com and codarti.com |
| Supabase project | not created yet |
| Anthropic credits | not available — deploy runs on `MOCK_CLAUDE=1` |

## 1. Sign the CLI into the account that owns igaprep.com

```bash
vercel login
```

Then confirm the domain is visible to that account:

```bash
vercel domains ls
```

`igaprep.com` must appear. If it does not, the CLI is in the wrong account or the wrong team — use
`vercel switch` to pick the team that holds it.

## 2. Create the Supabase project

At supabase.com, create a project in the region closest to Zambia (`eu-central-1` or
`af-south-1` where offered). Then, in its SQL editor, run in order:

- `supabase/migrations/0001_init.sql`
- `supabase/migrations/0002_functions.sql`
- `supabase/migrations/0003_edits.sql`

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
| `SITE_PASSWORD` | the shared password for the whole site. See below. |
| `MOCK_CLAUDE` | `1` until Anthropic credits clear |
| `ANTHROPIC_API_KEY` | only once credits clear, at which point unset `MOCK_CLAUDE` |

```bash
vercel env add SITE_PASSWORD production
vercel env add NEXT_PUBLIC_SUPABASE_URL production
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY production
vercel env add SUPABASE_SERVICE_ROLE_KEY production
vercel env add DEMO_USER_EMAIL production
vercel env add MOCK_CLAUDE production
```

## 4. Deploy

From `lots-ai/`:

```bash
vercel link
vercel --prod
```

## 5. Attach the domain

```bash
vercel domains add lotsai.igaprep.com
```

Because `igaprep.com` is already on Vercel nameservers in that account, the record is created for
you and the certificate issues within a minute or two. `lotsai.igaprep.com` currently resolves to
Vercel already, so if it is attached to a different project there, detach it first — the same
hostname cannot serve two projects.

## The password gate

v1 has no sign-in. `currentUser()` in `lib/supabase.ts` reads `DEMO_USER_EMAIL`, so **everyone who
reaches the site is the same user**. On a public URL that would mean anyone who finds it can read
every planner and spend AI credits, so `middleware.ts` puts one shared password in front of
everything — pages and API routes alike.

It **fails closed**: a production deployment with no `SITE_PASSWORD` serves the gate and nothing
else. Forgetting the variable locks the door rather than opening it.

Locally, with no `SITE_PASSWORD` set, the gate stands aside so `npm run dev` is unchanged.

To test it the way production runs it:

```bash
SITE_PASSWORD=something npx next start
```

The whole mechanism is `middleware.ts`, `lib/sitegate.ts`, `app/gate/page.tsx` and
`app/api/gate/route.ts`. When Google Workspace SSO is switched on, delete those four files.

## Checks after the first deploy

1. `https://lotsai.igaprep.com` redirects to `/gate`.
2. A wrong password is refused; the right one lets you through and stays through a reload.
3. `curl -s -o /dev/null -w '%{http_code}' https://lotsai.igaprep.com/api/agenda` is `307`, not
   `200` — the API is behind the gate too.
4. Signed in, the agenda loads and the today box lists the week's work.
5. Plan a week, edit a methodology cell, reload: the edit persisted, and `select count(*) from
   edit_event;` in Supabase is 1.
6. `select workflow, model from ai_usage;` shows `mock` rows — metering is on the path even in mock
   mode.

## Going live on the real API

Set `ANTHROPIC_API_KEY`, remove `MOCK_CLAUDE`, redeploy. Then watch `ai_usage`: if
`cached_tokens` is zero on a second generation for the same subject and week, the cache prefix has
drifted and the cost model in Addendum D §D8 no longer holds.
