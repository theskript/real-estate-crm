import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, cleanupDb, mkEvent, fn, createOwnerAndAgent } from './setup.cjs';

describe('leads — CRUD, embeds, filters', () => {
  let dbPath, ownerToken, agentToken, agentId;
  beforeEach(async () => {
    dbPath = freshDb();
    const setup = await createOwnerAndAgent();
    ownerToken = setup.ownerToken;
    agentToken = setup.agentToken;
    agentId = setup.agent.id;
  });
  afterEach(() => cleanupDb(dbPath));

  it('creates a lead with tags and returns embedded tag + agent objects', async () => {
    const leadsFn = fn('leads.cjs');
    const tagsFn = fn('tags.cjs');
    const tagsRes = await tagsFn.handler(mkEvent({ method: 'GET', token: ownerToken }));
    const tags = JSON.parse(tagsRes.body).tags;
    expect(tags.length).toBeGreaterThan(0);

    const res = await leadsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: {
      first_name: 'Jennifer', last_name: 'Walsh', lead_type: 'buyer', temperature: 'hot',
      assigned_agent_id: agentId, tag_ids: [tags[0].id],
    } }));
    expect(res.statusCode).toBe(201);
    const lead = JSON.parse(res.body).lead;
    expect(lead.tags).toHaveLength(1);
    expect(lead.tags[0].id).toBe(tags[0].id);
    expect(lead.agent.id).toBe(agentId);
  });

  it('an activity note is automatically logged when a lead is created', async () => {
    const leadsFn = fn('leads.cjs');
    const activitiesFn = fn('activities.cjs');
    const created = await leadsFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { first_name: 'Amy', lead_type: 'seller' } }));
    const leadId = JSON.parse(created.body).lead.id;
    const activities = await activitiesFn.handler(mkEvent({ method: 'GET', token: agentToken, qs: { lead_id: leadId } }));
    const list = JSON.parse(activities.body).activities;
    expect(list.some(a => a.type === 'note')).toBe(true);
  });

  it('changing stage/temperature logs a status_change activity', async () => {
    const leadsFn = fn('leads.cjs');
    const activitiesFn = fn('activities.cjs');
    const created = await leadsFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { first_name: 'Amy', lead_type: 'seller' } }));
    const leadId = JSON.parse(created.body).lead.id;

    await leadsFn.handler(mkEvent({ method: 'PATCH', token: agentToken, qs: { id: leadId }, body: { stage: 'contacted', temperature: 'hot' } }));
    const activities = await activitiesFn.handler(mkEvent({ method: 'GET', token: agentToken, qs: { lead_id: leadId } }));
    const list = JSON.parse(activities.body).activities;
    const change = list.find(a => a.type === 'status_change');
    expect(change).toBeTruthy();
    expect(change.body).toContain('contacted');
    expect(change.body).toContain('hot');
  });

  it('filters by lead_type, temperature, stage, and search', async () => {
    const leadsFn = fn('leads.cjs');
    await leadsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { first_name: 'Hot', last_name: 'Buyer', lead_type: 'buyer', temperature: 'hot' } }));
    await leadsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { first_name: 'Cold', last_name: 'Seller', lead_type: 'seller', temperature: 'cold' } }));

    const byType = await leadsFn.handler(mkEvent({ method: 'GET', token: ownerToken, qs: { lead_type: 'seller' } }));
    expect(JSON.parse(byType.body).leads).toHaveLength(1);

    const byTemp = await leadsFn.handler(mkEvent({ method: 'GET', token: ownerToken, qs: { temperature: 'hot' } }));
    expect(JSON.parse(byTemp.body).leads).toHaveLength(1);

    const bySearch = await leadsFn.handler(mkEvent({ method: 'GET', token: ownerToken, qs: { search: 'Buyer' } }));
    expect(JSON.parse(bySearch.body).leads).toHaveLength(1);
    expect(JSON.parse(bySearch.body).leads[0].first_name).toBe('Hot');
  });

  it('auto_assign picks the agent with fewer open leads', async () => {
    const leadsFn = fn('leads.cjs');
    const agentsFn = fn('agents.cjs');
    const authLogin = fn('auth-login.cjs');
    await agentsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { username: 'agent2', name: 'Agent Two', password: 'pw123456', role: 'agent' } }));
    const login2 = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'agent2', password: 'pw123456' } }));
    const agent2Id = JSON.parse(login2.body).agentId;

    // Load up agent1 with 2 leads first
    await leadsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { first_name: 'A', lead_type: 'buyer', assigned_agent_id: agentId } }));
    await leadsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { first_name: 'B', lead_type: 'buyer', assigned_agent_id: agentId } }));

    const res = await leadsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { first_name: 'C', lead_type: 'buyer', auto_assign: true } }));
    const lead = JSON.parse(res.body).lead;
    expect(lead.assigned_agent_id).toBe(agent2Id);
  });

  it('rejects creating a lead with missing required fields', async () => {
    const leadsFn = fn('leads.cjs');
    const res = await leadsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { first_name: 'NoType' } }));
    expect(res.statusCode).toBe(400);
  });
});
