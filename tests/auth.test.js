import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, cleanupDb, mkEvent, fn, provisionOrg } from './setup.cjs';

describe('auth-login', () => {
  let dbPath;
  beforeEach(() => { dbPath = freshDb(); });
  afterEach(() => cleanupDb(dbPath));

  it('logs in a real owner agent created via provisioning, with organization_id in the token', async () => {
    const authLogin = fn('auth-login.cjs');
    const { org } = await provisionOrg({ ownerUsername: 'sarah', ownerPassword: 'correcthorse' });
    const res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'sarah', password: 'correcthorse' } }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.role).toBe('owner');
    expect(data.token.split('.')).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.organization_id).toBe(org.id);
  });

  it('rejects a wrong password', async () => {
    const authLogin = fn('auth-login.cjs');
    await provisionOrg({ ownerUsername: 'sarah', ownerPassword: 'correcthorse' });
    const res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'sarah', password: 'wrong' } }));
    expect(res.statusCode).toBe(401);
  });

  it('rejects an unknown username entirely', async () => {
    const authLogin = fn('auth-login.cjs');
    const res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'nobody', password: 'whatever' } }));
    expect(res.statusCode).toBe(401);
  });

  it('logs in a real agent row created via the agents API, and rejects their wrong password', async () => {
    const authLogin = fn('auth-login.cjs');
    const agentsFn = fn('agents.cjs');
    const { ownerToken } = await provisionOrg();

    await agentsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { username: 'jane', name: 'Jane Agent', password: 'correcthorse', role: 'agent' } }));

    const good = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'jane', password: 'correcthorse' } }));
    expect(good.statusCode).toBe(200);
    expect(JSON.parse(good.body).role).toBe('agent');

    const bad = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'jane', password: 'wrong' } }));
    expect(bad.statusCode).toBe(401);
  });

  it('rejects login for a deactivated agent', async () => {
    const authLogin = fn('auth-login.cjs');
    const agentsFn = fn('agents.cjs');
    const { ownerToken } = await provisionOrg();

    const created = await agentsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { username: 'bob', name: 'Bob Agent', password: 'pw123456', role: 'agent' } }));
    const agentId = JSON.parse(created.body).agent.id;
    await agentsFn.handler(mkEvent({ method: 'DELETE', token: ownerToken, qs: { id: agentId } })); // soft-delete = deactivate

    const res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'bob', password: 'pw123456' } }));
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests to protected endpoints with no token, and with a tampered token', async () => {
    const agentsFn = fn('agents.cjs');
    const noToken = await agentsFn.handler(mkEvent({ method: 'GET' }));
    expect(noToken.statusCode).toBe(401);

    const { ownerToken } = await provisionOrg();
    const tampered = ownerToken.slice(0, -2) + 'xx';
    const res = await agentsFn.handler(mkEvent({ method: 'GET', token: tampered }));
    expect(res.statusCode).toBe(401);
  });
});
