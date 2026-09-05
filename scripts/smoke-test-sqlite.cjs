'use strict';
// One-off smoke test for the SQLite fallback shim — exercises the REAL
// netlify function handlers (unmodified) end-to-end. Not part of the app;
// safe to delete after verifying. Run with: node scripts/smoke-test-sqlite.cjs
process.env.DB_PROVIDER = 'sqlite';
process.env.ADMIN_JWT_SECRET = 'test-secret';
process.env.ADMIN_PASSWORD = 'bootstrap123';

const fs = require('fs');
const path = require('path');
const dbPath = path.join(__dirname, '..', 'data', 'teaka.sqlite');
fs.rmSync(dbPath, { force: true });
fs.rmSync(dbPath + '-wal', { force: true });
fs.rmSync(dbPath + '-shm', { force: true });

const FN = path.join(__dirname, '..', 'netlify', 'functions');
const authLogin = require(path.join(FN, 'auth-login.cjs'));
const agentsFn = require(path.join(FN, 'agents.cjs'));
const leadsFn = require(path.join(FN, 'leads.cjs'));
const tagsFn = require(path.join(FN, 'tags.cjs'));
const activitiesFn = require(path.join(FN, 'activities.cjs'));
const tasksFn = require(path.join(FN, 'tasks.cjs'));
const propertiesFn = require(path.join(FN, 'properties.cjs'));
const matchesFn = require(path.join(FN, 'lead-property-matches.cjs'));
const settingsFn = require(path.join(FN, 'settings.cjs'));
const dashboardFn = require(path.join(FN, 'dashboard-stats.cjs'));
const auditFn = require(path.join(FN, 'audit.cjs'));

let failures = 0;
function ok(label, cond, extra) {
  if (cond) { console.log(`  ✓ ${label}`); }
  else { failures++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra) : ''); }
}

function mkEvent({ method = 'GET', token, body, qs = {} }) {
  return {
    httpMethod: method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    queryStringParameters: qs,
    body: body ? JSON.stringify(body) : undefined,
  };
}

