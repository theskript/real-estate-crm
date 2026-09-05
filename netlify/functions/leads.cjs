'use strict';

const { requireAuth, getSupabase, cors, logAudit, getClientIP } = require('./_utils.cjs');

const CORS = cors('GET, POST, PATCH, DELETE');
const LEAD_SELECT = '*, tags:lead_tags(tag:tags(id,name,color)), agent:agents(id,name,avatar_color)';

/** Flattens the nested tags/agent join into a simpler shape for the client. */
function shapeLead(row) {
  if (!row) return null;
  const { tags, agent, ...rest } = row;
  return { ...rest, tags: (tags || []).map(t => t.tag).filter(Boolean), agent: agent || null };
}

async function syncTags(sb, leadId, tagIds) {
  if (!Array.isArray(tagIds)) return;
  await sb.from('lead_tags').delete().eq('lead_id', leadId);
  if (tagIds.length) {
    await sb.from('lead_tags').insert(tagIds.map(tag_id => ({ lead_id: leadId, tag_id })));
  }
}

/** Picks the active agent with the fewest open leads — simple round-robin assignment. */
async function autoAssignAgent(sb) {
  const { data: agents } = await sb.from('agents').select('id').eq('role', 'agent').eq('active', true);
  if (!agents || !agents.length) return null;
  const { data: openLeads } = await sb.from('leads').select('assigned_agent_id')
    .not('stage', 'in', '(closed_won,closed_lost)');
  const counts = Object.fromEntries(agents.map(a => [a.id, 0]));
  for (const l of openLeads || []) if (l.assigned_agent_id in counts) counts[l.assigned_agent_id]++;
  return agents.reduce((best, a) => (counts[a.id] < counts[best.id] ? a : best), agents[0]).id;
}

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

  // ── GET — list (with filters) or single lead by id ────────────────────────
  if (event.httpMethod === 'GET') {
    if (q.id) {
      let query = sb.from('leads').select(LEAD_SELECT).eq('id', q.id);
      if (!isOwner) query = query.eq('assigned_agent_id', user.sub);
      const { data, error } = await query.maybeSingle();
      if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
      if (!data) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Lead not found' }) };
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ lead: shapeLead(data) }) };
    }

    let query = sb.from('leads').select(LEAD_SELECT).order('created_at', { ascending: false });
    // Access control: agents only ever see their own book; owner may filter by agent
    if (!isOwner) query = query.eq('assigned_agent_id', user.sub);
    else if (q.assigned_agent_id) query = query.eq('assigned_agent_id', q.assigned_agent_id);

    if (q.lead_type) query = query.eq('lead_type', q.lead_type);
    if (q.temperature) query = query.eq('temperature', q.temperature);
    if (q.stage) query = query.eq('stage', q.stage);
    if (q.source) query = query.eq('source', q.source);
    if (q.search) {
      const s = q.search.replace(/'/g, '').substring(0, 100);
      query = query.or(`first_name.ilike.%${s}%,last_name.ilike.%${s}%,email.ilike.%${s}%,phone.ilike.%${s}%`);
    }

    const { data, error } = await query;
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    let leads = (data || []).map(shapeLead);
    if (q.tag_id) leads = leads.filter(l => l.tags.some(t => t.id === q.tag_id));
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ leads }) };
  }

  // ── POST — create lead ─────────────────────────────────────────────────────
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const { tag_ids, auto_assign, ...fields } = body;
    if (!fields.first_name || !fields.lead_type) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'first_name and lead_type are required' }) };
    }
    if (auto_assign) fields.assigned_agent_id = await autoAssignAgent(sb);
    else if (!fields.assigned_agent_id && !isOwner) fields.assigned_agent_id = user.sub;

    const { data, error } = await sb.from('leads').insert(fields).select(LEAD_SELECT).single();
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await syncTags(sb, data.id, tag_ids);
    await sb.from('activities').insert({ lead_id: data.id, agent_id: user.sub, type: 'note', body: 'Lead created' });
    await logAudit({ action: 'Create Lead', username: user.username, role: user.role, details: `${fields.first_name} ${fields.last_name || ''}`.trim(), targetId: data.id, ip });
    const { data: full } = await sb.from('leads').select(LEAD_SELECT).eq('id', data.id).single();
    return { statusCode: 201, headers: CORS, body: JSON.stringify({ lead: shapeLead(full) }) };
  }

  // ── PATCH — update lead (fields, stage, temperature, assignment, tags) ────
  if (event.httpMethod === 'PATCH') {
    const id = q.id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };

    const { data: existing } = await sb.from('leads').select('assigned_agent_id,stage,temperature').eq('id', id).maybeSingle();
    if (!existing) return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Lead not found' }) };
    if (!isOwner && existing.assigned_agent_id !== user.sub) {
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'You can only edit leads assigned to you' }) };
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }
    const { tag_ids, ...fields } = body;
    delete fields.id;

    if (Object.keys(fields).length) {
      const { error } = await sb.from('leads').update(fields).eq('id', id);
      if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    }
    await syncTags(sb, id, tag_ids);

    // Log a stage/temperature change as a timeline activity so it shows up alongside calls/notes
    const changes = [];
    if (fields.stage && fields.stage !== existing.stage) changes.push(`stage → ${fields.stage}`);
    if (fields.temperature && fields.temperature !== existing.temperature) changes.push(`temperature → ${fields.temperature}`);
    if (changes.length) {
      await sb.from('activities').insert({ lead_id: id, agent_id: user.sub, type: 'status_change', body: changes.join(', ') });
    }

    await logAudit({ action: 'Update Lead', username: user.username, role: user.role, details: JSON.stringify(fields), targetId: id, ip });
    const { data: full } = await sb.from('leads').select(LEAD_SELECT).eq('id', id).single();
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ lead: shapeLead(full) }) };
  }

  // ── DELETE ─────────────────────────────────────────────────────────────────
  if (event.httpMethod === 'DELETE') {
    const id = q.id;
    if (!id) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'id is required' }) };
    if (!isOwner) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Owner access required' }) };
    const { error } = await sb.from('leads').delete().eq('id', id);
    if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };
    await logAudit({ action: 'Delete Lead', username: user.username, role: user.role, details: id, ip });
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
