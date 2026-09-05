'use strict';

/**
 * Local SQLite fallback — a compatibility shim that mimics just enough of
 * the @supabase/supabase-js query-builder surface (`.from().select().eq()...`)
 * for every netlify/functions/*.cjs file to work completely unmodified.
 *
 * Used automatically whenever SUPABASE_URL isn't configured (see
 * _utils.cjs#getSupabase), e.g. while Supabase is down or before you've
 * created a project. Data lives in data/teaka.sqlite (gitignored), which is
 * created and seeded automatically from db/schema.sqlite.sql on first use.
 *
 * This is NOT a generic ORM — it only implements the exact query shapes
 * (filters, embeds/joins) actually used in this codebase. The relationship
 * REGISTRY below documents every join; add an entry there if you add a new
 * embedded `alias:table(...)` select elsewhere.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// NOTE: dev/production function bundlers (esbuild) inline this file's code
// directly into each handler's bundle, so `__dirname` at runtime points at a
// generated/copied bundle directory — NOT this file's real location in
// netlify/functions/. We can't rely on it to find db/schema.sqlite.sql or
// data/teaka.sqlite. Instead, walk up from a few candidate starting points
// until we find the project root (identified by containing db/schema.sqlite.sql).
function findProjectRoot() {
  const candidates = [process.cwd(), __dirname];
  for (const start of candidates) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'db', 'schema.sqlite.sql'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('Could not locate db/schema.sqlite.sql — is the project structure intact?');
}

const PROJECT_ROOT = findProjectRoot();
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'teaka.sqlite');
const SCHEMA_PATH = path.join(PROJECT_ROOT, 'db', 'schema.sqlite.sql');

let dbInstance = null;
const tableColumnsCache = new Map();

function getDb() {
  if (dbInstance) return dbInstance;
  const isNew = !fs.existsSync(DB_PATH);
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  dbInstance = new Database(DB_PATH);
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  if (isNew) {
    dbInstance.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }
  return dbInstance;
}

function tableColumns(db, table) {
  if (!tableColumnsCache.has(table)) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    tableColumnsCache.set(table, cols);
  }
  return tableColumnsCache.get(table);
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  // Same v4-ish shape as the SQL DEFAULT in schema.sqlite.sql
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Coerces a JS value into something better-sqlite3 can bind (no objects/arrays/booleans/undefined). */
function coerce(val) {
  if (val === undefined) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (Array.isArray(val) || (val && typeof val === 'object')) return JSON.stringify(val);
  return val;
}

/** Reverses known special-cased columns back into JS-friendly shapes after a read. */
function normalizeRow(row) {
  if (!row) return row;
  if ('active' in row) row.active = !!row.active;
  if ('photos' in row && typeof row.photos === 'string') {
    try { row.photos = JSON.parse(row.photos); } catch { row.photos = []; }
  }
  return row;
}

// ── Select-string parser: "col1,col2,alias:table(sub...)" → { cols, embeds } ─
function parseSelect(str) {
  const cols = [];
  const embeds = [];
  const parts = [];
  let depth = 0;
  let token = '';
  for (const ch of String(str || '*')) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(token); token = ''; }
    else token += ch;
  }
  if (token.trim()) parts.push(token);

  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const m = part.match(/^(?:(\w+):)?(\w+)\((.*)\)$/s);
    if (m) {
      const [, aliasMaybe, table, sub] = m;
      embeds.push({ alias: aliasMaybe || table, table, sub });
    } else {
      cols.push(part);
    }
  }
  return { cols, embeds };
}

function selectColsSql(cols) {
  if (!cols.length || cols.includes('*')) return '*';
  return cols.join(', ');
}

// ── Relationship registry — every `alias:table(...)` embed used in the app ──
// type 'one'          : baseTable.<fk> -> targetTable.id (to-one)
// type 'many-through'  : baseTable.id <- throughTable.<throughFK>, throughTable.<targetFK> -> targetTable.id
// type 'many-reverse'  : baseTable.id <- targetTable.<targetFK> (to-many, no join table)
const REGISTRY = {
  'leads.tags': { type: 'many-through', throughTable: 'lead_tags', throughFK: 'lead_id', targetFK: 'tag_id' },
  'lead_tags.tag': { type: 'one', fk: 'tag_id', targetTable: 'tags' },
  'leads.agent': { type: 'one', fk: 'assigned_agent_id', targetTable: 'agents' },
  'activities.agent': { type: 'one', fk: 'agent_id', targetTable: 'agents' },
  'tasks.agent': { type: 'one', fk: 'agent_id', targetTable: 'agents' },
  'tasks.lead': { type: 'one', fk: 'lead_id', targetTable: 'leads' },
  'properties.seller_lead': { type: 'one', fk: 'seller_lead_id', targetTable: 'leads' },
  'properties.matches': { type: 'many-reverse', targetTable: 'lead_property_matches', targetFK: 'property_id' },
  'lead_property_matches.lead': { type: 'one', fk: 'lead_id', targetTable: 'leads' },
};

