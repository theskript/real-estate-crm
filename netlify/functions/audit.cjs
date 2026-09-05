'use strict';

const { requireAuth, getSupabase, cors } = require('./_utils.cjs');

const CORS = cors('GET');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  try { requireAuth(event, 'owner'); } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  const q = event.queryStringParameters || {};
  const limit = Math.min(parseInt(q.limit) || 100, 500);
  const { data, error } = await getSupabase().from('audit_log').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ entries: data }) };
};
