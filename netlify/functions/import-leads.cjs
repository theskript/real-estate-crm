'use strict';

const { parse } = require('csv-parse/sync');
const { requireAuth, getSupabase, cors, logAudit, getClientIP } = require('./_utils.cjs');

const CORS = cors('POST');

// Accepts { csv: string, mapping: { first_name, last_name, email, phone, lead_type, source, temperature } }
// `mapping` values are the CSV column header names to pull each CRM field from.
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let user;
  try { user = requireAuth(event); } catch (e) {
    return { statusCode: e.statusCode || 401, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }
  const sb = getSupabase();
  const ip = getClientIP(event);

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }
  const { csv, mapping, default_lead_type = 'buyer', default_source = 'Import', auto_assign = false } = body;
  if (!csv || !mapping || !mapping.first_name) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'csv and a mapping with at least first_name are required' }) };
  }

  let rows;
  try {
    rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  } catch (err) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: `Could not parse CSV: ${err.message}` }) };
  }
  if (rows.length > 1000) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Max 1000 rows per import — split your file and try again' }) };
  }

  const { data: existing } = await sb.from('leads').select('email,phone');
  const existingEmails = new Set((existing || []).map(l => (l.email || '').toLowerCase()).filter(Boolean));
  const existingPhones = new Set((existing || []).map(l => (l.phone || '').replace(/\D/g, '')).filter(Boolean));

  const toInsert = [];
  let skipped = 0;
  for (const row of rows) {
    const first_name = row[mapping.first_name];
    if (!first_name) { skipped++; continue; }
    const email = mapping.email ? row[mapping.email] : null;
    const phone = mapping.phone ? row[mapping.phone] : null;
    const emailLc = (email || '').toLowerCase();
    const phoneDigits = (phone || '').replace(/\D/g, '');
    if ((emailLc && existingEmails.has(emailLc)) || (phoneDigits && existingPhones.has(phoneDigits))) {
      skipped++; continue;
    }
    if (emailLc) existingEmails.add(emailLc);
    if (phoneDigits) existingPhones.add(phoneDigits);

    toInsert.push({
      first_name,
      last_name: mapping.last_name ? row[mapping.last_name] : null,
      email, phone,
      lead_type: (mapping.lead_type ? row[mapping.lead_type] : default_lead_type) || default_lead_type,
      source: (mapping.source ? row[mapping.source] : default_source) || default_source,
      temperature: (mapping.temperature ? row[mapping.temperature] : 'warm') || 'warm',
      assigned_agent_id: auto_assign ? null : user.sub,
    });
  }

  if (!toInsert.length) {
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ imported: 0, skipped, total: rows.length }) };
  }

  const { data, error } = await sb.from('leads').insert(toInsert).select('id');
  if (error) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: error.message }) };

  await logAudit({ action: 'Import Leads', username: user.username, role: user.role, details: `Imported ${data.length}, skipped ${skipped} duplicates`, ip });
  return { statusCode: 200, headers: CORS, body: JSON.stringify({ imported: data.length, skipped, total: rows.length }) };
};
