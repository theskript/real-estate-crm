'use strict';

const { requireAuth, getSupabase, scopedTable, cors, logAudit, getClientIP } = require('./_utils.cjs');

const CORS = cors('GET, POST, PATCH, DELETE');
const PROPERTY_SELECT = '*, seller_lead:leads(id,first_name,last_name)';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  let user;
  try { user = requireAuth(event); } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  const sb = getSupabase();
  const ip = getClientIP(event);
  const q = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    if (q.id) {
      const { data, error } = await scopedTable(sb, user, 'properties')
        .select(`${PROPERTY_SELECT}, matches:lead_property_matches(id,status,lead:leads(id,first_name,last_name,phone,email))`)
        .eq('id', q.id).maybeSingle();
      if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
      if (!data) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Property not found' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ property: data }) };
    }
    let query = scopedTable(sb, user, 'properties').select(PROPERTY_SELECT).order('created_at', { ascending: false });
    if (q.status) query = query.eq('status', q.status);
    if (q.search) {
      const s = q.search.replace(/'/g, '').substring(0, 100);
      query = query.or(`address.ilike.%${s}%,city.ilike.%${s}%,zip.ilike.%${s}%`);
    }
    const { data, error } = await query;
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ properties: data }) };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    if (!body.address) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'address is required' }) };
    const { data, error } = await scopedTable(sb, user, 'properties').insert(body).select(PROPERTY_SELECT).single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Create Property', username: user.username, role: user.role, details: body.address, targetId: data.id, ip, organizationId: user.organization_id });
    return { statusCode: 201, headers: CORS, body: JSON.stringify({ property: data }) };
  }

  if (event.httpMethod === 'PATCH') {
    const id = q.id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const { data, error } = await scopedTable(sb, user, 'properties').update(body).eq('id', id).select(PROPERTY_SELECT).single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Update Property', username: user.username, role: user.role, details: JSON.stringify(body), targetId: id, ip, organizationId: user.organization_id });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ property: data }) };
  }

  if (event.httpMethod === 'DELETE') {
    const id = q.id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    if (user.role !== 'owner') return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Owner access required' }) };
    const { error } = await scopedTable(sb, user, 'properties').delete().eq('id', id);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Delete Property', username: user.username, role: user.role, details: id, ip, organizationId: user.organization_id });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
