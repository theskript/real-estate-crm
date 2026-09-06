'use strict';
// Migration runner — applies versioned SQL migrations from migrations/ to
// either Supabase (Postgres) or the local SQLite fallback. Tracks applied
// migrations in a `schema_migrations` table so it's always safe to re-run.
//
// Usage:
//   node scripts/migrate.cjs --target=postgres   # needs SUPABASE_DB_URL in .env.local
//   node scripts/migrate.cjs --target=sqlite      # manual/CLI use; the app does this automatically

require('dotenv').config();
require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => fs.statSync(path.join(MIGRATIONS_DIR, f)).isDirectory())
    .sort();
}

async function migratePostgres(markAppliedOnly) {
  const { Client } = require('pg');
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error('SUPABASE_DB_URL is not set in .env.local — see migrations/README.md.');
    process.exit(1);
  }
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map(r => r.name));
    for (const name of listMigrations()) {
      if (applied.has(name)) { console.log(`  skip ${name} (already applied)`); continue; }
      if (markAppliedOnly && markAppliedOnly !== name) continue;
      if (markAppliedOnly === name) {
        console.log(`  marking ${name} as applied WITHOUT running its SQL (--mark-applied)...`);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        console.log(`  \u2713 ${name} marked applied`);
        continue;
      }
      const sqlPath = path.join(MIGRATIONS_DIR, name, 'postgres.sql');
      if (!fs.existsSync(sqlPath)) { console.log(`  skip ${name} (no postgres.sql)`); continue; }
      console.log(`  applying ${name}...`);
      await client.query(fs.readFileSync(sqlPath, 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      console.log(`  \u2713 ${name}`);
    }
  } finally {
    await client.end();
  }
}

function migrateSqlite(dbPathOverride) {
  const Database = require('better-sqlite3');
  const dbPath = dbPathOverride || process.env.SQLITE_DB_PATH || path.join(__dirname, '..', 'data', 'teaka.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))");
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  for (const name of listMigrations()) {
    if (applied.has(name)) { console.log(`  skip ${name} (already applied)`); continue; }
    const sqlPath = path.join(MIGRATIONS_DIR, name, 'sqlite.sql');
    if (!fs.existsSync(sqlPath)) { console.log(`  skip ${name} (no sqlite.sql)`); continue; }
    db.exec(fs.readFileSync(sqlPath, 'utf8'));
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    console.log(`  \u2713 ${name}`);
  }
  db.close();
  return dbPath;
}

module.exports = { listMigrations, migratePostgres, migrateSqlite, MIGRATIONS_DIR };

if (require.main === module) {
  const target = process.argv.includes('--target=postgres') ? 'postgres' : 'sqlite';
  const markAppliedArg = process.argv.find(a => a.startsWith('--mark-applied='));
  const markApplied = markAppliedArg ? markAppliedArg.split('=')[1] : null;
  (async () => {
    console.log(`Applying migrations to ${target}...`);
    if (target === 'postgres') await migratePostgres(markApplied);
    else migrateSqlite();
    console.log('Done.');
  })().catch(err => { console.error('\u2717 Migration failed:', err.message); process.exit(1); });
}
