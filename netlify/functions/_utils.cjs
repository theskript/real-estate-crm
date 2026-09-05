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

async function logAudit({ action, username = '', role = '', details = '', targetId = '', ip = '' }) {
  try {
    const detailsStr = typeof details === 'object' ? JSON.stringify(details) : String(details);
    const { error } = await getSupabase().from('audit_log').insert({
      action,
      username,
      role,
      details: detailsStr.substring(0, 2000),
      target_id: targetId,
      ip_address: ip,
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
  cors,
  jwtSign, jwtVerify, requireAuth,
  logAudit, getClientIP,
  sendSMS,
};
