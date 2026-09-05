'use strict';

const { requireAuth, getSupabase, cors, logAudit, getClientIP } = require('./_utils.cjs');

const CORS = cors('GET, POST, PATCH, DELETE');
const TASK_SELECT = '*, lead:leads(id,first_name,last_name,lead_type,temperature), agent:agents(id,name,avatar_color)';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  let user;
  try { user = requireAuth(event); } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  const sb = getSupabase();
  const ip = getClientIP(event);
  const isOwner = user.role === 'owner';
  const q = event.queryStringParameters || {};

  if (event.httpMethod === 'GET') {
    let query = sb.from('tasks').select(TASK_SELECT).order('due_at', { ascending: true, nullsFirst: false });
    if (!isOwner) query = query.eq('agent_id', user.sub);
    else if (q.agent_id) query = query.eq('agent_id', q.agent_id);

    if (q.status) query = query.eq('status', q.status);
    if (q.lead_id) query = query.eq('lead_id', q.lead_id);
    if (q.due_before) query = query.lte('due_at', q.due_before);
    if (q.due_after) query = query.gte('due_at', q.due_after);

    const { data, error } = await query;
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ tasks: data }) };
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    if (!body.title) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'title is required' }) };
    const agent_id = body.agent_id || user.sub;
    const { data, error } = await sb.from('tasks').insert({ ...body, agent_id }).select(TASK_SELECT).single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Create Task', username: user.username, role: user.role, details: body.title, targetId: data.id, ip });
    return { statusCode: 201, headers: CORS, body: JSON.stringify({ task: data }) };
  }

  if (event.httpMethod === 'PATCH') {
    const id = q.id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    const { data: existing } = await sb.from('tasks').select('agent_id').eq('id', id).maybeSingle();
    if (!existing) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Task not found' }) };
    if (!isOwner && existing.agent_id !== user.sub) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'You can only edit your own tasks' }) };
    }
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    if (body.status === 'completed' && !body.completed_at) body.completed_at = new Date().toISOString();
    const { data, error } = await sb.from('tasks').update(body).eq('id', id).select(TASK_SELECT).single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ task: data }) };
  }

  if (event.httpMethod === 'DELETE') {
    const id = q.id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    const { data: existing } = await sb.from('tasks').select('agent_id').eq('id', id).maybeSingle();
    if (!existing) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Task not found' }) };
    if (!isOwner && existing.agent_id !== user.sub) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'You can only delete your own tasks' }) };
    }
    const { error } = await sb.from('tasks').delete().eq('id', id);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
