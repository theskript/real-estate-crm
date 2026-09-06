-- ============================================================================
-- Teaka CRM — migration 0002: multi-tenant retrofit (Postgres/Supabase)
--
-- Adds `organizations` and an `organization_id` column to every existing
-- table, backfilling all current rows into a single "Default Organization"
-- so nothing breaks. Going forward, every query in netlify/functions/*.cjs
-- must go through _utils.cjs#scopedTable(sb, user, table) instead of
-- sb.from(table) directly for any of these tables — that's the one place
-- tenant isolation is enforced.
-- ============================================================================

create table organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text unique not null,
  created_at timestamptz not null default now()
);

-- Backfill target for all pre-existing data (see UPDATE statements below).
insert into organizations (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', 'Default Organization', 'default');

alter table agents                 add column organization_id uuid references organizations(id);
alter table leads                  add column organization_id uuid references organizations(id);
alter table tags                   add column organization_id uuid references organizations(id);
alter table lead_tags              add column organization_id uuid references organizations(id);
alter table properties             add column organization_id uuid references organizations(id);
alter table lead_property_matches  add column organization_id uuid references organizations(id);
alter table activities              add column organization_id uuid references organizations(id);
alter table tasks                  add column organization_id uuid references organizations(id);
alter table audit_log              add column organization_id uuid references organizations(id);
alter table settings               add column organization_id uuid references organizations(id);

update agents                 set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update leads                  set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update tags                   set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update lead_tags               set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update properties             set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update lead_property_matches   set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update activities               set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update tasks                  set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update audit_log               set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;
update settings                set organization_id = '00000000-0000-0000-0000-000000000001' where organization_id is null;

alter table agents                 alter column organization_id set not null;
alter table leads                  alter column organization_id set not null;
alter table tags                   alter column organization_id set not null;
alter table lead_tags              alter column organization_id set not null;
alter table properties             alter column organization_id set not null;
alter table lead_property_matches  alter column organization_id set not null;
alter table activities              alter column organization_id set not null;
alter table tasks                  alter column organization_id set not null;
alter table audit_log              alter column organization_id set not null;
alter table settings               alter column organization_id set not null;

-- `tags.name` was globally unique; now unique per-organization instead.
alter table tags drop constraint tags_name_key;
alter table tags add constraint tags_org_name_unique unique (organization_id, name);

-- `settings.key` was a global primary key; now a composite (organization_id, key).
alter table settings drop constraint settings_pkey;
alter table settings add primary key (organization_id, key);

-- `agents.username` intentionally stays GLOBALLY unique (not per-org). Since
-- one agent belongs to exactly one organization (no multi-org membership),
-- this keeps login mechanically unchanged — no org-picker UI needed, no
-- ambiguity resolving a username to an organization at login time.

create index idx_agents_org     on agents(organization_id);
create index idx_leads_org      on leads(organization_id);
create index idx_tags_org       on tags(organization_id);
create index idx_properties_org on properties(organization_id);
create index idx_activities_org on activities(organization_id);
create index idx_tasks_org      on tasks(organization_id);
create index idx_audit_org      on audit_log(organization_id);

alter table organizations enable row level security;
