import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, cleanupDb, mkEvent, fn, bootstrapOwnerToken, createOwnerAndAgent } from './setup.cjs';

describe('access control — per-agent lead visibility', () => {
  let dbPath, ownerToken, agentToken, agent2Token, leadId;
  beforeEach(async () => {
    dbPath = freshDb();
    const bootstrapToken = await bootstrapOwnerToken();
    const setup = await createOwnerAndAgent(bootstrapToken, { username: 'agent1', name: 'Agent One' });
    ownerToken = setup.ownerToken;
    agentToken = setup.agentToken;

    const agentsFn = fn('agents.cjs');
    const authLogin = fn('auth-login.cjs');
    await agentsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { username: 'agent2', name: 'Agent Two', password: 'pw123456', role: 'agent' } }));
    const login2 = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'agent2', password: 'pw123456' } }));
    agent2Token = JSON.parse(login2.body).token;

    const leadsFn = fn('leads.cjs');
    const created = await leadsFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { first_name: 'Jane', last_name: 'Doe', lead_type: 'buyer' } }));
    leadId = JSON.parse(created.body).lead.id;
  });
  afterEach(() => cleanupDb(dbPath));

  it('the owning agent can see and fetch their own lead', async () => {
    const leadsFn = fn('leads.cjs');
    const list = await leadsFn.handler(mkEvent({ method: 'GET', token: agentToken }));
    expect(JSON.parse(list.body).leads).toHaveLength(1);
    const single = await leadsFn.handler(mkEvent({ method: 'GET', token: agentToken, qs: { id: leadId } }));
    expect(single.statusCode).toBe(200);
  });

  it('a different agent cannot see, fetch, edit, or delete that lead', async () => {
    const leadsFn = fn('leads.cjs');
    const list = await leadsFn.handler(mkEvent({ method: 'GET', token: agent2Token }));
    expect(JSON.parse(list.body).leads).toHaveLength(0);

    const single = await leadsFn.handler(mkEvent({ method: 'GET', token: agent2Token, qs: { id: leadId } }));
    expect(single.statusCode).toBe(404);

    const patch = await leadsFn.handler(mkEvent({ method: 'PATCH', token: agent2Token, qs: { id: leadId }, body: { temperature: 'hot' } }));
    expect(patch.statusCode).toBe(403);

    const del = await leadsFn.handler(mkEvent({ method: 'DELETE', token: agent2Token, qs: { id: leadId } }));
    expect(del.statusCode).toBe(403);
  });

  it('the owner sees every lead regardless of assignment', async () => {
    const leadsFn = fn('leads.cjs');
    const list = await leadsFn.handler(mkEvent({ method: 'GET', token: ownerToken }));
    expect(JSON.parse(list.body).leads).toHaveLength(1);
    const single = await leadsFn.handler(mkEvent({ method: 'GET', token: ownerToken, qs: { id: leadId } }));
    expect(single.statusCode).toBe(200);
  });

  it('only the owner can delete a lead, even their own', async () => {
    const leadsFn = fn('leads.cjs');
    const del = await leadsFn.handler(mkEvent({ method: 'DELETE', token: agentToken, qs: { id: leadId } }));
    expect(del.statusCode).toBe(403);
  });

  it('agents cannot manage the team or read the audit log; owners can', async () => {
    const agentsFn = fn('agents.cjs');
    const auditFn = fn('audit.cjs');

    const agentCreateAttempt = await agentsFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { username: 'x', name: 'X', password: 'pw123456' } }));
    expect(agentCreateAttempt.statusCode).toBe(403);

    const agentAudit = await auditFn.handler(mkEvent({ method: 'GET', token: agentToken }));
    expect(agentAudit.statusCode).toBe(403);

    const ownerAudit = await auditFn.handler(mkEvent({ method: 'GET', token: ownerToken }));
    expect(ownerAudit.statusCode).toBe(200);
  });

  it('a second agent cannot see or complete tasks belonging to the first agent', async () => {
    const tasksFn = fn('tasks.cjs');
    const created = await tasksFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { lead_id: leadId, title: 'Call Jane' } }));
    const taskId = JSON.parse(created.body).task.id;

    const otherList = await tasksFn.handler(mkEvent({ method: 'GET', token: agent2Token }));
    expect(JSON.parse(otherList.body).tasks).toHaveLength(0);

    const patch = await tasksFn.handler(mkEvent({ method: 'PATCH', token: agent2Token, qs: { id: taskId }, body: { status: 'completed' } }));
    expect(patch.statusCode).toBe(403);
  });
});
