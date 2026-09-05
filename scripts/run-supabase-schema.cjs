'use strict';
// One-off helper: applies supabase/schema.sql directly to your Supabase
// Postgres database via a direct connection string, so you don't have to
// paste the file into the SQL Editor by hand.
//
// Usage:
//   1. Add SUPABASE_DB_URL=postgresql://... to .env.local (gitignored —
//      Project Settings > Database > Connection string > Direct connection).
//   2. node scripts/run-supabase-schema.cjs
require('dotenv').config({ path: '.env.local' });

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) {
  console.error('SUPABASE_DB_URL is not set in .env.local — see the comment at the top of this file.');
  process.exit(1);
}

const schemaPath = path.join(__dirname, '..', 'supabase', 'schema.sql');
const sql = fs.readFileSync(schemaPath, 'utf8');

(async () => {
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log('Connected. Applying supabase/schema.sql ...');
    await client.query(sql);
    console.log('✓ Schema applied successfully.');
  } catch (err) {
    console.error('✗ Failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
