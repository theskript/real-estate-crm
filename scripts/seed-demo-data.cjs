'use strict';
// Populates Supabase with realistic demo data for the whole CRM: agents,
// buyer/seller leads across every temperature/stage, tags, properties,
// buyer-property matches, activity timelines, follow-up tasks (overdue/
// today/upcoming/completed), and a bit of audit log history.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (real Supabase,
// not the SQLite fallback — this writes straight to Postgres via supabase-js).
//
// Usage:
//   node scripts/seed-demo-data.cjs          # aborts if demo agents already exist
//   node scripts/seed-demo-data.cjs --reset  # wipes previous demo data first

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env — this script only targets real Supabase.');
  process.exit(1);
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const RESET = process.argv.includes('--reset');
const DEMO_PASSWORD = 'Demo1234!';

const daysAgo = (n, hours = 0) => new Date(Date.now() - n * 86400000 - hours * 3600000).toISOString();
const daysFromNow = (n) => new Date(Date.now() + n * 86400000).toISOString();
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function insert(table, rows, select = '*') {
  const { data, error } = await sb.from(table).insert(rows).select(select);
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return data;
}

const AGENTS = [
  { username: 'sarah.chen', name: 'Sarah Chen', email: 'sarah.chen@teakarealty.com', phone: '(512) 555-0142', role: 'owner', avatar_color: '#0e8a7d' },
  { username: 'marcus.torres', name: 'Marcus Torres', email: 'marcus.torres@teakarealty.com', phone: '(512) 555-0178', role: 'agent', avatar_color: '#2563eb' },
  { username: 'priya.patel', name: 'Priya Patel', email: 'priya.patel@teakarealty.com', phone: '(512) 555-0193', role: 'agent', avatar_color: '#d97706' },
];
const DEMO_PROPERTY_ADDRESSES = [
  '2210 Maple Ave', '884 Sunset Blvd', '155 Oak Hill Dr', '312 Birch Ln',
  '77 Highland Ave', '990 River Rd', '500 Congress Ave, Unit 12B', '88 Barton Springs Rd',
];

async function resetDemoData() {
  console.log('--reset: clearing previous demo data...');
  const { data: existingAgents } = await sb.from('agents').select('id,username').in('username', AGENTS.map(a => a.username));
  const agentIds = (existingAgents || []).map(a => a.id);
  if (agentIds.length) {
    const { data: leadRows } = await sb.from('leads').select('id').in('assigned_agent_id', agentIds);
    const leadIds = (leadRows || []).map(l => l.id);
    if (leadIds.length) {
      await sb.from('properties').update({ seller_lead_id: null }).in('seller_lead_id', leadIds);
      await sb.from('leads').delete().in('id', leadIds); // cascades activities/tasks/lead_tags/matches
    }
    await sb.from('properties').delete().in('address', DEMO_PROPERTY_ADDRESSES);
    await sb.from('audit_log').delete().in('username', AGENTS.map(a => a.username));
    await sb.from('agents').delete().in('id', agentIds);
  }
  console.log('  done.');
}

