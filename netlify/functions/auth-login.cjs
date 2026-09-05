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

  // 1. agents table lookup
  try {
    const { data: agent } = await getSupabase()
      .from('agents')
      .select('*')
      .ilike('username', username.replace(/'/g, ''))
      .maybeSingle();

    if (agent) {
      if (!agent.active) {
        await logAudit({ action: 'Failed Login', username, role: agent.role || '', details: 'Account is deactivated', ip });
        return deny();
      }
      const match = await bcrypt.compare(password, agent.password_hash || '');
      if (!match) {
        await logAudit({ action: 'Failed Login', username, role: agent.role || '', details: 'Wrong password', ip });
        return deny();
      }
      const role = agent.role || 'agent';
      const name = agent.name || username;

      getSupabase().from('agents').update({ last_login: new Date().toISOString() }).eq('id', agent.id).then(() => {});
      await logAudit({ action: 'Login', username, role, details: `Successful login — ${name}`, ip });

      const expiresIn = role === 'owner' ? 86400 : 28800;
      const token = jwtSign({ sub: agent.id, role, username, name }, secret, expiresIn);
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ token, role, name, agentId: agent.id, expiresIn }) };
    }
  } catch (err) {
    console.warn('[login] Supabase agents lookup failed, falling back to env var:', err.message);
  }

  // 2. Owner env var bootstrap fallback (until the first `agents` row exists)
  if (!process.env.ADMIN_PASSWORD) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server not configured: no agents row or ADMIN_PASSWORD set' }) };
  }
  if (username === 'owner' && password === process.env.ADMIN_PASSWORD) {
    await logAudit({ action: 'Login', username: 'owner', role: 'owner', details: 'Login via ADMIN_PASSWORD env var (bootstrap)', ip });
    const token = jwtSign({ sub: 'bootstrap-owner', role: 'owner', username: 'owner', name: 'Owner' }, secret, 86400);
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ token, role: 'owner', name: 'Owner', agentId: null, expiresIn: 86400 }) };
  }

  await logAudit({ action: 'Failed Login', username, role: '', details: 'No matching account', ip });
  return deny();
};
