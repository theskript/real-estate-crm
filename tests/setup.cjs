'use strict';
// Shared test setup: gives each test an isolated, throwaway SQLite database
// (never the real dev database, never real Supabase) plus a fake Netlify
// Functions `event` builder, so tests exercise the REAL handler code
// unmodified — same approach as scripts/smoke-test-sqlite.cjs, just wired
// into vitest with proper isolation between tests.

const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');

const FN = path.join(__dirname, '..', 'netlify', 'functions');

/** Points the app at a brand-new, empty SQLite file and clears any cached connection. */
function freshDb() {
  const dbPath = path.join(os.tmpdir(), `teaka-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.SQLITE_DB_PATH = dbPath;
  process.env.DB_PROVIDER = 'sqlite'; // never touch real Supabase, even if a real .env is present
  process.env.ADMIN_JWT_SECRET = 'test-secret-do-not-use-in-prod';
  delete require.cache[require.resolve('../netlify/functions/_sqlite.cjs')];
  const { resetDb } = require('../netlify/functions/_sqlite.cjs');
  resetDb();
  return dbPath;
}

function cleanupDb(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
}

function mkEvent({ method = 'GET', token, body, qs = {} } = {}) {
  return {
    httpMethod: method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    queryStringParameters: qs,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
}

function fn(name) {
  delete require.cache[require.resolve(path.join(FN, name))];
  return require(path.join(FN, name));
}

/**
 * Creates a brand-new organization + its first owner agent directly (same
 * logic as scripts/provision-tenant.cjs), then logs in as that owner via the
 * real HTTP handler. There is no login-time bootstrap bypass anymore — every
 * login must resolve to a real agents row with a real organization_id.
 */
async function provisionOrg({ orgName = 'Test Org', slug, ownerUsername = 'owner', ownerName = 'Test Owner', ownerPassword = 'pw123456' } = {}) {
  const { getSupabase } = require('../netlify/functions/_utils.cjs');
  const sb = getSupabase();
  const orgSlug = slug || `test-org-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { data: org, error: orgErr } = await sb.from('organizations').insert({ name: orgName, slug: orgSlug }).select().single();
  if (orgErr) throw new Error(`provisionOrg: failed to create org: ${orgErr.message}`);

  const password_hash = await bcrypt.hash(ownerPassword, 10);
  const { data: owner, error: ownerErr } = await sb.from('agents').insert({
    username: ownerUsername, name: ownerName, password_hash, role: 'owner', active: true, organization_id: org.id,
  }).select().single();
  if (ownerErr) throw new Error(`provisionOrg: failed to create owner: ${ownerErr.message}`);

  // Same starter tags every new org gets in scripts/provision-tenant.cjs — several
  // tests (e.g. tag embeds) rely on at least one tag existing for the org.
  await sb.from('tags').insert([
    { name: 'First-Time Buyer', color: '#2dd4bf', organization_id: org.id },
    { name: 'Investor', color: '#8b5cf6', organization_id: org.id },
  ]);

  const authLogin = fn('auth-login.cjs');
  const res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: ownerUsername, password: ownerPassword } }));
  if (res.statusCode !== 200) throw new Error(`provisionOrg: owner login failed: ${res.body}`);
  const ownerToken = JSON.parse(res.body).token;

  return { org, owner, ownerToken };
}

/** Provisions one org/owner, then has that owner create one more agent via the real API. Returns { org, ownerToken, agent, agentToken }. */
async function createOwnerAndAgent({ orgName, ownerUsername = 'real.owner', username = 'agent1', name = 'Agent One' } = {}) {
  const { org, ownerToken } = await provisionOrg({ orgName, ownerUsername, ownerName: 'Real Owner' });
  const agentsFn = fn('agents.cjs');
  const authLogin = fn('auth-login.cjs');

  const created = await agentsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { username, name, password: 'pw123456', role: 'agent' } }));
  const agent = JSON.parse(created.body).agent;
  const login = await authLogin.handler(mkEvent({ method: 'POST', body: { username, password: 'pw123456' } }));
  const agentToken = JSON.parse(login.body).token;

  return { org, ownerToken, agent, agentToken };
}

module.exports = { freshDb, cleanupDb, mkEvent, fn, provisionOrg, createOwnerAndAgent };
