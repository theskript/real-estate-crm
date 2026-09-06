-- ============================================================================
-- Teaka CRM — migration 0002: multi-tenant retrofit (SQLite fallback)
--
-- SQLite's ALTER TABLE can't change nullability or drop/add constraints on
-- existing columns without a full table rebuild (create-copy-drop-rename for
-- every table). Since this fallback is explicitly local-dev-only (see
-- migrations/0001_initial_schema/sqlite.sql), we take a pragmatic shortcut
-- here that the Postgres migration does NOT take:
--   - organization_id is added and backfilled, but NOT enforced NOT NULL
--     at the SQLite level (the app layer always sets it on insert).
--   - tags and settings DO get a full rebuild (not just ADD COLUMN) to give
--     them real composite UNIQUE(organization_id, name) / PRIMARY KEY
--     (organization_id, key) constraints, matching Postgres — needed because
--     scopedTable()'s upsert onConflict target must match an actual
--     constraint on both backends, and because keeping tags.name globally
--     unique actively breaks multi-org usage (two orgs both wanting a
--     "First-Time Buyer" tag would collide).
--   - lead_tags is ALSO rebuilt as a side effect: SQLite auto-rewrites other
--     tables' FK clauses when you rename a referenced table (a real, easy-to-
--     miss gotcha), so renaming tags -> tags_old_0002 silently repoints
--     lead_tags.tag_id at that temp name; rebuilding lead_tags with a fresh
--     REFERENCES tags(id) after tags exists again fixes it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS organizations (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  name       TEXT NOT NULL,
  slug       TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Default Organization', 'default');

ALTER TABLE agents                 ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE leads                  ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE properties             ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE lead_property_matches  ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE activities             ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE tasks                  ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE audit_log              ADD COLUMN organization_id TEXT REFERENCES organizations(id);

-- tags: full rebuild for a real composite UNIQUE(organization_id, name)
ALTER TABLE tags RENAME TO tags_old_0002;
CREATE TABLE tags (
  id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-' || substr('89ab',(abs(random()) % 4) + 1, 1) || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6)))),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  name            TEXT NOT NULL,
  color           TEXT NOT NULL DEFAULT '#64748b',
  UNIQUE (organization_id, name)
);
INSERT INTO tags (id, organization_id, name, color)
SELECT id, '00000000-0000-0000-0000-000000000001', name, color FROM tags_old_0002;
DROP TABLE tags_old_0002;

-- settings: full rebuild for a real composite (organization_id, key) PRIMARY KEY
ALTER TABLE settings RENAME TO settings_old_0002;
CREATE TABLE settings (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  key             TEXT NOT NULL,
  value           TEXT,
  PRIMARY KEY (organization_id, key)
);
INSERT INTO settings (organization_id, key, value)
SELECT '00000000-0000-0000-0000-000000000001', key, value FROM settings_old_0002;
DROP TABLE settings_old_0002;

-- lead_tags: rebuilt (not just ADD COLUMN) so its tag_id FK points at the
-- NEW tags table above, not the now-dropped tags_old_0002 (see note at top).
ALTER TABLE lead_tags RENAME TO lead_tags_old_0002;
CREATE TABLE lead_tags (
  lead_id         TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id          TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  organization_id TEXT REFERENCES organizations(id),
  PRIMARY KEY (lead_id, tag_id)
);
INSERT INTO lead_tags (lead_id, tag_id, organization_id)
SELECT lead_id, tag_id, '00000000-0000-0000-0000-000000000001' FROM lead_tags_old_0002;
DROP TABLE lead_tags_old_0002;

UPDATE agents                SET organization_id = '00000000-0000-0000-0000-000000000001' WHERE organization_id IS NULL;
UPDATE leads                 SET organization_id = '00000000-0000-0000-0000-000000000001' WHERE organization_id IS NULL;
UPDATE properties             SET organization_id = '00000000-0000-0000-0000-000000000001' WHERE organization_id IS NULL;
UPDATE lead_property_matches  SET organization_id = '00000000-0000-0000-0000-000000000001' WHERE organization_id IS NULL;
UPDATE activities              SET organization_id = '00000000-0000-0000-0000-000000000001' WHERE organization_id IS NULL;
UPDATE tasks                  SET organization_id = '00000000-0000-0000-0000-000000000001' WHERE organization_id IS NULL;
UPDATE audit_log               SET organization_id = '00000000-0000-0000-0000-000000000001' WHERE organization_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_agents_org     ON agents(organization_id);
CREATE INDEX IF NOT EXISTS idx_leads_org      ON leads(organization_id);
CREATE INDEX IF NOT EXISTS idx_tags_org       ON tags(organization_id);
CREATE INDEX IF NOT EXISTS idx_properties_org ON properties(organization_id);
CREATE INDEX IF NOT EXISTS idx_activities_org ON activities(organization_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org      ON tasks(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_org      ON audit_log(organization_id);
