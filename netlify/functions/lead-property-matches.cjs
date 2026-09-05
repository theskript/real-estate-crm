'use strict';

const { requireAuth, getSupabase, cors, logAudit, getClientIP } = require('./_utils.cjs');

const CORS = cors('POST, PATCH, DELETE');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  let user;
  try { user = requireAuth(event); } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  const sb = getSupabase();
  const ip = getClientIP(event);
  const q = event.queryStringParameters || {};

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const { lead_id, property_id, status = 'interested' } = body;
    if (!lead_id || !property_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lead_id and property_id are required' }) };
    const { data, error } = await sb.from('lead_property_matches')
      .upsert({ lead_id, property_id, status }, { onConflict: 'lead_id,property_id' })
      .select().single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Add Buyer Match', username: user.username, role: user.role, details: `${lead_id} ↔ ${property_id}`, ip });
    return { statusCode: 201, headers: CORS, body: JSON.stringify({ match: data }) };
  }

  if (event.httpMethod === 'PATCH') {
    const id = q.id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const { data, error } = await sb.from('lead_property_matches').update(body).eq('id', id).select().single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ match: data }) };
  }

  if (event.httpMethod === 'DELETE') {
    const id = q.id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    const { error } = await sb.from('lead_property_matches').delete().eq('id', id);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
