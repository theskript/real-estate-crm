# Teaka — Real Estate CRM

A lightweight, modern CRM for managing buyer/seller leads with hot/warm/cold
prioritization, a drag-and-drop pipeline, task follow-ups, and property
listings — built with the same stack proven in production for
[blissdermacare-new](../blissdermacare-new): **Astro + Tailwind + Netlify
Functions + Supabase**. No heavy frontend framework, no monthly SaaS CRM fee.

## Tech stack

- **[Astro](https://astro.build)** (static output) + **TypeScript** + **Tailwind CSS**
- **Netlify Functions** (CommonJS) as the API layer
- **Supabase** (Postgres) as the database — accessed only via the service-role
  key from serverless functions, never exposed to the browser
- **Local SQLite fallback** (see below) — works with zero setup and zero
  external accounts, for whenever Supabase is unavailable or you just want to
  start using the CRM immediately
- Hand-rolled JWT auth (HMAC-SHA256) + `bcryptjs` password hashing — no
  external auth vendor, no monthly per-seat cost

## Quick start (no Supabase account needed)

If Supabase is down, or you just don't have a project set up yet, the app
works out of the box against a local SQLite database — no signup, no config:

```bash
npm install
cp .env.example .env   # defaults are fine; just set ADMIN_JWT_SECRET and ADMIN_PASSWORD
npm run dev
```

Every `netlify/functions/*.cjs` file talks to the database only through
`getSupabase()` in `_utils.cjs`. Whenever `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY` aren't set (or `DB_PROVIDER=sqlite` is set
explicitly), it transparently returns a local SQLite-backed client instead —
see `netlify/functions/_sqlite.cjs`. It has the same `.from(table).select()...`
query-builder shape Supabase's JS client uses, so **every function file is
completely unchanged** either way.

- The database file lives at `data/teaka.sqlite` (gitignored — never committed).
- It's created and seeded automatically from `db/schema.sqlite.sql` the first
  time any function runs. Nothing to run by hand.
- This is a genuinely full-featured local backend, not a stub — leads, tasks,
  activities, properties, tags, buyer/property matching, and the audit log all
  work identically to the Supabase-backed version, including per-agent lead
  visibility and role-based access control.
