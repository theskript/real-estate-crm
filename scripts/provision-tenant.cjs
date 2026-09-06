'use strict';
// Creates a new organization (tenant) + its first owner agent in one step.
// This replaces the old single-tenant ADMIN_PASSWORD bootstrap login — every
// login must now resolve to a real agents row with a real organization_id,
// so provisioning a brand-new customer is a CLI operation run by whoever
// operates the platform, not a login-time bypass.
//
// Usage:
//   node scripts/provision-tenant.cjs --org="Acme Realty" --owner-name="Jane Doe" \
//     --owner-username=jane --owner-password=SecurePass123 [--slug=acme-realty]

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getSupabase } = require('../netlify/functions/_utils.cjs');

const STARTER_TAGS = [
  { name: 'First-Time Buyer', color: '#2dd4bf' },
  { name: 'Investor', color: '#8b5cf6' },
  { name: 'Luxury', color: '#d97706' },
  { name: 'Cash Buyer', color: '#16a34a' },
  { name: 'Relocating', color: '#3b82f6' },
];
const STARTER_LEAD_SOURCES = 'Zillow,Realtor.com,Facebook Ads,Referral,Sphere of Influence,Open House,Website,Walk-in,Other';

function arg(name) {
  const found = process.argv.find(a => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

function slugify(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

(async () => {
  const orgName = arg('org');
  const ownerName = arg('owner-name');
  const ownerUsername = arg('owner-username');
  const ownerPassword = arg('owner-password');
  const slug = arg('slug') || slugify(orgName || '');

  if (!orgName || !ownerName || !ownerUsername || !ownerPassword) {
    console.error('Usage: node scripts/provision-tenant.cjs --org="Acme Realty" --owner-name="Jane Doe" --owner-username=jane --owner-password=SecurePass123 [--slug=acme-realty]');
    process.exit(1);
  }

  const sb = getSupabase();

  const { data: existingOrg } = await sb.from('organizations').select('id').eq('slug', slug).maybeSingle();
  if (existingOrg) {
    console.error(`An organization with slug "${slug}" already exists.`);
    process.exit(1);
  }
  const { data: existingAgent } = await sb.from('agents').select('id').ilike('username', ownerUsername).maybeSingle();
  if (existingAgent) {
    console.error(`Username "${ownerUsername}" is already taken (usernames are global across all organizations).`);
    process.exit(1);
  }

  const { data: org, error: orgErr } = await sb.from('organizations').insert({ name: orgName, slug }).select().single();
  if (orgErr) { console.error('Failed to create organization:', orgErr.message); process.exit(1); }

  const password_hash = await bcrypt.hash(ownerPassword, 10);
  const { data: owner, error: agentErr } = await sb.from('agents').insert({
    username: ownerUsername.toLowerCase(), name: ownerName, password_hash, role: 'owner', active: true,
    organization_id: org.id,
  }).select().single();
  if (agentErr) { console.error('Failed to create owner agent:', agentErr.message); process.exit(1); }

  // New organizations start with the same sensible defaults migration 0001 gave the original org.
  await sb.from('tags').insert(STARTER_TAGS.map(t => ({ ...t, organization_id: org.id })));
  await sb.from('settings').insert({ organization_id: org.id, key: 'lead_sources', value: STARTER_LEAD_SOURCES });

  console.log(`\u2713 Organization "${org.name}" created (slug: ${org.slug}, id: ${org.id})`);
  console.log(`\u2713 Owner agent "${owner.name}" created (username: ${owner.username})`);
  console.log('\nLog in with that username and the password you provided.');
})().catch(err => { console.error('Provisioning failed:', err.message); process.exit(1); });
