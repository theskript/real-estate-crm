import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, cleanupDb, mkEvent, fn } from './setup.cjs';

describe('auth-login', () => {
  let dbPath;
  beforeEach(() => { dbPath = freshDb(); });
  afterEach(() => cleanupDb(dbPath));

  it('logs in as bootstrap owner via ADMIN_PASSWORD when no agents exist', async () => {
    const authLogin = fn('auth-login.cjs');
    const res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'owner', password: process.env.ADMIN_PASSWORD } }));
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.role).toBe('owner');
    expect(data.token.split('.')).toHaveLength(3);
  });

  it('rejects the bootstrap login with a wrong password', async () => {
    const authLogin = fn('auth-login.cjs');
    const res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'owner', password: 'wrong' } }));
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
    const bootstrap = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'owner', password: process.env.ADMIN_PASSWORD } }));
    const bootstrapToken = JSON.parse(bootstrap.body).token;

    await agentsFn.handler(mkEvent({ method: 'POST', token: bootstrapToken, body: { username: 'jane', name: 'Jane Agent', password: 'correcthorse', role: 'agent' } }));

    const good = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'jane', password: 'correcthorse' } }));
    expect(good.statusCode).toBe(200);
    expect(JSON.parse(good.body).role).toBe('agent');

    const bad = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'jane', password: 'wrong' } }));
    expect(bad.statusCode).toBe(401);
  });

  it('rejects login for a deactivated agent', async () => {
    const authLogin = fn('auth-login.cjs');
    const agentsFn = fn('agents.cjs');
    const bootstrap = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'owner', password: process.env.ADMIN_PASSWORD } }));
    const bootstrapToken = JSON.parse(bootstrap.body).token;

    const created = await agentsFn.handler(mkEvent({ method: 'POST', token: bootstrapToken, body: { username: 'bob', name: 'Bob Agent', password: 'pw123456', role: 'agent' } }));
    const agentId = JSON.parse(created.body).agent.id;
    await agentsFn.handler(mkEvent({ method: 'DELETE', token: bootstrapToken, qs: { id: agentId } })); // soft-delete = deactivate

    const res = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'bob', password: 'pw123456' } }));
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests to protected endpoints with no token, and with a tampered token', async () => {
    const agentsFn = fn('agents.cjs');
    const noToken = await agentsFn.handler(mkEvent({ method: 'GET' }));
    expect(noToken.statusCode).toBe(401);

    const authLogin = fn('auth-login.cjs');
    const bootstrap = await authLogin.handler(mkEvent({ method: 'POST', body: { username: 'owner', password: process.env.ADMIN_PASSWORD } }));
    const token = JSON.parse(bootstrap.body).token;
    const tampered = token.slice(0, -2) + 'xx';
    const res = await agentsFn.handler(mkEvent({ method: 'GET', token: tampered }));
    expect(res.statusCode).toBe(401);
  });
});
