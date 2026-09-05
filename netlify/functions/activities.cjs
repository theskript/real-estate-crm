'use strict';

const { requireAuth, getSupabase, cors, logAudit, getClientIP } = require('./_utils.cjs');

const CORS = cors('GET, POST, DELETE');

async function assertLeadAccess(sb, leadId, user) {
  const { data: lead } = await sb.from('leads').select('assigned_agent_id').eq('id', leadId).maybeSingle();
  if (!lead) return { ok: false, statusCode: 404, error: 'Lead not found' };
  if (user.role !== 'owner' && lead.assigned_agent_id !== user.sub) {
    return { ok: false, statusCode: 403, error: 'You can only view leads assigned to you' };
  }
  return { ok: true };
}

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
    if (!q.lead_id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lead_id is required' }) };
    const access = await assertLeadAccess(sb, q.lead_id, user);
    if (!access.ok) return { statusCode: access.statusCode, headers: CORS, body: JSON.stringify({ error: access.error }) };

    const { data, error } = await sb.from('activities')
      .select('*, agent:agents(id,name,avatar_color)')
      .eq('lead_id', q.lead_id)
      .order('created_at', { ascending: false });
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ activities: data }) };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const { lead_id, type, direction, body: text, duration_seconds, outcome } = body;
    if (!lead_id || !type) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'lead_id and type are required' }) };
    const access = await assertLeadAccess(sb, lead_id, user);
    if (!access.ok) return { statusCode: access.statusCode, headers: CORS, body: JSON.stringify({ error: access.error }) };

    const { data, error } = await sb.from('activities').insert({
      lead_id, agent_id: user.sub, type, direction, body: text, duration_seconds, outcome,
    }).select('*, agent:agents(id,name,avatar_color)').single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };

    // Logging any contact activity refreshes last_contacted_at on the lead
    if (['call', 'sms', 'email', 'showing', 'meeting'].includes(type)) {
      await sb.from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', lead_id);
    }
    await logAudit({ action: 'Log Activity', username: user.username, role: user.role, details: `${type}: ${(text || '').substring(0, 100)}`, targetId: lead_id, ip });
    return { statusCode: 201, headers: CORS, body: JSON.stringify({ activity: data }) };
  }

  if (event.httpMethod === 'DELETE') {
    const id = q.id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    const { data: activity } = await sb.from('activities').select('lead_id').eq('id', id).maybeSingle();
    if (!activity) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Activity not found' }) };
    const access = await assertLeadAccess(sb, activity.lead_id, user);
    if (!access.ok) return { statusCode: access.statusCode, headers: CORS, body: JSON.stringify({ error: access.error }) };
    const { error } = await sb.from('activities').delete().eq('id', id);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
