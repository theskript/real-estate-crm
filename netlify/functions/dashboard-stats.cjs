'use strict';

const { requireAuth, getSupabase, scopedTable, cors } = require('./_utils.cjs');

const CORS = cors('GET');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let user;
  try { user = requireAuth(event); } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  const sb = getSupabase();
  const isOwner = user.role === 'owner';

  let leadsQuery = scopedTable(sb, user, 'leads').select('id,lead_type,temperature,stage,next_follow_up_at,last_contacted_at,created_at,assigned_agent_id');
  if (!isOwner) leadsQuery = leadsQuery.eq('assigned_agent_id', user.sub);
  let tasksQuery = scopedTable(sb, user, 'tasks').select('id,status,due_at,agent_id').eq('status', 'pending');
  if (!isOwner) tasksQuery = tasksQuery.eq('agent_id', user.sub);

  const [{ data: leads, error: le }, { data: tasks, error: te }] = await Promise.all([leadsQuery, tasksQuery]);
  if (le || te) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: (le || te).message }) };

  const now = Date.now();
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);

  const openLeads = (leads || []).filter(l => !['closed_won', 'closed_lost'].includes(l.stage));
  const stats = {
    total_leads: leads.length,
    open_leads: openLeads.length,
    hot_leads: openLeads.filter(l => l.temperature === 'hot').length,
    buyer_leads: openLeads.filter(l => l.lead_type === 'buyer').length,
    seller_leads: openLeads.filter(l => l.lead_type === 'seller').length,
    closed_won: (leads || []).filter(l => l.stage === 'closed_won').length,
    overdue_followups: openLeads.filter(l => l.next_follow_up_at && new Date(l.next_follow_up_at).getTime() < now).length,
    stale_hot_leads: openLeads.filter(l => l.temperature === 'hot' &&
      (!l.last_contacted_at || (now - new Date(l.last_contacted_at).getTime()) > 24 * 3600 * 1000)).length,
    tasks_due_today: (tasks || []).filter(t => t.due_at && new Date(t.due_at) >= startOfToday && new Date(t.due_at) <= endOfToday).length,
    tasks_overdue: (tasks || []).filter(t => t.due_at && new Date(t.due_at).getTime() < now).length,
    by_stage: {},
  };
  for (const l of openLeads) stats.by_stage[l.stage] = (stats.by_stage[l.stage] || 0) + 1;

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ stats }) };
};
