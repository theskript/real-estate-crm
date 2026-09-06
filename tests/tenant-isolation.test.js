import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, cleanupDb, mkEvent, fn, provisionOrg } from './setup.cjs';

// The entire point of the multi-tenant retrofit: organization A must never be
// able to see, edit, or delete organization B's data, through any endpoint,
// even as an "owner" (owner only means "owner of MY org", never cross-org).
describe('tenant isolation — organization A cannot see organization B', () => {
  let dbPath, orgAToken, orgBToken, orgALeadId, orgBLeadId;

  beforeEach(async () => {
    dbPath = freshDb();
    const a = await provisionOrg({ orgName: 'Org A', ownerUsername: 'owner.a', ownerPassword: 'pw123456' });
    const b = await provisionOrg({ orgName: 'Org B', ownerUsername: 'owner.b', ownerPassword: 'pw123456' });
    orgAToken = a.ownerToken;
    orgBToken = b.ownerToken;

    const leadsFn = fn('leads.cjs');
    const leadA = await leadsFn.handler(mkEvent({ method: 'POST', token: orgAToken, body: { first_name: 'Alice', lead_type: 'buyer' } }));
    orgALeadId = JSON.parse(leadA.body).lead.id;
    const leadB = await leadsFn.handler(mkEvent({ method: 'POST', token: orgBToken, body: { first_name: 'Bob', lead_type: 'buyer' } }));
    orgBLeadId = JSON.parse(leadB.body).lead.id;
  });
  afterEach(() => cleanupDb(dbPath));

  it('leads list only shows the caller\u2019s own organization', async () => {
    const leadsFn = fn('leads.cjs');
    const asA = await leadsFn.handler(mkEvent({ method: 'GET', token: orgAToken }));
    const namesA = JSON.parse(asA.body).leads.map(l => l.first_name);
    expect(namesA).toEqual(['Alice']);

    const asB = await leadsFn.handler(mkEvent({ method: 'GET', token: orgBToken }));
    const namesB = JSON.parse(asB.body).leads.map(l => l.first_name);
    expect(namesB).toEqual(['Bob']);
  });

  it('org B cannot fetch, edit, or delete org A\u2019s lead by id, even though both are "owner"', async () => {
    const leadsFn = fn('leads.cjs');
    const get = await leadsFn.handler(mkEvent({ method: 'GET', token: orgBToken, qs: { id: orgALeadId } }));
    expect(get.statusCode).toBe(404);

    const patch = await leadsFn.handler(mkEvent({ method: 'PATCH', token: orgBToken, qs: { id: orgALeadId }, body: { temperature: 'hot' } }));
    expect(patch.statusCode).toBe(404);

    const del = await leadsFn.handler(mkEvent({ method: 'DELETE', token: orgBToken, qs: { id: orgALeadId } }));
    expect(del.statusCode).toBe(404);
  });

  it('org B cannot see org A\u2019s agents, tags, tasks, properties, or audit log', async () => {
    const agentsFn = fn('agents.cjs');
    const tagsFn = fn('tags.cjs');
    const tasksFn = fn('tasks.cjs');
    const propertiesFn = fn('properties.cjs');
    const auditFn = fn('audit.cjs');

    const agentsA = await agentsFn.handler(mkEvent({ method: 'GET', token: orgAToken }));
    const agentsB = await agentsFn.handler(mkEvent({ method: 'GET', token: orgBToken }));
    const idsA = new Set(JSON.parse(agentsA.body).agents.map(a => a.id));
    const idsB = JSON.parse(agentsB.body).agents.map(a => a.id);
    expect(idsB.some(id => idsA.has(id))).toBe(false);

    await tasksFn.handler(mkEvent({ method: 'POST', token: orgAToken, body: { lead_id: orgALeadId, title: 'Org A private task' } }));
    const tasksB = await tasksFn.handler(mkEvent({ method: 'GET', token: orgBToken }));
    expect(JSON.parse(tasksB.body).tasks).toHaveLength(0);

    await propertiesFn.handler(mkEvent({ method: 'POST', token: orgAToken, body: { address: '1 Org A St' } }));
    const propsB = await propertiesFn.handler(mkEvent({ method: 'GET', token: orgBToken }));
    expect(JSON.parse(propsB.body).properties).toHaveLength(0);

    const tagsB = await tagsFn.handler(mkEvent({ method: 'GET', token: orgBToken }));
    const tagsA = await tagsFn.handler(mkEvent({ method: 'GET', token: orgAToken }));
    const tagIdsA = new Set(JSON.parse(tagsA.body).tags.map(t => t.id));
    const tagIdsB = JSON.parse(tagsB.body).tags.map(t => t.id);
    expect(tagIdsB.some(id => tagIdsA.has(id))).toBe(false);

    const auditB = await auditFn.handler(mkEvent({ method: 'GET', token: orgBToken }));
    const entriesB = JSON.parse(auditB.body).entries;
    expect(entriesB.every(e => !e.details?.includes('Alice'))).toBe(true);
  });

  it('org B cannot deactivate org A\u2019s agent by id', async () => {
    const agentsFn = fn('agents.cjs');
    const agentsA = await agentsFn.handler(mkEvent({ method: 'GET', token: orgAToken }));
    const orgAOwnerId = JSON.parse(agentsA.body).agents[0].id;

    const res = await agentsFn.handler(mkEvent({ method: 'DELETE', token: orgBToken, qs: { id: orgAOwnerId } }));
    // Either a 404 (not found in org B's scope) or a no-op 200 that touches
    // zero rows — either way, org A's agent must remain active afterward.
    expect([200, 404]).toContain(res.statusCode);

    const stillActive = await agentsFn.handler(mkEvent({ method: 'GET', token: orgAToken }));
    const orgAOwner = JSON.parse(stillActive.body).agents.find(a => a.id === orgAOwnerId);
    expect(orgAOwner.active).toBe(true);
  });

  it('dashboard stats are computed only from the caller\u2019s own organization', async () => {
    const dashboardFn = fn('dashboard-stats.cjs');
    const statsA = await dashboardFn.handler(mkEvent({ method: 'GET', token: orgAToken }));
    expect(JSON.parse(statsA.body).stats.total_leads).toBe(1);

    const statsB = await dashboardFn.handler(mkEvent({ method: 'GET', token: orgBToken }));
    expect(JSON.parse(statsB.body).stats.total_leads).toBe(1);
  });
});
