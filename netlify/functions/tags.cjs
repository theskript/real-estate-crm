'use strict';

const { requireAuth, getSupabase, scopedTable, cors } = require('./_utils.cjs');

const CORS = cors('GET, POST, DELETE');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  let user;
  try { user = requireAuth(event); } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  const sb = getSupabase();

  if (event.httpMethod === 'GET') {
    const { data, error } = await scopedTable(sb, user, 'tags').select('*').order('name');
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ tags: data }) };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    if (!body.name) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'name is required' }) };
    const { data, error } = await scopedTable(sb, user, 'tags').insert({ name: body.name, color: body.color || '#64748b' }).select().single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 201, headers: CORS, body: JSON.stringify({ tag: data }) };
  }

  if (event.httpMethod === 'DELETE') {
    const id = (event.queryStringParameters || {}).id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    if (user.role !== 'owner') return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Owner access required' }) };
    const { error } = await scopedTable(sb, user, 'tags').delete().eq('id', id);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
