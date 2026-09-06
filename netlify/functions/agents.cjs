'use strict';

const bcrypt = require('bcryptjs');
const { requireAuth, getSupabase, scopedTable, cors, logAudit, getClientIP } = require('./_utils.cjs');

const CORS = cors('GET, POST, PATCH, DELETE');
const SAFE_COLUMNS = 'id,username,name,email,phone,role,active,avatar_color,last_login,created_at';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  let user;
  try { user = requireAuth(event); } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  const sb = getSupabase();
  const ip = getClientIP(event);

  if (event.httpMethod === 'GET') {
    const { data, error } = await scopedTable(sb, user, 'agents').select(SAFE_COLUMNS).order('name');
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ agents: data }) };
  }

  // All mutations below require owner role
  if (user.role !== 'owner') {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Owner access required' }) };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const { username, name, email, phone, password, role = 'agent', avatar_color } = body;
    if (!username || !name || !password) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'username, name, and password are required' }) };
    }
    const password_hash = await bcrypt.hash(password, 10);
    const { data, error } = await scopedTable(sb, user, 'agents')
      .insert({ username: username.trim().toLowerCase(), name, email, phone, password_hash, role, avatar_color })
      .select(SAFE_COLUMNS).single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Create Agent', username: user.username, role: user.role, details: `Added ${name} (${username})`, ip, organizationId: user.organization_id });
    return { statusCode: 201, headers: CORS, body: JSON.stringify({ agent: data }) };
  }

  if (event.httpMethod === 'PATCH') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const updates = {};
    for (const k of ['name', 'email', 'phone', 'role', 'active', 'avatar_color']) {
      if (body[k] !== undefined) updates[k] = body[k];
    }
    if (body.password) updates.password_hash = await bcrypt.hash(body.password, 10);
    const { data, error } = await scopedTable(sb, user, 'agents').update(updates).eq('id', id).select(SAFE_COLUMNS).single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Update Agent', username: user.username, role: user.role, details: `Updated ${id}: ${JSON.stringify(updates)}`, ip, organizationId: user.organization_id });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ agent: data }) };
  }

  if (event.httpMethod === 'DELETE') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    // Soft-delete: deactivate rather than hard-delete so historical leads/activities keep a valid agent reference
    const { error } = await scopedTable(sb, user, 'agents').update({ active: false }).eq('id', id);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Deactivate Agent', username: user.username, role: user.role, details: id, ip, organizationId: user.organization_id });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
