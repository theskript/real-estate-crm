-- ============================================================================
-- Teaka CRM — migration 0001: initial schema (Postgres/Supabase)
--
-- Applied automatically by `node scripts/migrate.cjs --target=postgres`
-- (tracked in a `schema_migrations` table so it's safe to re-run). See
-- migrations/README.md for how to add the next migration.
-- ============================================================================

create extension if not exists pgcrypto;

-- ── updated_at helper ────────────────────────────────────────────────────────
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ── agents (team members / users of the CRM) ────────────────────────────────
create table agents (
  id            uuid primary key default gen_random_uuid(),
  username      text unique not null,
  name          text not null,
  email         text,
  phone         text,
  password_hash text not null,
  role          text not null default 'agent' check (role in ('owner', 'agent')),
  active        boolean not null default true,
  avatar_color  text default '#0e8a7d',
  last_login    timestamptz,
  created_at    timestamptz not null default now()
);

-- ── leads (buyer or seller leads, with pipeline stage + temperature) ────────
create table leads (
  id                        uuid primary key default gen_random_uuid(),
  lead_type                 text not null check (lead_type in ('buyer', 'seller')),
  first_name                text not null,
  last_name                 text,
  email                     text,
  phone                     text,
  temperature               text not null default 'warm' check (temperature in ('hot', 'warm', 'cold')),
  stage                     text not null default 'new' check (stage in
                              ('new', 'contacted', 'nurturing', 'appointment_set', 'under_contract', 'closed_won', 'closed_lost')),
  source                    text,
  assigned_agent_id         uuid references agents(id) on delete set null,
  -- buyer-specific
  budget_min                numeric,
  budget_max                numeric,
  desired_area              text,
  -- seller-specific
  listing_price_expectation numeric,
  property_address          text,
  notes                     text,
  lost_reason               text,
  next_follow_up_at         timestamptz,
  last_contacted_at         timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create index idx_leads_assigned_agent on leads(assigned_agent_id);
create index idx_leads_stage          on leads(stage);
create index idx_leads_temperature    on leads(temperature);
create index idx_leads_lead_type      on leads(lead_type);
create index idx_leads_next_follow_up on leads(next_follow_up_at);
create trigger trg_leads_updated_at before update on leads
  for each row execute function set_updated_at();

-- ── tags ─────────────────────────────────────────────────────────────────────
create table tags (
  id    uuid primary key default gen_random_uuid(),
  name  text unique not null,
  color text not null default '#64748b'
);
create table lead_tags (
  lead_id uuid not null references leads(id) on delete cascade,
  tag_id  uuid not null references tags(id) on delete cascade,
  primary key (lead_id, tag_id)
);

-- ── properties (listings, tied to a seller lead once formally listed) ──────
create table properties (
  id          uuid primary key default gen_random_uuid(),
  address     text not null,
  city        text,
  state       text,
  zip         text,
  price       numeric,
  beds        int,
  baths       numeric,
  sqft        int,
  lot_size    text,
  status      text not null default 'active' check (status in ('active', 'pending', 'sold', 'off_market')),
  seller_lead_id uuid references leads(id) on delete set null,
  listing_date   date,
  description text,
  photos      text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index idx_properties_seller_lead on properties(seller_lead_id);
create index idx_properties_status      on properties(status);
create trigger trg_properties_updated_at before update on properties
  for each row execute function set_updated_at();

-- buyer-lead interest in specific listings
create table lead_property_matches (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leads(id) on delete cascade,
  property_id uuid not null references properties(id) on delete cascade,
  status      text not null default 'interested' check (status in
                ('interested', 'showing_scheduled', 'showed', 'passed', 'offer_made')),
  created_at  timestamptz not null default now(),
  unique (lead_id, property_id)
);

-- ── activities (calls / sms / emails / notes / showings / status changes) ──
-- `type = 'call'` rows are shaped for a future Twilio Voice dialer
-- (duration_seconds / recording_url / call_sid / outcome are populated by it).
create table activities (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  agent_id         uuid references agents(id) on delete set null,
  type             text not null check (type in
                     ('call', 'sms', 'email', 'note', 'showing', 'meeting', 'status_change')),
  direction        text check (direction in ('inbound', 'outbound')),
  body             text,
  duration_seconds int,
  recording_url    text,
  call_sid         text,
  outcome          text,
  created_at       timestamptz not null default now()
);
create index idx_activities_lead   on activities(lead_id, created_at desc);

-- ── tasks (follow-ups, showings, calls to make, etc.) ───────────────────────
create table tasks (
  id           uuid primary key default gen_random_uuid(),
  lead_id      uuid references leads(id) on delete cascade,
  agent_id     uuid references agents(id) on delete set null,
  title        text not null,
  description  text,
  task_type    text not null default 'follow_up' check (task_type in
                 ('call', 'email', 'showing', 'follow_up', 'other')),
  due_at       timestamptz,
  status       text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index idx_tasks_lead    on tasks(lead_id);
create index idx_tasks_agent   on tasks(agent_id);
create index idx_tasks_due     on tasks(due_at);
create index idx_tasks_status  on tasks(status);

-- ── audit_log (owner-visible activity trail) ────────────────────────────────
create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  action     text not null,
  username   text,
  role       text,
  details    text,
  target_id  text,
  ip_address text,
  created_at timestamptz not null default now()
);
create index idx_audit_created on audit_log(created_at desc);

-- ── settings (key/value store — lead sources list, notification prefs, etc.) ─
create table settings (
  key   text primary key,
  value text
);
insert into settings (key, value) values
  ('lead_sources', 'Zillow,Realtor.com,Facebook Ads,Referral,Sphere of Influence,Open House,Website,Walk-in,Other');

-- seed a starter tag set
insert into tags (name, color) values
  ('First-Time Buyer', '#2dd4bf'),
  ('Investor', '#8b5cf6'),
  ('Luxury', '#d97706'),
  ('Cash Buyer', '#16a34a'),
  ('Relocating', '#3b82f6');

-- ============================================================================
-- Row Level Security — all tables are accessed exclusively through Netlify
-- Functions using the Supabase SERVICE ROLE key (never exposed to the
-- browser), which bypasses RLS entirely. Enabling RLS with no policies for
-- anon/authenticated simply guarantees that a leaked anon key can never read
-- or write this data directly.
-- ============================================================================
alter table agents                 enable row level security;
alter table leads                  enable row level security;
alter table tags                   enable row level security;
alter table lead_tags              enable row level security;
alter table properties             enable row level security;
alter table lead_property_matches  enable row level security;
alter table activities             enable row level security;
alter table tasks                  enable row level security;
alter table audit_log              enable row level security;
alter table settings               enable row level security;