/** Expands a requested column list to guarantee `id` and any FK columns needed by nested embeds are present, so joins/grouping never silently come back empty. */
function withRequiredCols(table, cols, embeds, extraForced = []) {
  if (!cols.length || cols.includes('*')) return ['*'];
  const set = new Set([...cols, 'id', ...extraForced]);
  for (const e of embeds || []) {
    const rel = REGISTRY[`${table}.${e.alias}`];
    if (rel && rel.type === 'one') set.add(rel.fk);
  }
  return [...set];
}

function resolveOne(db, rows, rel, alias, subCols, subEmbeds) {
  const ids = [...new Set(rows.map(r => r[rel.fk]).filter(v => v != null))];
  if (!ids.length) { rows.forEach(r => (r[alias] = null)); return; }
  const colsSql = selectColsSql(withRequiredCols(rel.targetTable, subCols, subEmbeds));
  const placeholders = ids.map(() => '?').join(',');
  const targetRows = db.prepare(`SELECT ${colsSql} FROM ${rel.targetTable} WHERE id IN (${placeholders})`).all(...ids).map(normalizeRow);
  resolveEmbeds(db, rel.targetTable, targetRows, subEmbeds);
  const map = Object.fromEntries(targetRows.map(r => [r.id, r]));
  rows.forEach(r => { r[alias] = map[r[rel.fk]] || null; });
}

function resolveManyThrough(db, rows, rel, alias, subCols, subEmbeds) {
  const baseIds = [...new Set(rows.map(r => r.id))];
  if (!baseIds.length) { rows.forEach(r => (r[alias] = [])); return; }
  const placeholders = baseIds.map(() => '?').join(',');
  const throughRows = db.prepare(`SELECT * FROM ${rel.throughTable} WHERE ${rel.throughFK} IN (${placeholders})`).all(...baseIds);
  resolveEmbeds(db, rel.throughTable, throughRows, subEmbeds);
  const grouped = {};
  for (const tr of throughRows) (grouped[tr[rel.throughFK]] ||= []).push(tr);
  rows.forEach(r => { r[alias] = grouped[r.id] || []; });
}

function resolveManyReverse(db, rows, rel, alias, subCols, subEmbeds) {
  const baseIds = [...new Set(rows.map(r => r.id))];
  if (!baseIds.length) { rows.forEach(r => (r[alias] = [])); return; }
  const colsSql = selectColsSql(withRequiredCols(rel.targetTable, subCols, subEmbeds, [rel.targetFK]));
  const placeholders = baseIds.map(() => '?').join(',');
  const targetRows = db.prepare(`SELECT ${colsSql} FROM ${rel.targetTable} WHERE ${rel.targetFK} IN (${placeholders})`).all(...baseIds).map(normalizeRow);
  resolveEmbeds(db, rel.targetTable, targetRows, subEmbeds);
  const grouped = {};
  for (const tr of targetRows) (grouped[tr[rel.targetFK]] ||= []).push(tr);
  rows.forEach(r => { r[alias] = grouped[r.id] || []; });
}

function resolveEmbeds(db, baseTable, rows, embeds) {
  if (!rows.length || !embeds || !embeds.length) return;
  for (const embed of embeds) {
    const rel = REGISTRY[`${baseTable}.${embed.alias}`];
    if (!rel) throw new Error(`No relationship registered for ${baseTable}.${embed.alias} — see netlify/functions/_sqlite.cjs REGISTRY`);
    const { cols: subCols, embeds: subEmbeds } = parseSelect(embed.sub);
    if (rel.type === 'one') resolveOne(db, rows, rel, embed.alias, subCols, subEmbeds);
    else if (rel.type === 'many-through') resolveManyThrough(db, rows, rel, embed.alias, subCols, subEmbeds);
    else if (rel.type === 'many-reverse') resolveManyReverse(db, rows, rel, embed.alias, subCols, subEmbeds);
  }
}

