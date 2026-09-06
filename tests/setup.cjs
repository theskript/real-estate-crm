'use strict';
// Shared test setup: gives each test an isolated, throwaway SQLite database
// (never the real dev database, never real Supabase) plus a fake Netlify
// Functions `event` builder, so tests exercise the REAL handler code
// unmodified — same approach as scripts/smoke-test-sqlite.cjs, just wired
// into vitest with proper isolation between tests.

const fs = require('fs');
const os = require('os');
const path = require('path');

const FN = path.join(__dirname, '..', 'netlify', 'functions');

/** Points the app at a brand-new, empty SQLite file and clears any cached connection. */
function freshDb() {
  const dbPath = path.join(os.tmpdir(), `teaka-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  process.env.SQLITE_DB_PATH = dbPath;
  process.env.DB_PROVIDER = 'sqlite'; // never touch real Supabase, even if a real .env is present
  process.env.ADMIN_JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.ADMIN_PASSWORD = 'bootstrap-test-pw';
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

/** Logs in as the env-var bootstrap owner and returns the JWT. */
async function bootstrapOwnerToken() {
  const authLogin = fn('auth-login.cjs');
  const res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'owner', password: process.env.ADMIN_PASSWORD } }));
  if (res.statusCode !== 200) throw new Error(`bootstrap login failed: ${res.body}`);
  return JSON.parse(res.body).token;
}

/** Creates a real owner + one agent via the API, returns { ownerToken, agent, agentToken }. */
async function createOwnerAndAgent(bootstrapToken, { username = 'agent1', name = 'Agent One' } = {}) {
  const agentsFn = fn('agents.cjs');
  const authLogin = fn('auth-login.cjs');

  await agentsFn.handler(mkEvent({ method: 'POST', token: bootstrapToken, body: { username: 'real.owner', name: 'Real Owner', password: 'pw123456', role: 'owner' } }));
  let res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'real.owner', password: 'pw123456' } }));
  const ownerToken = JSON.parse(res.body).token;

  res = await agentsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { username, name, password: 'pw123456', role: 'agent' } }));
  const agent = JSON.parse(res.body).agent;
  res = await authLogin.handler(mkEvent({ method: 'POST', body: { username, password: 'pw123456' } }));
  const agentToken = JSON.parse(res.body).token;

  return { ownerToken, agent, agentToken };
}

module.exports = { freshDb, cleanupDb, mkEvent, fn, bootstrapOwnerToken, createOwnerAndAgent };
