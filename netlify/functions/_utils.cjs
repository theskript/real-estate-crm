'use strict';

// load .env in local dev (no-op in production where env vars come from Netlify)
require('dotenv').config();

/**
 * Shared utilities — Supabase client, JWT auth, audit logging, CORS.
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── Database client ───────────────────────────────────────────────────────────
// Uses Supabase when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are configured.
// Otherwise (e.g. no project created yet, or Supabase is down) it transparently
// falls back to a local SQLite file via _sqlite.cjs — same .from()/.select()
// query-builder shape, zero code changes needed anywhere else. Set
// DB_PROVIDER=sqlite to force the fallback even if Supabase vars are present.

function usingSqlite() {
  return process.env.DB_PROVIDER === 'sqlite' || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function getSupabase() {
  if (usingSqlite()) {
    const { getSqliteDB } = require('./_sqlite.cjs');
    return getSqliteDB();
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── Multi-tenancy ─────────────────────────────────────────────────────────────
// Every tenant-scoped table (all of them except `organizations` itself) has an
// `organization_id` column (migration 0002). This is the ONLY place tenant
// isolation is enforced — every query against one of these tables MUST go
// through scopedTable(sb, user, table) instead of sb.from(table) directly, or
// it will leak data across organizations. `user` is the decoded JWT (carries
// `.organization_id`).
//
// Implemented as a Proxy (not a plain wrapper) because both the real
// supabase-js client and our SQLite shim only expose `.eq()` AFTER calling
// `.select()/.update()/.delete()` on `.from(table)` — you can't call `.eq()`
// directly on the bare table reference. The proxy transparently injects the
// organization_id filter right after whichever of those methods is called,
// and stamps organization_id onto `.insert()/.upsert()` payloads. Callers
// write exactly the same chained query code as before; only `sb.from(table)`
// becomes `scopedTable(sb, user, table)`.
const TENANT_SCOPED_TABLES = new Set([
  'agents', 'leads', 'tags', 'lead_tags', 'properties', 'lead_property_matches',
  'activities', 'tasks', 'audit_log', 'settings',
]);

function scopedTable(sb, user, table) {
  if (!TENANT_SCOPED_TABLES.has(table)) {
    throw new Error(`scopedTable: "${table}" is not a recognized tenant-scoped table`);
  }
  if (!user || !user.organization_id) {
    throw { statusCode: 401, message: 'Missing organization context' };
  }
  const orgId = user.organization_id;
  const base = sb.from(table);
  return new Proxy(base, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      if (prop === 'select' || prop === 'update' || prop === 'delete') {
        return (...args) => value.apply(target, args).eq('organization_id', orgId);
      }
      if (prop === 'insert' || prop === 'upsert') {
        return (...args) => {
          const stamped = Array.isArray(args[0])
            ? args[0].map(row => ({ ...row, organization_id: orgId }))
            : { ...args[0], organization_id: orgId };
          return value.call(target, stamped, ...args.slice(1));
        };
      }
      return value.bind(target);
    },
  });
}

// ── CORS ──────────────────────────────────────────────────────────────────────

function cors(methods = 'GET, OPTIONS') {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': `${methods}, OPTIONS`,
  };
}

// ── JWT ───────────────────────────────────────────────────────────────────────

function jwtSign(payload, secret, expiresInSeconds = 86400) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + expiresInSeconds })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function jwtVerify(token, secret) {
  const parts = (token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  const [header, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expectedBuf.length !== sigBuf.length || !crypto.timingSafeEqual(expectedBuf, sigBuf)) {
    throw new Error('Invalid signature');
  }
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (data.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return data;
}

/** Verifies the Authorization: Bearer header. Throws { statusCode, message } on failure. */
function requireAuth(event, requiredRole = null) {
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw { statusCode: 401, message: 'Authentication required' };
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) throw { statusCode: 500, message: 'Server configuration error' };
  let decoded;
  try {
    decoded = jwtVerify(token, secret);
  } catch (err) {
    throw { statusCode: 401, message: err.message || 'Invalid session' };
  }
  if (requiredRole && decoded.role !== requiredRole) {
    throw { statusCode: 403, message: 'Insufficient permissions' };
  }
  return decoded;
}

// ── Audit logging ─────────────────────────────────────────────────────────────

async function logAudit({ action, username = '', role = '', details = '', targetId = '', ip = '', organizationId = null }) {
  try {
    const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details);
    const { error } = await getSupabase().from('audit_log').insert({
      action,
      username,
      role,
      details: detailsStr.substring(0, 2000),
      target_id: targetId,
      ip_address: ip,
      organization_id: organizationId,
    });
    if (error) console.error('[audit] Supabase insert error:', error.message);
  } catch (err) {
    console.error('[audit] Failed to write log:', err.message);
  }
}

function getClientIP(event) {
  return (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || event.headers['client-ip']
    || 'unknown';
}

// ── Twilio (dialer — no-ops until TWILIO_* env vars are set) ─────────────────

async function sendSMS(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_FROM;
  if (!accountSid || !authToken || !from) {
    console.warn('[SMS] Twilio not configured — skipping SMS to', to);
    return { ok: false, error: 'Twilio not configured' };
  }
  const digits = String(to).replace(/\D/g, '');
  const phone  = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;
  const params = new URLSearchParams({ To: phone, From: from, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: data.message || 'Twilio error' };
  return { ok: true, sid: data.sid, status: data.status };
}

module.exports = {
  getSupabase,
  scopedTable,
  cors,
  jwtSign, jwtVerify, requireAuth,
  logAudit, getClientIP,
  sendSMS,
};
