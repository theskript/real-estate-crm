'use strict';

const { requireAuth, getSupabase, scopedTable, cors, logAudit, getClientIP } = require('./_utils.cjs');

const CORS = cors('GET, PATCH');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  let user;
  try { user = requireAuth(event); } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  const sb = getSupabase();
  const ip = getClientIP(event);

  if (event.httpMethod === 'GET') {
    const { data, error } = await scopedTable(sb, user, 'settings').select('key,value');
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    const settings = Object.fromEntries((data || []).map(({ key, value }) => [key, value]));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ settings }) };
  }

  if (event.httpMethod === 'PATCH') {
    if (user.role !== 'owner') return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Owner access required' }) };
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const rows = Object.entries(body).map(([key, value]) => ({ key, value: String(value) }));
    if (!rows.length) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No settings provided' }) };
    const { error } = await scopedTable(sb, user, 'settings').upsert(rows, { onConflict: 'organization_id,key' });
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Update Settings', username: user.username, role: user.role, details: JSON.stringify(body), ip, organizationId: user.organization_id });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