- **Limitation:** since Netlify Functions run in ephemeral containers when
  deployed, this file-based database only makes sense for **local
  development** — once Supabase is back (or if you deploy to Netlify for a
  real team), fill in `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in your `.env`
  and it switches back to Postgres automatically, no code changes needed. If
  you want an interim option that also works when *deployed*, ask about
  swapping in [Turso](https://turso.tech) (hosted, serverless-friendly SQLite)
  — it speaks the same SQL dialect as this fallback, so migrating is a driver
  swap, not a rewrite.
- A regression test for the fallback lives at
  [scripts/smoke-test-sqlite.cjs](scripts/smoke-test-sqlite.cjs) — run
  `node scripts/smoke-test-sqlite.cjs` any time you touch `_sqlite.cjs`.

## Using Supabase instead (recommended once it's back up)

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) → **New Project**. Pick any name/region and a strong database password (you won't need it directly — Supabase manages that).
2. Once the project finishes provisioning, open **Project Settings → API**. You'll need two values:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (NOT the `anon` key — keep this secret, server-side only) → `SUPABASE_SERVICE_ROLE_KEY`
3. Apply the schema — either paste [migrations/0001_initial_schema/postgres.sql](migrations/0001_initial_schema/postgres.sql) into the **SQL Editor** (left sidebar → New query → Run), or apply it automatically:
   ```bash
   npm install
   cp .env.local.example .env.local   # if it doesn't exist yet
   # edit .env.local and set SUPABASE_DB_URL to your Session pooler connection string
   node scripts/migrate.cjs --target=postgres
   ```
   This creates every table (agents, leads, activities, tasks, properties, tags, audit_log, settings) plus indexes and starter tags/lead sources, tracked in a `schema_migrations` table so it's safe to re-run — see [migrations/README.md](migrations/README.md) for how future schema changes work.

   Get the connection string from Supabase → **Connect** button (top of the
   dashboard, next to the project/branch selector) → **Connection String**
   tab → **Session pooler** (not "Direct connection" — that one is IPv6-only
   and won't resolve on most home/office networks; Session pooler works over
   plain IPv4). Swap in your real database password for the `[YOUR-PASSWORD]`
   placeholder. `.env.local` is gitignored — this password never gets
   committed, and never needs to be shared in chat/screenshots either.

   `pg` is a devDependency used only by this migration script — the running app
   never talks to Postgres directly, only through Supabase's REST API (or the
   SQLite fallback).

## 2. Configure environment variables

Copy `.env.example` to `.env` and fill in:

```bash
cp .env.example .env
```

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (service_role, secret) |
| `ADMIN_JWT_SECRET` | Generate with `openssl rand -hex 32` |
| `ADMIN_PASSWORD` | Any password you choose — used only for your very first login (see below) |
| `DB_PROVIDER` | Leave unset. Set to `sqlite` to force the local fallback even if Supabase vars are also present. |

## 3. First login (bootstrap)

There's no `agents` row yet, so the CRM lets you log in once as `owner` using
the `ADMIN_PASSWORD` env var. Log in with:

- Username: `owner`
- Password: whatever you set `ADMIN_PASSWORD` to

Then immediately go to **Team** (owner-only nav item) and create your real
owner/agent accounts with proper passwords. The `ADMIN_PASSWORD` fallback
still works as a break-glass login if you ever get locked out, but day-to-day
logins should use real `agents` rows.

## 4. Install & run locally

```bash
npm install
npm run dev
```

The CRM will be available at `http://localhost:4321`. Netlify Functions run
locally too (via the Astro/Netlify dev integration) — no separate server needed.

## 5. Load realistic demo data (optional, for demoing)

```bash
node scripts/seed-demo-data.cjs
```

Populates real Supabase (not the SQLite fallback) with 3 agents, 18 buyer/seller
leads across every temperature and pipeline stage, 8 properties, buyer-property
matches, activity timelines, follow-up tasks (overdue/today/upcoming/completed),
and audit log history — enough for every page to look genuinely in use. Log in
as `sarah.chen` / `marcus.torres` / `priya.patel`, password `Demo1234!`.

Safe to re-run: it aborts if demo agents already exist, or pass `--reset` to
wipe and regenerate the same dataset fresh (e.g. before a demo call).

## 6. Deploy to Netlify

1. Push this repo to GitHub/GitLab/Bitbucket and "Import an existing project" in Netlify, or run `netlify deploy` with the Netlify CLI.
2. In **Site settings → Environment variables**, add the same variables from your `.env` file.
3. Netlify auto-detects `netlify.toml` (build command `npm run build`, publish `dist`, functions in `netlify/functions`).

## What's built (MVP)

- **Auth**: JWT login, owner/agent roles, per-agent lead visibility (agents only see their own assigned leads; owners see everything)
- **Leads**: buyer/seller type, hot/warm/cold temperature, 7-stage pipeline, table **and** drag-and-drop Kanban views, search/filter, tags, round-robin auto-assign
- **Lead detail**: activity timeline (calls/texts/emails/notes/showings), tasks, notes, tags, click-to-call/text/email (uses `tel:`/`sms:`/`mailto:` today — see Dialer below)
- **Tasks**: follow-up queue (overdue/today/upcoming/completed) across the whole team
- **Calendar**: month view of all tasks with due dates
- **Properties**: listings tied to seller leads, buyer-interest matching
- **Team management**: owner-only agent CRUD, activate/deactivate
- **Audit log**: owner-only trail of every login/create/update/delete
- **Settings**: tags, lead sources, CSV lead import with duplicate detection
- **Dashboard**: open/hot/overdue stats, pipeline funnel, hot-lead alert list, follow-up queue
- **Demo data**: one-command realistic seed script for demoing (see step 5 above)