// ── Query builder (mimics the subset of supabase-js used across the app) ────
class QueryBuilder {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this._select = '*';
    this._filters = [];
    this._order = null;
    this._limit = null;
    this._single = false;
    this._maybeSingle = false;
    this._op = 'select';
    this._payload = null;
    this._onConflict = null;
    this._selectCalled = false;
  }

  select(cols) { this._select = cols || '*'; this._selectCalled = true; return this; }
  eq(col, val) { this._filters.push({ t: 'eq', col, val: coerce(val) }); return this; }
  ilike(col, val) { this._filters.push({ t: 'ilike', col, val }); return this; }
  gte(col, val) { this._filters.push({ t: 'gte', col, val }); return this; }
  lte(col, val) { this._filters.push({ t: 'lte', col, val }); return this; }
  not(col, op, val) { this._filters.push({ t: 'not', col, op, val }); return this; }
  or(expr) { this._filters.push({ t: 'or', expr }); return this; }
  order(col, opts = {}) { this._order = { col, ascending: opts.ascending !== false, nullsFirst: opts.nullsFirst }; return this; }
  limit(n) { this._limit = n; return this; }

  insert(payload) { this._op = 'insert'; this._payload = payload; return this; }
  update(payload) { this._op = 'update'; this._payload = payload; return this; }
  upsert(payload, opts = {}) { this._op = 'upsert'; this._payload = payload; this._onConflict = opts.onConflict; return this; }
  delete() { this._op = 'delete'; return this; }

  maybeSingle() { this._maybeSingle = true; return this._exec(); }
  single() { this._single = true; return this._exec(); }

  then(onFulfilled, onRejected) { return this._exec().then(onFulfilled, onRejected); }
  catch(onRejected) { return this._exec().catch(onRejected); }

  _buildWhere(params) {
    const clauses = [];
    for (const f of this._filters) {
      if (f.t === 'eq') { clauses.push(`${f.col} = ?`); params.push(f.val); }
      else if (f.t === 'ilike') { clauses.push(`${f.col} LIKE ?`); params.push(f.val); }
      else if (f.t === 'gte') { clauses.push(`${f.col} >= ?`); params.push(f.val); }
      else if (f.t === 'lte') { clauses.push(`${f.col} <= ?`); params.push(f.val); }
      else if (f.t === 'not' && f.op === 'in') {
        const vals = String(f.val).replace(/^\(|\)$/g, '').split(',').map(v => v.trim()).filter(Boolean);
        clauses.push(`(${f.col} IS NULL OR ${f.col} NOT IN (${vals.map(() => '?').join(',')}))`);
        params.push(...vals);
      } else if (f.t === 'or') {
        const orClauses = f.expr.split(',').map(piece => {
          const firstDot = piece.indexOf('.');
          const col = piece.slice(0, firstDot);
          const rest = piece.slice(firstDot + 1);
          const secondDot = rest.indexOf('.');
          const op = rest.slice(0, secondDot);
          const val = rest.slice(secondDot + 1);
          params.push(val);
          return op === 'ilike' ? `${col} LIKE ?` : `${col} = ?`;
        });
        clauses.push(`(${orClauses.join(' OR ')})`);
      }
    }
    return clauses.join(' AND ');
  }

  _orderSql() {
    if (!this._order) return '';
    const dir = this._order.ascending ? 'ASC' : 'DESC';
    let nulls = '';
    if (this._order.nullsFirst === true) nulls = ' NULLS FIRST';
    else if (this._order.nullsFirst === false) nulls = ' NULLS LAST';
    return ` ORDER BY ${this._order.col} ${dir}${nulls}`;
  }

  async _exec() {
    try {
      if (this._op === 'select') return this._runSelect();
      if (this._op === 'insert') return this._runInsert();
      if (this._op === 'update') return this._runUpdate();
      if (this._op === 'upsert') return this._runUpsert();
      if (this._op === 'delete') return this._runDelete();
      throw new Error(`Unsupported op: ${this._op}`);
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  _runSelect() {
    const { cols, embeds } = parseSelect(this._select);
    const params = [];
    let sql = `SELECT ${selectColsSql(cols)} FROM ${this.table}`;
    const where = this._buildWhere(params);
    if (where) sql += ` WHERE ${where}`;
    sql += this._orderSql();
    if (this._limit != null) sql += ` LIMIT ${this._limit}`;
    let rows = this.db.prepare(sql).all(...params).map(normalizeRow);
    resolveEmbeds(this.db, this.table, rows, embeds);
    if (this._maybeSingle) return { data: rows[0] || null, error: null };
    if (this._single) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }

  /** Re-fetches rows by id through the normal select path so `.select(embedCols)` after a mutation works identically. */
  _refetchByIds(ids) {
    if (!ids.length) return [];
    const { cols, embeds } = parseSelect(this._select);
    const colsSql = selectColsSql(cols);
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT ${colsSql} FROM ${this.table} WHERE id IN (${placeholders})`).all(...ids).map(normalizeRow);
    resolveEmbeds(this.db, this.table, rows, embeds);
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    return ids.map(id => byId[id]).filter(Boolean);
  }

  _runInsert() {
    const cols = tableColumns(this.db, this.table);
    const rowsIn = Array.isArray(this._payload) ? this._payload : [this._payload];
    const insertedIds = [];
    const insertedRaw = [];
    const insertMany = this.db.transaction((items) => {
      for (const item of items) {
        const fields = Object.entries(item).filter(([k, v]) => v !== undefined && cols.includes(k));
        const colNames = fields.map(([k]) => k);
        const placeholders = colNames.map(() => '?').join(',');
        const values = fields.map(([, v]) => coerce(v));
        const sql = colNames.length
          ? `INSERT INTO ${this.table} (${colNames.join(',')}) VALUES (${placeholders}) RETURNING *`
          : `INSERT INTO ${this.table} DEFAULT VALUES RETURNING *`;
        const row = this.db.prepare(sql).get(...values);
        insertedRaw.push(normalizeRow(row));
        insertedIds.push(row.id);
      }
    });
    insertMany(rowsIn);

    const rows = this._selectCalled ? this._refetchByIds(insertedIds) : insertedRaw;
    if (this._maybeSingle || this._single) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }

  _runUpdate() {
    const cols = tableColumns(this.db, this.table);
    const fields = { ...this._payload };
    if (cols.includes('updated_at') && fields.updated_at === undefined) fields.updated_at = nowIso();
    const setEntries = Object.entries(fields).filter(([k, v]) => v !== undefined && cols.includes(k));
    const params = [];
    const setSql = setEntries.map(([k, v]) => { params.push(coerce(v)); return `${k} = ?`; }).join(', ');
    const whereParams = [];
    const where = this._buildWhere(whereParams);
    const idRows = this.db.prepare(`SELECT id FROM ${this.table}${where ? ` WHERE ${where}` : ''}`).all(...whereParams);
    const ids = idRows.map(r => r.id);
    if (setSql && ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`UPDATE ${this.table} SET ${setSql} WHERE id IN (${placeholders})`).run(...params, ...ids);
    }
    const rows = this._selectCalled ? this._refetchByIds(ids) : [];
    if (this._maybeSingle || this._single) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }

  _runUpsert() {
    const cols = tableColumns(this.db, this.table);
    const rowsIn = Array.isArray(this._payload) ? this._payload : [this._payload];
    const conflictCols = (this._onConflict || 'id').split(',').map(s => s.trim());
    const ids = [];
    const upsertMany = this.db.transaction((items) => {
      for (const item of items) {
        const fields = Object.entries(item).filter(([k, v]) => v !== undefined && cols.includes(k));
        const colNames = fields.map(([k]) => k);
        const values = fields.map(([, v]) => coerce(v));
        const placeholders = colNames.map(() => '?').join(',');
        const updateSql = colNames.filter(c => !conflictCols.includes(c)).map(c => `${c} = excluded.${c}`).join(', ');
        const sql = `INSERT INTO ${this.table} (${colNames.join(',')}) VALUES (${placeholders}) ` +
          `ON CONFLICT(${conflictCols.join(',')}) DO ${updateSql ? `UPDATE SET ${updateSql}` : 'NOTHING'} ` +
          `RETURNING *`;
        const row = this.db.prepare(sql).get(...values);
        if (row) ids.push(row.id ?? row[conflictCols[0]]);
      }
    });
    upsertMany(rowsIn);
    const rows = this._selectCalled && cols.includes('id') ? this._refetchByIds(ids) : [];
    if (this._maybeSingle || this._single) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }

  _runDelete() {
    const params = [];
    const where = this._buildWhere(params);
    this.db.prepare(`DELETE FROM ${this.table}${where ? ` WHERE ${where}` : ''}`).run(...params);
    return { data: null, error: null };
  }
}

function getSqliteDB() {
  const db = getDb();
  return { from: (table) => new QueryBuilder(db, table) };
}

module.exports = { getSqliteDB };