async function main() {
  const { data: existing } = await sb.from('agents').select('id').eq('username', 'sarah.chen').maybeSingle();
  if (existing && !RESET) {
    console.log('Demo data already seeded (agent "sarah.chen" exists). Re-run with --reset to wipe and reseed.');
    process.exit(0);
  }
  if (RESET) await resetDemoData();

  console.log('Creating agents...');
  const password_hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const agents = await insert('agents', AGENTS.map(a => ({ ...a, password_hash, active: true })));
  const owner = agents.find(a => a.username === 'sarah.chen');
  const marcus = agents.find(a => a.username === 'marcus.torres');
  const priya = agents.find(a => a.username === 'priya.patel');
  console.log(`  ${agents.length} agents created. Login as any with password: ${DEMO_PASSWORD}`);

  console.log('Fetching seed tags...');
  const { data: tags } = await sb.from('tags').select('*');
  const tagByName = Object.fromEntries((tags || []).map(t => [t.name, t.id]));

  console.log('Creating leads...');
  const LEADS = [
    { first_name: 'Jennifer', last_name: 'Walsh', email: 'jennifer.walsh82@gmail.com', phone: '(512) 555-2201', lead_type: 'buyer', temperature: 'hot', stage: 'contacted', source: 'Zillow', assigned_agent_id: marcus.id, budget_min: 400000, budget_max: 550000, desired_area: 'South Austin', notes: 'Pre-approved with Chase. Wants a fenced yard for the dog.', created_at: daysAgo(5), last_contacted_at: daysAgo(1), next_follow_up_at: daysFromNow(1), tags: ['First-Time Buyer'] },
    { first_name: 'David', last_name: 'Kim', email: 'dkim.realty@outlook.com', phone: '(512) 555-2202', lead_type: 'buyer', temperature: 'hot', stage: 'appointment_set', source: 'Referral', assigned_agent_id: priya.id, budget_min: 600000, budget_max: 750000, desired_area: 'Westlake', notes: 'Relocating from Dallas for new job at Apple. Needs to close within 60 days.', created_at: daysAgo(10), last_contacted_at: daysAgo(4), next_follow_up_at: daysAgo(2), tags: ['Cash Buyer', 'Relocating'] },
    { first_name: 'Amanda', last_name: 'Foster', email: 'amanda.foster@yahoo.com', phone: '(512) 555-2203', lead_type: 'seller', temperature: 'warm', stage: 'nurturing', source: 'Website', property_address: '2210 Maple Ave, Austin, TX 78704', listing_price_expectation: 525000, assigned_agent_id: marcus.id, notes: 'Downsizing after kids moved out. Not in a rush — exploring options.', created_at: daysAgo(20), last_contacted_at: daysAgo(6), next_follow_up_at: daysFromNow(4) },
    { first_name: 'Robert', last_name: 'Nguyen', email: 'r.nguyen1990@gmail.com', phone: '(512) 555-2204', lead_type: 'buyer', temperature: 'cold', stage: 'new', source: 'Facebook Ads', assigned_agent_id: priya.id, budget_min: 250000, budget_max: 320000, desired_area: 'Round Rock', notes: 'Just started browsing, early in the process.', created_at: daysAgo(2) },
    { first_name: 'Lisa', last_name: 'Martinez', email: 'lisa.martinez@gmail.com', phone: '(512) 555-2205', lead_type: 'seller', temperature: 'hot', stage: 'under_contract', source: 'Sphere of Influence', property_address: '884 Sunset Blvd, Austin, TX 78745', listing_price_expectation: 680000, assigned_agent_id: marcus.id, notes: 'Accepted offer at $675k. Inspection scheduled next week.', created_at: daysAgo(35), last_contacted_at: daysAgo(1), next_follow_up_at: daysFromNow(3) },
    { first_name: 'James', last_name: "O'Brien", email: 'jobrien.tx@gmail.com', phone: '(512) 555-2206', lead_type: 'buyer', temperature: 'warm', stage: 'contacted', source: 'Open House', assigned_agent_id: marcus.id, budget_min: 350000, budget_max: 425000, desired_area: 'Cedar Park', notes: 'Met at the Maple Ave open house. Liked the layout, wants similar.', created_at: daysAgo(8), last_contacted_at: daysAgo(2), next_follow_up_at: daysFromNow(2) },
    { first_name: 'Michelle', last_name: 'Wong', email: 'michelle.wong@icloud.com', phone: '(512) 555-2207', lead_type: 'seller', temperature: 'cold', stage: 'new', source: 'Website', property_address: '155 Oak Hill Dr, Austin, TX 78749', listing_price_expectation: 410000, assigned_agent_id: priya.id, notes: 'Filled out valuation form, hasn\u2019t responded to first outreach yet.', created_at: daysAgo(1) },
    { first_name: 'Carlos', last_name: 'Rivera', email: 'carlos.rivera@gmail.com', phone: '(512) 555-2208', lead_type: 'buyer', temperature: 'hot', stage: 'nurturing', source: 'Sphere of Influence', assigned_agent_id: owner.id, budget_min: 500000, budget_max: 600000, desired_area: 'Zilker', notes: 'Investor, looking for 2nd rental property. Cash buyer, moves fast when ready.', created_at: daysAgo(15), last_contacted_at: daysAgo(6), tags: ['Investor', 'Cash Buyer'] },
    { first_name: 'Emily', last_name: 'Chang', email: 'emily.chang88@gmail.com', phone: '(512) 555-2209', lead_type: 'buyer', temperature: 'warm', stage: 'closed_won', source: 'Referral', assigned_agent_id: marcus.id, budget_min: 425000, budget_max: 480000, desired_area: 'North Loop', notes: 'Closed on 990 River Rd! Great client, ask for referrals.', created_at: daysAgo(60), last_contacted_at: daysAgo(3) },
    { first_name: 'Thomas', last_name: 'Baker', email: 'tbaker.austin@gmail.com', phone: '(512) 555-2210', lead_type: 'seller', temperature: 'warm', stage: 'closed_won', source: 'Referral', property_address: '990 River Rd, Austin, TX 78730', listing_price_expectation: 750000, assigned_agent_id: priya.id, notes: 'Sold at asking price, smooth closing.', created_at: daysAgo(55), last_contacted_at: daysAgo(5) },
    { first_name: 'Nicole', last_name: 'Anderson', email: 'nicole.anderson@hotmail.com', phone: '(512) 555-2211', lead_type: 'buyer', temperature: 'warm', stage: 'appointment_set', source: 'Zillow', assigned_agent_id: marcus.id, budget_min: 300000, budget_max: 380000, desired_area: 'Pflugerville', notes: 'Showing scheduled for Oak Hill Dr this weekend.', created_at: daysAgo(6), last_contacted_at: daysAgo(1), next_follow_up_at: daysFromNow(1), tags: ['First-Time Buyer'] },
    { first_name: 'Kevin', last_name: 'Brooks', email: 'kbrooks.tx@gmail.com', phone: '(512) 555-2212', lead_type: 'seller', temperature: 'cold', stage: 'closed_lost', source: 'Website', property_address: '45 Elm St, Austin, TX 78702', listing_price_expectation: 390000, assigned_agent_id: priya.id, lost_reason: 'Decided not to sell — staying put for now.', notes: 'Family decided to renovate instead of selling.', created_at: daysAgo(40), last_contacted_at: daysAgo(20) },
    { first_name: 'Rachel', last_name: 'Green', email: 'rachel.green.tx@gmail.com', phone: '(512) 555-2213', lead_type: 'buyer', temperature: 'hot', stage: 'new', source: 'Facebook Ads', assigned_agent_id: owner.id, budget_min: 550000, budget_max: 650000, desired_area: 'Downtown Austin', notes: 'Submitted inquiry overnight, needs a callback ASAP.', created_at: daysAgo(0, 14), tags: ['Relocating'] },
    { first_name: 'Brian', last_name: 'Foster', email: 'brian.foster@gmail.com', phone: '(512) 555-2214', lead_type: 'buyer', temperature: 'warm', stage: 'contacted', source: 'Walk-in', assigned_agent_id: marcus.id, budget_min: 275000, budget_max: 340000, desired_area: 'Buda', notes: 'Stopped by the office, wants to see 2-3 more listings before deciding.', created_at: daysAgo(4), last_contacted_at: daysAgo(1), next_follow_up_at: daysFromNow(3) },
    { first_name: 'Samantha', last_name: 'Lee', email: 'samantha.lee@gmail.com', phone: '(512) 555-2215', lead_type: 'seller', temperature: 'warm', stage: 'nurturing', source: 'Referral', property_address: '312 Birch Ln, Austin, TX 78702', listing_price_expectation: 495000, assigned_agent_id: priya.id, notes: 'Wants to list in spring, gathering info for now.', created_at: daysAgo(18), last_contacted_at: daysAgo(7), next_follow_up_at: daysFromNow(10) },
    { first_name: 'Daniel', last_name: 'Cooper', email: 'dcooper90@gmail.com', phone: '(512) 555-2216', lead_type: 'buyer', temperature: 'cold', stage: 'new', source: 'Other', assigned_agent_id: marcus.id, budget_min: 200000, budget_max: 260000, desired_area: 'Kyle', notes: 'Early-stage, still saving for down payment.', created_at: daysAgo(3) },
    { first_name: 'Olivia', last_name: 'Scott', email: 'olivia.scott@gmail.com', phone: '(512) 555-2217', lead_type: 'seller', temperature: 'hot', stage: 'appointment_set', source: 'Sphere of Influence', property_address: '77 Highland Ave, Austin, TX 78703', listing_price_expectation: 615000, assigned_agent_id: owner.id, notes: 'Listing appointment scheduled — bringing comps and CMA.', created_at: daysAgo(7), last_contacted_at: daysAgo(1), next_follow_up_at: daysFromNow(2), tags: ['Luxury'] },
    { first_name: 'Ethan', last_name: 'Wright', email: 'ethan.wright@gmail.com', phone: '(512) 555-2218', lead_type: 'buyer', temperature: 'cold', stage: 'closed_lost', source: 'Zillow', assigned_agent_id: priya.id, budget_min: 400000, budget_max: 500000, desired_area: 'East Austin', lost_reason: 'Went with another agent (family friend).', created_at: daysAgo(25), last_contacted_at: daysAgo(18) },
  ];

  const insertedLeads = [];
  for (const l of LEADS) {
    const { tags: tagNames, ...fields } = l;
    const [row] = await insert('leads', [fields]);
    if (tagNames?.length) {
      await sb.from('lead_tags').insert(tagNames.map(name => ({ lead_id: row.id, tag_id: tagByName[name] })).filter(t => t.tag_id));
    }
    insertedLeads.push({ ...row, first_name: l.first_name, last_name: l.last_name });
  }
  const leadByName = (first, last) => insertedLeads.find(l => l.first_name === first && l.last_name === last);
  console.log(`  ${insertedLeads.length} leads created.`);

  console.log('Creating properties...');
  const PROPERTIES = [
    { address: '2210 Maple Ave', city: 'Austin', state: 'TX', zip: '78704', price: 539000, beds: 4, baths: 3, sqft: 2400, status: 'active', seller: ['Amanda', 'Foster'], description: 'Beautifully updated 4BR craftsman with a fenced backyard and covered patio, walking distance to South Congress.' },
    { address: '884 Sunset Blvd', city: 'Austin', state: 'TX', zip: '78745', price: 699000, beds: 5, baths: 4, sqft: 3200, status: 'pending', seller: ['Lisa', 'Martinez'], description: 'Spacious 5BR with a pool, open-concept kitchen, and 3-car garage. Under contract, closing next month.' },
    { address: '155 Oak Hill Dr', city: 'Austin', state: 'TX', zip: '78749', price: 419000, beds: 3, baths: 2, sqft: 1850, status: 'active', seller: ['Michelle', 'Wong'], description: 'Charming single-story home with recent HVAC and roof replacement, great starter home.' },
    { address: '312 Birch Ln', city: 'Austin', state: 'TX', zip: '78702', price: 505000, beds: 3, baths: 2.5, sqft: 2100, status: 'active', seller: ['Samantha', 'Lee'], description: 'Modern townhome minutes from downtown, rooftop deck with skyline views.' },
    { address: '77 Highland Ave', city: 'Austin', state: 'TX', zip: '78703', price: 625000, beds: 4, baths: 3, sqft: 2650, status: 'active', seller: ['Olivia', 'Scott'], description: 'Renovated mid-century home in a highly sought-after school district.' },
    { address: '990 River Rd', city: 'Austin', state: 'TX', zip: '78730', price: 750000, beds: 5, baths: 4.5, sqft: 3800, status: 'sold', seller: ['Thomas', 'Baker'], description: 'Lakeside-adjacent estate, sold above asking after 2 offers.' },
    { address: '500 Congress Ave, Unit 12B', city: 'Austin', state: 'TX', zip: '78701', price: 450000, beds: 2, baths: 2, sqft: 1200, status: 'active', seller: null, description: 'High-rise condo with downtown views, walkable to everything.' },
    { address: '88 Barton Springs Rd', city: 'Austin', state: 'TX', zip: '78704', price: 575000, beds: 3, baths: 2, sqft: 1900, status: 'active', seller: null, description: 'Contemporary build near Zilker Park with a private courtyard.' },
  ];
  const insertedProps = [];
  for (const p of PROPERTIES) {
    const { seller, ...fields } = p;
    const seller_lead_id = seller ? leadByName(...seller)?.id : null;
    const [row] = await insert('properties', [{ ...fields, seller_lead_id, listing_date: fields.status !== 'active' ? daysAgo(20) : daysAgo(10) }]);
    insertedProps.push({ ...row, _key: p.address });
  }
  const propByAddr = (addr) => insertedProps.find(p => p._key === addr);
  console.log(`  ${insertedProps.length} properties created.`);

  console.log('Creating buyer/property matches...');
  await insert('lead_property_matches', [
    { lead_id: leadByName('Jennifer', 'Walsh').id, property_id: propByAddr('500 Congress Ave, Unit 12B').id, status: 'interested' },
    { lead_id: leadByName('David', 'Kim').id, property_id: propByAddr('77 Highland Ave').id, status: 'showing_scheduled' },
    { lead_id: leadByName('Carlos', 'Rivera').id, property_id: propByAddr('88 Barton Springs Rd').id, status: 'interested' },
    { lead_id: leadByName('Rachel', 'Green').id, property_id: propByAddr('312 Birch Ln').id, status: 'interested' },
    { lead_id: leadByName('Nicole', 'Anderson').id, property_id: propByAddr('155 Oak Hill Dr').id, status: 'showed' },
    { lead_id: leadByName('Emily', 'Chang').id, property_id: propByAddr('990 River Rd').id, status: 'offer_made' },
  ]);
  console.log('  6 matches created.');

  console.log('Creating activity timelines...');
  const ACTIVITY_TEMPLATES = {
    'Jennifer|Walsh': [
      { type: 'note', body: 'Lead created from Zillow inquiry', days: 5 },
      { type: 'call', direction: 'outbound', body: 'Introduced myself, discussed budget and must-haves.', duration_seconds: 420, outcome: 'answered', days: 4 },
      { type: 'email', direction: 'outbound', body: 'Sent 5 matching listings in South Austin.', days: 3 },
      { type: 'call', direction: 'inbound', body: 'She called back excited about the Maple Ave listing.', duration_seconds: 300, outcome: 'answered', days: 1 },
    ],
    'David|Kim': [
      { type: 'note', body: 'Lead created via referral from past client', days: 10 },
      { type: 'call', direction: 'outbound', body: 'Discussed relocation timeline, needs to close in 60 days.', duration_seconds: 600, outcome: 'answered', days: 9 },
      { type: 'showing', body: 'Toured 3 homes in Westlake, loved 77 Highland Ave.', days: 6 },
      { type: 'call', direction: 'outbound', body: 'Left voicemail checking in on decision timeline.', duration_seconds: 20, outcome: 'voicemail', days: 4 },
    ],
    'Amanda|Foster': [
      { type: 'note', body: 'Lead created from home valuation form', days: 20 },
      { type: 'call', direction: 'outbound', body: 'Explained the listing process and current market conditions.', duration_seconds: 480, outcome: 'answered', days: 15 },
      { type: 'email', direction: 'outbound', body: 'Sent comparative market analysis (CMA).', days: 6 },
    ],
    'Lisa|Martinez': [
      { type: 'note', body: 'Lead created, referred by a neighbor', days: 35 },
      { type: 'showing', body: 'Professional photos taken, listing went live.', days: 28 },
      { type: 'status_change', body: 'stage → under_contract', days: 10 },
      { type: 'call', direction: 'inbound', body: 'Inspection scheduled for next Tuesday.', duration_seconds: 180, outcome: 'answered', days: 1 },
    ],
    "James|O'Brien": [
      { type: 'note', body: 'Met at Maple Ave open house', days: 8 },
      { type: 'email', direction: 'outbound', body: 'Sent similar listings in Cedar Park.', days: 5 },
      { type: 'call', direction: 'outbound', body: 'Discussed financing pre-approval next steps.', duration_seconds: 360, outcome: 'answered', days: 2 },
    ],
    'Michelle|Wong': [
      { type: 'note', body: 'Lead created from valuation form', days: 1 },
    ],
    'Carlos|Rivera': [
      { type: 'note', body: 'Lead created — referred by existing rental portfolio client', days: 15 },
      { type: 'call', direction: 'outbound', body: 'Discussed cap rate targets and preferred neighborhoods.', duration_seconds: 540, outcome: 'answered', days: 12 },
      { type: 'email', direction: 'outbound', body: 'Sent off-market investment opportunities list.', days: 6 },
    ],
    'Emily|Chang': [
      { type: 'note', body: 'Lead created via referral', days: 60 },
      { type: 'showing', body: 'Toured and made an offer on 990 River Rd.', days: 20 },
      { type: 'status_change', body: 'stage → closed_won', days: 5 },
      { type: 'note', body: 'Closing complete! Sent a thank-you gift and asked for a review.', days: 3 },
    ],
    'Thomas|Baker': [
      { type: 'note', body: 'Lead created via referral', days: 55 },
      { type: 'status_change', body: 'stage → closed_won', days: 5 },
    ],
    'Nicole|Anderson': [
      { type: 'note', body: 'Lead created from Zillow inquiry', days: 6 },
      { type: 'call', direction: 'outbound', body: 'Scheduled showing for Oak Hill Dr this weekend.', duration_seconds: 240, outcome: 'answered', days: 1 },
    ],
    'Kevin|Brooks': [
      { type: 'note', body: 'Lead created from valuation form', days: 40 },
      { type: 'call', direction: 'outbound', body: 'Discussed selling timeline and pricing expectations.', duration_seconds: 300, outcome: 'answered', days: 25 },
      { type: 'status_change', body: 'stage → closed_lost, lost_reason: Decided not to sell', days: 20 },
    ],
    'Rachel|Green': [
      { type: 'note', body: 'Lead created — submitted inquiry overnight', days: 0 },
    ],
    'Brian|Foster': [
      { type: 'note', body: 'Walked into the office asking about listings', days: 4 },
      { type: 'email', direction: 'outbound', body: 'Sent 4 listings in the Buda area under $340k.', days: 2 },
      { type: 'call', direction: 'outbound', body: 'Wants to see 2-3 more before deciding.', duration_seconds: 200, outcome: 'answered', days: 1 },
    ],
    'Samantha|Lee': [
      { type: 'note', body: 'Lead created via referral', days: 18 },
      { type: 'email', direction: 'outbound', body: 'Sent info packet on the listing process and timeline.', days: 10 },
    ],
    'Daniel|Cooper': [
      { type: 'note', body: 'Lead created, early-stage inquiry', days: 3 },
    ],
    'Olivia|Scott': [
      { type: 'note', body: 'Lead created via referral', days: 7 },
      { type: 'call', direction: 'outbound', body: 'Scheduled listing appointment, bringing CMA and comps.', duration_seconds: 360, outcome: 'answered', days: 1 },
    ],
    'Ethan|Wright': [
      { type: 'note', body: 'Lead created from Zillow inquiry', days: 25 },
      { type: 'call', direction: 'outbound', body: 'Left voicemail, no response.', duration_seconds: 15, outcome: 'voicemail', days: 20 },
      { type: 'status_change', body: 'stage → closed_lost, lost_reason: Went with another agent', days: 18 },
    ],
    'Robert|Nguyen': [
      { type: 'note', body: 'Lead created from Facebook Ads campaign', days: 2 },
    ],
  };
  let activityCount = 0;
  for (const [key, activities] of Object.entries(ACTIVITY_TEMPLATES)) {
    const [first, last] = key.split('|');
    const lead = leadByName(first, last);
    if (!lead) continue;
    const rows = activities.map(a => ({
      lead_id: lead.id,
      agent_id: lead.assigned_agent_id,
      type: a.type,
      direction: a.direction || null,
      body: a.body,
      duration_seconds: a.duration_seconds || null,
      outcome: a.outcome || null,
      created_at: daysAgo(a.days),
    }));
    await insert('activities', rows);
    activityCount += rows.length;
  }
  console.log(`  ${activityCount} activities created.`);

  console.log('Creating tasks...');
  const TASKS = [
    // Overdue
    { lead: ['David', 'Kim'], agent_id: priya.id, title: 'Follow up on financing decision', task_type: 'call', due_at: daysAgo(2), status: 'pending' },
    { lead: ['Carlos', 'Rivera'], agent_id: owner.id, title: 'Check in — has it been too quiet?', task_type: 'call', due_at: daysAgo(1), status: 'pending' },
    { lead: ['Kevin', 'Brooks'], agent_id: priya.id, title: 'Send renovation-vs-sell comparison', task_type: 'email', due_at: daysAgo(3), status: 'pending' },
    // Due today
    { lead: ['Rachel', 'Green'], agent_id: owner.id, title: 'First call — new hot lead from FB ad', task_type: 'call', due_at: new Date().toISOString(), status: 'pending' },
    { lead: ['Jennifer', 'Walsh'], agent_id: marcus.id, title: 'Confirm showing time for tomorrow', task_type: 'call', due_at: new Date().toISOString(), status: 'pending' },
    // Upcoming
    { lead: ['Nicole', 'Anderson'], agent_id: marcus.id, title: 'Showing: 155 Oak Hill Dr', task_type: 'showing', due_at: daysFromNow(1), status: 'pending' },
    { lead: ['Olivia', 'Scott'], agent_id: owner.id, title: 'Listing appointment — bring CMA', task_type: 'showing', due_at: daysFromNow(2), status: 'pending' },
    { lead: ['Lisa', 'Martinez'], agent_id: marcus.id, title: 'Confirm inspection results with buyer agent', task_type: 'call', due_at: daysFromNow(3), status: 'pending' },
    { lead: ['Brian', 'Foster'], agent_id: marcus.id, title: 'Send 3 more Buda-area listings', task_type: 'email', due_at: daysFromNow(3), status: 'pending' },
    { lead: ['Samantha', 'Lee'], agent_id: priya.id, title: 'Spring listing prep check-in', task_type: 'follow_up', due_at: daysFromNow(10), status: 'pending' },
    { lead: null, agent_id: owner.id, title: 'Review Q3 lead source ROI report', task_type: 'other', due_at: daysFromNow(5), status: 'pending' },
    // Completed
    { lead: ['Emily', 'Chang'], agent_id: marcus.id, title: 'Send closing gift', task_type: 'other', due_at: daysAgo(4), status: 'completed', completed_at: daysAgo(3) },
    { lead: ['Thomas', 'Baker'], agent_id: priya.id, title: 'Confirm final walkthrough', task_type: 'showing', due_at: daysAgo(6), status: 'completed', completed_at: daysAgo(6) },
    { lead: ['James', "O'Brien"], agent_id: marcus.id, title: 'Send Cedar Park listings', task_type: 'email', due_at: daysAgo(5), status: 'completed', completed_at: daysAgo(5) },
  ];
  const taskRows = TASKS.map(t => ({
    lead_id: t.lead ? leadByName(...t.lead)?.id : null,
    agent_id: t.agent_id,
    title: t.title,
    task_type: t.task_type,
    due_at: t.due_at,
    status: t.status,
    completed_at: t.completed_at || null,
  }));
  await insert('tasks', taskRows);
  console.log(`  ${taskRows.length} tasks created.`);

  console.log('Creating audit log history...');
  const AUDIT_ENTRIES = [
    { action: 'Login', username: 'sarah.chen', role: 'owner', details: 'Successful login', days: 0 },
    { action: 'Login', username: 'marcus.torres', role: 'agent', details: 'Successful login', days: 0 },
    { action: 'Create Lead', username: 'marcus.torres', role: 'agent', details: 'Jennifer Walsh', days: 5 },
    { action: 'Create Lead', username: 'priya.patel', role: 'agent', details: 'David Kim', days: 10 },
    { action: 'Update Lead', username: 'marcus.torres', role: 'agent', details: 'stage → under_contract', days: 10 },
    { action: 'Create Property', username: 'marcus.torres', role: 'agent', details: '2210 Maple Ave', days: 15 },
    { action: 'Login', username: 'priya.patel', role: 'agent', details: 'Successful login', days: 1 },
    { action: 'Update Lead', username: 'owner', role: 'owner', details: 'stage → closed_won', days: 5 },
    { action: 'Create Agent', username: 'sarah.chen', role: 'owner', details: 'Added Marcus Torres (marcus.torres)', days: 60 },
    { action: 'Create Agent', username: 'sarah.chen', role: 'owner', details: 'Added Priya Patel (priya.patel)', days: 60 },
  ];
  await insert('audit_log', AUDIT_ENTRIES.map(e => ({
    action: e.action, username: e.username, role: e.role, details: e.details, created_at: daysAgo(e.days),
  })));
  console.log(`  ${AUDIT_ENTRIES.length} audit entries created.`);

  console.log('\n✓ Demo data seeded successfully.');
  console.log(`  Log in as sarah.chen / marcus.torres / priya.patel with password: ${DEMO_PASSWORD}`);
}

main().catch(err => { console.error('\n✗ Seeding failed:', err.message); process.exit(1); });