(async () => {
  console.log('1) Bootstrap owner login (no agents row yet)');
  let res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'owner', password: 'bootstrap123' } }));
  ok('login 200', res.statusCode === 200, res.body);
  const ownerToken = JSON.parse(res.body).token;

  console.log('2) Create a real owner + an agent');
  res = await agentsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { username: 'owner2', name: 'Real Owner', password: 'pw123456', role: 'owner' } }));
  ok('create owner 201', res.statusCode === 201, res.body);
  res = await agentsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { username: 'agent1', name: 'Agent One', password: 'pw123456', role: 'agent' } }));
  ok('create agent 201', res.statusCode === 201, res.body);
  const agent1 = JSON.parse(res.body).agent;

  res = await agentsFn.handler(mkEvent({ method: 'GET', token: ownerToken }));
  ok('list agents 200 & has 2 entries', res.statusCode === 200 && JSON.parse(res.body).agents.length === 2, res.body);

  console.log('2b) Switch to the real owner account for all further calls (bootstrap pseudo-user has no agents row / FK target)');
  res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'owner2', password: 'pw123456' } }));
  ok('real owner login 200', res.statusCode === 200, res.body);
  const realOwnerToken = JSON.parse(res.body).token;

  console.log('3) Login as the new agent');
  res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'agent1', password: 'pw123456' } }));
  ok('agent login 200', res.statusCode === 200, res.body);
  const agentToken = JSON.parse(res.body).token;

  console.log('4) Create tags');
  res = await tagsFn.handler(mkEvent({ method: 'GET', token: realOwnerToken }));
  ok('list tags 200 & seeded 5', res.statusCode === 200 && JSON.parse(res.body).tags.length === 5, res.body);
  const seededTag = JSON.parse(res.body).tags[0];

  console.log('5) Create a buyer lead assigned to agent1, with tags');
  res = await leadsFn.handler(mkEvent({ method: 'POST', token: realOwnerToken, body: {
    first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com', phone: '555-1234',
    lead_type: 'buyer', temperature: 'hot', source: 'Zillow', assigned_agent_id: agent1.id,
    tag_ids: [seededTag.id],
  }}));
  ok('create lead 201', res.statusCode === 201, res.body);
  let lead = JSON.parse(res.body).lead;
  ok('lead has embedded tags array with 1 tag', Array.isArray(lead.tags) && lead.tags.length === 1 && lead.tags[0].name === seededTag.name, lead);
  ok('lead has embedded agent object', lead.agent && lead.agent.name === 'Agent One', lead);

  console.log('6) Agent can see own lead, owner can see it too, filters work');
  res = await leadsFn.handler(mkEvent({ method: 'GET', token: agentToken }));
  ok('agent sees exactly 1 lead (own book)', res.statusCode === 200 && JSON.parse(res.body).leads.length === 1, res.body);
  res = await leadsFn.handler(mkEvent({ method: 'GET', token: realOwnerToken, qs: { temperature: 'hot' } }));
  ok('owner filter by temperature=hot finds it', res.statusCode === 200 && JSON.parse(res.body).leads.length === 1, res.body);
  res = await leadsFn.handler(mkEvent({ method: 'GET', token: realOwnerToken, qs: { search: 'jane' } }));
  ok('owner search "jane" finds it', res.statusCode === 200 && JSON.parse(res.body).leads.length === 1, res.body);

  console.log('7) PATCH lead stage + temperature, verify status_change activity logged');
  res = await leadsFn.handler(mkEvent({ method: 'PATCH', token: agentToken, qs: { id: lead.id }, body: { stage: 'contacted', temperature: 'warm' } }));
  ok('patch lead 200', res.statusCode === 200, res.body);
  lead = JSON.parse(res.body).lead;
  ok('stage updated', lead.stage === 'contacted');
  ok('temperature updated', lead.temperature === 'warm');

  res = await activitiesFn.handler(mkEvent({ method: 'GET', token: agentToken, qs: { lead_id: lead.id } }));
  ok('activities include creation + status_change', res.statusCode === 200 && JSON.parse(res.body).activities.length === 2, res.body);

  console.log('8) Log a call activity, verify last_contacted_at bumped');
  res = await activitiesFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { lead_id: lead.id, type: 'call', direction: 'outbound', body: 'Left voicemail', duration_seconds: 45 } }));
  ok('log activity 201', res.statusCode === 201, res.body);
  res = await leadsFn.handler(mkEvent({ method: 'GET', token: agentToken, qs: { id: lead.id } }));
  lead = JSON.parse(res.body).lead;
  ok('last_contacted_at set', !!lead.last_contacted_at, lead);

  console.log('9) Create a task, complete it');
  res = await tasksFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { lead_id: lead.id, title: 'Follow up call', due_at: new Date().toISOString() } }));
  ok('create task 201', res.statusCode === 201, res.body);
  const task = JSON.parse(res.body).task;
  ok('task embeds lead + agent', task.lead && task.lead.first_name === 'Jane' && task.agent && task.agent.name === 'Agent One', task);
  res = await tasksFn.handler(mkEvent({ method: 'PATCH', token: agentToken, qs: { id: task.id }, body: { status: 'completed' } }));
  ok('complete task 200', res.statusCode === 200 && JSON.parse(res.body).task.status === 'completed', res.body);

  console.log('10) Property + buyer match');
  res = await propertiesFn.handler(mkEvent({ method: 'POST', token: realOwnerToken, body: { address: '123 Main St', city: 'Austin', state: 'TX', price: 450000, beds: 3, baths: 2 } }));
  ok('create property 201', res.statusCode === 201, res.body);
  const property = JSON.parse(res.body).property;
  res = await matchesFn.handler(mkEvent({ method: 'POST', token: realOwnerToken, body: { lead_id: lead.id, property_id: property.id } }));
  ok('create match 201', res.statusCode === 201, res.body);
  res = await propertiesFn.handler(mkEvent({ method: 'GET', token: realOwnerToken, qs: { id: property.id } }));
  const fullProperty = JSON.parse(res.body).property;
  ok('property.matches has 1 entry with nested lead', fullProperty.matches && fullProperty.matches.length === 1 && fullProperty.matches[0].lead.first_name === 'Jane', fullProperty);

  console.log('11) Settings read/write');
  res = await settingsFn.handler(mkEvent({ method: 'PATCH', token: realOwnerToken, body: { lead_sources: 'A,B,C' } }));
  ok('patch settings 200', res.statusCode === 200, res.body);
  res = await settingsFn.handler(mkEvent({ method: 'GET', token: realOwnerToken }));
  ok('settings reflect update', JSON.parse(res.body).settings.lead_sources === 'A,B,C', res.body);

  console.log('12) Dashboard stats + audit log');
  res = await dashboardFn.handler(mkEvent({ method: 'GET', token: realOwnerToken }));
  ok('dashboard stats 200', res.statusCode === 200, res.body);
  res = await auditFn.handler(mkEvent({ method: 'GET', token: realOwnerToken }));
  ok('audit log has entries', res.statusCode === 200 && JSON.parse(res.body).entries.length > 0, res.body);

  console.log('13) Non-owner access control: agent cannot delete a lead or see audit log');
  res = await leadsFn.handler(mkEvent({ method: 'DELETE', token: agentToken, qs: { id: lead.id } }));
  ok('agent delete lead forbidden (403)', res.statusCode === 403, res.body);
  res = await auditFn.handler(mkEvent({ method: 'GET', token: agentToken }));
  ok('agent audit log forbidden (401/403)', res.statusCode === 401 || res.statusCode === 403, res.body);

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(err => { console.error('CRASH', err); process.exit(1); });
