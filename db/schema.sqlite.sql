-- ============================================================================
-- Teaka CRM — SQLite fallback schema
--
-- This is a drop-in local replacement for supabase/schema.sql, used
-- automatically (see netlify/functions/_sqlite.cjs) whenever SUPABASE_URL
-- isn't configured — e.g. while Supabase is down, or before you've created a
-- project. It is executed once, automatically, against data/teaka.sqlite the
-- first time any function runs. You do not need to run this by hand.
--
-- Notes vs. the Postgres schema:
--   - `id` columns use a SQLite DEFAULT expression that generates a v4-style
--     UUID string (no gen_random_uuid() in SQLite).
--   - timestamptz -> TEXT (ISO 8601 strings, e.g. 2026-09-05T19:39:34.047Z)
--   - text[] -> TEXT (JSON-encoded array, e.g. '[]')
--   - boolean -> INTEGER (0/1)
--   - Row Level Security has no SQLite equivalent — access control here
--     relies entirely on the same app-layer checks (requireAuth/requireOwner,
--     per-agent lead visibility) already enforced in every function, which
--     is the same code path Postgres RLS was backing up as defense-in-depth.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ── agents ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  username      TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'agent' CHECK (role IN ('owner', 'agent')),
  active        INTEGER NOT NULL DEFAULT 1,
  avatar_color  TEXT DEFAULT '#0e8a7d',
  last_login    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── leads ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                        TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  lead_type                 TEXT NOT NULL CHECK (lead_type IN ('buyer', 'seller')),
  first_name                TEXT NOT NULL,
  last_name                 TEXT,
  email                     TEXT,
  phone                     TEXT,
  temperature               TEXT NOT NULL DEFAULT 'warm' CHECK (temperature IN ('hot', 'warm', 'cold')),
  stage                     TEXT NOT NULL DEFAULT 'new' CHECK (stage IN
                              ('new', 'contacted', 'nurturing', 'appointment_set', 'under_contract', 'closed_won', 'closed_lost')),
  source                    TEXT,
  assigned_agent_id         TEXT REFERENCES agents(id) ON DELETE SET NULL,
  budget_min                NUMERIC,
  budget_max                NUMERIC,
  desired_area              TEXT,
  listing_price_expectation NUMERIC,
  property_address          TEXT,
  notes                     TEXT,
  lost_reason               TEXT,
  next_follow_up_at         TEXT,
  last_contacted_at         TEXT,
  created_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_assigned_agent ON leads(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage          ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_temperature    ON leads(temperature);
CREATE INDEX IF NOT EXISTS idx_leads_lead_type      ON leads(lead_type);
CREATE INDEX IF NOT EXISTS idx_leads_next_follow_up ON leads(next_follow_up_at);

-- ── tags ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tags (
  id    TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  name  TEXT UNIQUE NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b'
);
CREATE TABLE IF NOT EXISTS lead_tags (
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);

-- ── properties ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id             TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  address        TEXT NOT NULL,
  city           TEXT,
  state          TEXT,
  zip            TEXT,
  price          NUMERIC,
  beds           INTEGER,
  baths          NUMERIC,
  sqft           INTEGER,
  lot_size       TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'sold', 'off_market')),
  seller_lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  listing_date   TEXT,
  description    TEXT,
  photos         TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_properties_seller_lead ON properties(seller_lead_id);
CREATE INDEX IF NOT EXISTS idx_properties_status      ON properties(status);

CREATE TABLE IF NOT EXISTS lead_property_matches (
  id          TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  lead_id     TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'interested' CHECK (status IN
                ('interested', 'showing_scheduled', 'showed', 'passed', 'offer_made')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (lead_id, property_id)
);

-- ── activities ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activities (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  lead_id          TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id         TEXT REFERENCES agents(id) ON DELETE SET NULL,
  type             TEXT NOT NULL CHECK (type IN
                     ('call', 'sms', 'email', 'note', 'showing', 'meeting', 'status_change')),
  direction        TEXT CHECK (direction IN ('inbound', 'outbound')),
  body             TEXT,
  duration_seconds INTEGER,
  recording_url    TEXT,
  call_sid         TEXT,
  outcome          TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(lead_id, created_at DESC);

-- ── tasks ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  lead_id      TEXT REFERENCES leads(id) ON DELETE CASCADE,
  agent_id     TEXT REFERENCES agents(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  description  TEXT,
  task_type    TEXT NOT NULL DEFAULT 'follow_up' CHECK (task_type IN
                 ('call', 'email', 'showing', 'follow_up', 'other')),
  due_at       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_lead   ON tasks(lead_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent  ON tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due    ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- ── audit_log ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  action     TEXT NOT NULL,
  username   TEXT,
  role       TEXT,
  details    TEXT,
  target_id  TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- ── settings ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('lead_sources', 'Zillow,Realtor.com,Facebook Ads,Referral,Sphere of Influence,Open House,Website,Walk-in,Other');

INSERT OR IGNORE INTO tags (name, color) VALUES
  ('First-Time Buyer', '#2dd4bf'),
  ('Investor', '#8b5cf6'),
  ('Luxury', '#d97706'),
  ('Cash Buyer', '#16a34a'),
  ('Relocating', '#3b82f6');
