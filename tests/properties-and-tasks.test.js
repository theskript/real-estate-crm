import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { freshDb, cleanupDb, mkEvent, fn, createOwnerAndAgent } from './setup.cjs';

// These specifically guard against a real bug class found while building the
// SQLite fallback: nested embeds silently returning empty/null when a
// restricted column list omits the FK columns needed for grouping/joining.
describe('properties — nested embeds (seller_lead, matches.lead)', () => {
  let dbPath, ownerToken;
  beforeEach(async () => {
    dbPath = freshDb();
    ownerToken = (await createOwnerAndAgent()).ownerToken;
  });
  afterEach(() => cleanupDb(dbPath));

  it('embeds the linked seller lead on a property', async () => {
    const leadsFn = fn('leads.cjs');
    const propertiesFn = fn('properties.cjs');
    const sellerRes = await leadsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { first_name: 'Seller', last_name: 'Sam', lead_type: 'seller' } }));
    const sellerId = JSON.parse(sellerRes.body).lead.id;

    const propRes = await propertiesFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { address: '1 Main St', seller_lead_id: sellerId } }));
    const propertyId = JSON.parse(propRes.body).property.id;

    const single = await propertiesFn.handler(mkEvent({ method: 'GET', token: ownerToken, qs: { id: propertyId } }));
    const property = JSON.parse(single.body).property;
    expect(property.seller_lead).toBeTruthy();
    expect(property.seller_lead.first_name).toBe('Seller');
  });

  it('embeds interested buyer matches with the nested lead resolved (not null)', async () => {
    const leadsFn = fn('leads.cjs');
    const propertiesFn = fn('properties.cjs');
    const matchesFn = fn('lead-property-matches.cjs');

    const buyerRes = await leadsFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { first_name: 'Buyer', last_name: 'Bob', lead_type: 'buyer' } }));
    const buyerId = JSON.parse(buyerRes.body).lead.id;
    const propRes = await propertiesFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { address: '2 Oak St' } }));
    const propertyId = JSON.parse(propRes.body).property.id;

    await matchesFn.handler(mkEvent({ method: 'POST', token: ownerToken, body: { lead_id: buyerId, property_id: propertyId, status: 'interested' } }));

    const single = await propertiesFn.handler(mkEvent({ method: 'GET', token: ownerToken, qs: { id: propertyId } }));
    const property = JSON.parse(single.body).property;
    expect(property.matches).toHaveLength(1);
    expect(property.matches[0].status).toBe('interested');
    // Regression guard: this specifically was silently null before the
    // withRequiredCols() fix in _sqlite.cjs.
    expect(property.matches[0].lead).toBeTruthy();
    expect(property.matches[0].lead.first_name).toBe('Buyer');
  });
});

describe('tasks & activities', () => {
  let dbPath, ownerToken, agentToken, leadId;
  beforeEach(async () => {
    dbPath = freshDb();
    const setup = await createOwnerAndAgent();
    ownerToken = setup.ownerToken;
    agentToken = setup.agentToken;
    const leadsFn = fn('leads.cjs');
    const created = await leadsFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { first_name: 'Lead', last_name: 'Owner', lead_type: 'buyer' } }));
    leadId = JSON.parse(created.body).lead.id;
  });
  afterEach(() => cleanupDb(dbPath));

  it("logging a call activity bumps the lead's last_contacted_at", async () => {
    const activitiesFn = fn('activities.cjs');
    const leadsFn = fn('leads.cjs');
    const before = await leadsFn.handler(mkEvent({ method: 'GET', token: agentToken, qs: { id: leadId } }));
    expect(JSON.parse(before.body).lead.last_contacted_at).toBeFalsy();

    await activitiesFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { lead_id: leadId, type: 'call', direction: 'outbound', duration_seconds: 30 } }));

    const after = await leadsFn.handler(mkEvent({ method: 'GET', token: agentToken, qs: { id: leadId } }));
    expect(JSON.parse(after.body).lead.last_contacted_at).toBeTruthy();
  });

  it('logging a plain note does NOT bump last_contacted_at', async () => {
    const activitiesFn = fn('activities.cjs');
    const leadsFn = fn('leads.cjs');
    await activitiesFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { lead_id: leadId, type: 'note', body: 'internal note' } }));
    const after = await leadsFn.handler(mkEvent({ method: 'GET', token: agentToken, qs: { id: leadId } }));
    expect(JSON.parse(after.body).lead.last_contacted_at).toBeFalsy();
  });

  it('creates and completes a task, embedding lead + agent', async () => {
    const tasksFn = fn('tasks.cjs');
    const created = await tasksFn.handler(mkEvent({ method: 'POST', token: agentToken, body: { lead_id: leadId, title: 'Follow up' } }));
    const task = JSON.parse(created.body).task;
    expect(task.lead.id).toBe(leadId);
    expect(task.agent).toBeTruthy();

    const completed = await tasksFn.handler(mkEvent({ method: 'PATCH', token: agentToken, qs: { id: task.id }, body: { status: 'completed' } }));
    const updated = JSON.parse(completed.body).task;
    expect(updated.status).toBe('completed');
    expect(updated.completed_at).toBeTruthy();
  });
});