## What's intentionally deferred (roadmap)

- **Dialer (Twilio Voice)**: the `activities` table already has `duration_seconds`,
  `recording_url`, `call_sid`, and `outcome` columns sitting unused — built for
  this. To wire it up: add `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM`
  to your env, add the Twilio Voice JS SDK to the lead detail page, and swap
  the `tel:` link for an in-browser call that POSTs to a new
  `netlify/functions/dialer-*.cjs` set of endpoints (initiate call, TwiML
  webhook, call-status webhook that writes to `activities`).
- **Speed-to-lead alerts** (SMS/email the instant a new lead comes in — `sendSMS`/`sendEmail`-equivalent helpers can be added to `_utils.cjs` following the same pattern as the reference project)
- **Inbound lead webhooks** (Zillow/Realtor.com/Facebook Lead Ads → `leads` table directly, bypassing manual CSV import)
- **Email/SMS drip templates** by temperature/stage
- **Full listing-appointment scheduling** (separate from generic tasks)

## Project structure

```
teaka-crm/
├── src/
│   ├── layouts/AdminLayout.astro     # sidebar nav, mobile drawer, auth guard
│   ├── scripts/auth.js               # client-side JWT/session helpers
│   ├── scripts/leadMeta.js           # stage/temperature/type badge helpers
│   └── pages/                        # login, dashboard, leads, tasks, calendar,
│                                      # properties, agents, audit, settings
├── netlify/functions/                # one .cjs file per resource (leads, tasks, …)
│   ├── _utils.cjs                    # auth/JWT/audit/CORS + getSupabase() DB switch
│   └── _sqlite.cjs                   # local SQLite fallback (see below)
├── migrations/                       # versioned schema changes (see migrations/README.md)
│   └── 0001_initial_schema/postgres.sql, sqlite.sql
├── tests/                            # vitest suite — exercises real handlers against SQLite
├── scripts/
│   ├── migrate.cjs                   # applies migrations/ to Postgres or SQLite
│   ├── seed-demo-data.cjs            # populates realistic demo data (see step 5)
│   └── smoke-test-sqlite.cjs         # manual end-to-end smoke test for the SQLite fallback
├── .github/workflows/ci.yml          # runs `npm test` + `npm run build` on every push/PR
└── netlify.toml
```

## Testing & CI

```bash
npm test
```

Runs the automated suite in `tests/` (vitest) against the SQLite fallback —
no Supabase account or network access needed, so it's fast and safe to run
constantly. It exercises the real `netlify/functions/*.cjs` handlers
end-to-end (not mocks), covering auth, per-agent access control, lead/task/
activity CRUD, and the nested-embed join logic in `_sqlite.cjs` (this exact
class of bug — silent empty/null joins — was found and fixed once already;
the tests guard against it recurring). `.github/workflows/ci.yml` runs this
plus `npm run build` on every push/PR to `main`/`dev`.

## Troubleshooting

- **Everything on a page says "Loading…" forever** — a function call is
  failing silently. Open the browser console/network tab; the real error
  usually points to one of:
  - `SUPABASE_URL` still set to the placeholder in `.env` (delete/blank it out
    if you want the SQLite fallback, or fill in the real value)
  - Schema not yet applied to Supabase (`Could not find the table '...' in the
    schema cache` — see step 1 above)
  - Stale dev server — `.env` is only read once at process start; after
    editing it, fully restart (`npx astro dev stop` then `npm run dev`)
- **`fetch failed` / DNS errors talking to Supabase** — almost always the
  `.env` `SUPABASE_URL` placeholder still being present, or (for the migration
  script) using the "Direct connection" string instead of "Session pooler".

