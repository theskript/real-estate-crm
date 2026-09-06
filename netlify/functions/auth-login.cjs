'use strict';

const bcrypt = require('bcryptjs');
const { jwtSign, getSupabase, cors, logAudit, getClientIP } = require('./_utils.cjs');

const CORS = cors('POST');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const { username = '', password = '' } = body;
  const secret = process.env.ADMIN_JWT_SECRET;
  const ip = getClientIP(event);

  if (!secret) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured: ADMIN_JWT_SECRET missing' }) };
  }

  const deny = async () => {
    await new Promise(r => setTimeout(r, 300 + Math.random() * 200));
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid username or password' }) };
  };

  // Agents table lookup. Note: username stays GLOBALLY unique across all
  // organizations (not per-org) — since one agent belongs to exactly one
  // organization (no multi-org membership), this keeps login unambiguous
  // with no org-picker step needed. There is intentionally no bootstrap/
  // env-var login fallback here anymore: every login must resolve to a real
  // agents row with a real organization_id. New organizations are created
  // via `node scripts/provision-tenant.cjs`, not via a login-time bypass.
  const { data: agent, error: lookupErr } = await getSupabase()
    .from('agents')
    .select('*')
    .ilike('username', username.replace(/'/g, ''))
    .maybeSingle();

  if (lookupErr) {
    console.error('[login] agents lookup failed:', lookupErr.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server error during login' }) };
  }
  if (!agent) {
    await logAudit({ action: 'Failed Login', username, role: '', details: 'No matching account', ip });
    return deny();
  }
  if (!agent.active) {
    await logAudit({ action: 'Failed Login', username, role: agent.role || '', details: 'Account is deactivated', ip, organizationId: agent.organization_id });
    return deny();
  }
  const match = await bcrypt.compare(password, agent.password_hash || '');
  if (!match) {
    await logAudit({ action: 'Failed Login', username, role: agent.role || '', details: 'Wrong password', ip, organizationId: agent.organization_id });
    return deny();
  }
  const role = agent.role || 'agent';
  const name = agent.name || username;

  getSupabase().from('agents').update({ last_login: new Date().toISOString() }).eq('id', agent.id).then(() => {});
  await logAudit({ action: 'Login', username, role, details: `Successful login — ${name}`, ip, organizationId: agent.organization_id });

  const expiresIn = role === 'owner' ? 86400 : 28800;
  const token = jwtSign({ sub: agent.id, organization_id: agent.organization_id, role, username, name }, secret, expiresIn);
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ token, role, name, agentId: agent.id, expiresIn }) };
};

