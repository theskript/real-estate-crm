# Migrations

Versioned, incremental schema changes — replaces the old single monolithic
`schema.sql` file. Each migration is a folder containing dialect-specific SQL:

```
migrations/
└── 0001_initial_schema/
    ├── postgres.sql   # applied to real Supabase
    └── sqlite.sql     # applied to the local SQLite fallback
```

Both files in a migration should make the **same logical change**, written in
each dialect's own syntax (Postgres vs. SQLite types/defaults differ — see the
notes at the top of `0001_initial_schema/sqlite.sql`).

## Applying migrations

- **SQLite fallback**: fully automatic. `netlify/functions/_sqlite.cjs` applies
  any pending migration every time it connects (tracked in a `schema_migrations`
  table, so already-applied ones are skipped). Nothing to run by hand.
- **Supabase (Postgres)**: run
  ```bash
  node scripts/migrate.cjs --target=postgres
  ```
  Requires `SUPABASE_DB_URL` in `.env.local` (Session pooler connection string
  — see the main README's Supabase setup section for how to get it). Also
  tracked in a `schema_migrations` table, safe to re-run.

## Adding a new migration

1. Create a new folder: `migrations/000N_short_description/`
2. Add `postgres.sql` and `sqlite.sql` with the same logical change
3. Run `node scripts/migrate.cjs --target=postgres` against Supabase, and just
   restart the dev server to pick it up locally (SQLite applies automatically)
4. Never edit an already-applied migration file — add a new one instead, the
   same way you would with any real migration tool

## Adopting migrations into a database that already has the schema

If a target database already has tables from before this tooling existed
(e.g. a hand-run SQL Editor paste), running the migration normally will fail
with "relation already exists". Mark it as applied without re-running its SQL:

```bash
node scripts/migrate.cjs --target=postgres --mark-applied=0001_initial_schema
```

