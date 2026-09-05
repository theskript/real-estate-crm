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
- Hand-rolled JWT auth (HMAC-SHA256) + `bcryptjs` password hashing — no
  external auth vendor, no monthly per-seat cost

## 1. Create your Supabase project

1. Go to [supabase.com](https://supabase.com) → **New Project**. Pick any name/region and a strong database password (you won't need it directly — Supabase manages that).
2. Once the project finishes provisioning, open **Project Settings → API**. You'll need two values:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** (NOT the `anon` key — keep this secret, server-side only) → `SUPABASE_SERVICE_ROLE_KEY`
3. Open the **SQL Editor** (left sidebar) → **New query**, paste the entire contents of [supabase/schema.sql](supabase/schema.sql), and run it. This creates every table (agents, leads, activities, tasks, properties, tags, audit_log, settings) plus indexes and starter tags/lead sources.

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

## 5. Deploy to Netlify

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
├── supabase/schema.sql               # full DB schema + RLS
└── netlify.toml
```
