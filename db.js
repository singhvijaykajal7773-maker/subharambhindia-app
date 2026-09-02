// PostgreSQL-backed persistence with a per-record JSONB repository.
// Local development can fall back to data/db.json when DATABASE_URL is absent.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_DATA = {
  users: [], chats: [], messages: [], statuses: [], sessions: [],
  aiMessageDrafts: [],
  aiCallScripts: [], aiCallJobs: [], aiCallCampaigns: [],
  events: [], messageTemplates: [], marketingContacts: [], campaigns: [], auditLogs: [],
  otpChallenges: []
};
const COLLECTIONS = Object.keys(DEFAULT_DATA);
const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const pool = USE_POSTGRES ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL_DISABLE === 'true' ? false : { rejectUnauthorized: false }, max: Number(process.env.PG_POOL_MAX || 5) }) : null;

function loadLocal() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...DEFAULT_DATA, ...parsed };
  } catch (err) {
    console.error('Failed to read local db.json:', err.message);
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

const data = loadLocal();
let readyResolve, readyReject;
const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
let initialized = false;
let flushing = false;
let flushAgain = false;
const snapshots = new Map();

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function rowId(record) {
  if (record && record.id != null) return String(record.id);
  return crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 32);
}
function snapshotAll() {
  snapshots.clear();
  for (const c of COLLECTIONS) {
    const map = new Map();
    for (const r of Array.isArray(data[c]) ? data[c] : []) map.set(rowId(r), JSON.stringify(r));
    snapshots.set(c, map);
  }
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_records (
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (collection, record_id)
    );
    CREATE INDEX IF NOT EXISTS app_records_collection_idx ON app_records(collection);
    CREATE INDEX IF NOT EXISTS app_records_phone_idx ON app_records((data->>'phone')) WHERE collection IN ('users','marketingContacts');
    CREATE INDEX IF NOT EXISTS app_records_owner_idx ON app_records((data->>'ownerId')) WHERE collection IN ('marketingContacts','campaigns','events','messageTemplates','aiCallCampaigns','aiCallJobs','aiCallScripts','auditLogs');
  `);
}

async function loadPostgres() {
  await ensureSchema();
  const { rows } = await pool.query('SELECT collection, record_id, data FROM app_records');
  if (!rows.length) {
    const local = loadLocal();
    for (const c of COLLECTIONS) {
      for (const r of Array.isArray(local[c]) ? local[c] : []) {
        await pool.query('INSERT INTO app_records(collection,record_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING', [c, rowId(r), JSON.stringify(r)]);
      }
      data[c] = clone(Array.isArray(local[c]) ? local[c] : []);
    }
  } else {
    for (const c of COLLECTIONS) data[c] = [];
    for (const row of rows) {
      if (!data[row.collection]) data[row.collection] = [];
      data[row.collection].push(row.data);
    }
    // Keep unknown collections out of the application surface.
    for (const c of COLLECTIONS) if (!Array.isArray(data[c])) data[c] = [];
  }
  snapshotAll();
}

async function init() {
  if (initialized) return;
  try {
    if (USE_POSTGRES) await loadPostgres();
    else snapshotAll();
    initialized = true;
    readyResolve();
  } catch (err) {
    console.error('Database initialization failed:', err);
    readyReject(err);
    throw err;
  }
}

async function flushPostgres() {
  if (!USE_POSTGRES) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    snapshotAll();
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of COLLECTIONS) {
      const previous = snapshots.get(c) || new Map();
      const current = new Map();
      for (const r of Array.isArray(data[c]) ? data[c] : []) current.set(rowId(r), JSON.stringify(r));
      for (const [id, json] of current) {
        if (previous.get(id) !== json) {
          await client.query(`INSERT INTO app_records(collection,record_id,data,updated_at) VALUES($1,$2,$3::jsonb,NOW()) ON CONFLICT(collection,record_id) DO UPDATE SET data=EXCLUDED.data,updated_at=NOW()`, [c, id, json]);
        }
      }
      for (const id of previous.keys()) {
        if (!current.has(id)) await client.query('DELETE FROM app_records WHERE collection=$1 AND record_id=$2', [c, id]);
      }
      snapshots.set(c, current);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}

let saveTimer = null;
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (flushing) { flushAgain = true; return; }
    flushing = true;
    flushPostgres().catch(e => console.error('Database save failed:', e.message)).finally(() => {
      flushing = false;
      if (flushAgain) { flushAgain = false; save(); }
    });
  }, 50);
}
async function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  while (flushing) await new Promise(r => setTimeout(r, 10));
  flushing = true;
  try { await flushPostgres(); } finally { flushing = false; }
}

init().catch(() => {});
module.exports = {
  data,
  ready,
  save,
  saveNow,
  isPostgres: USE_POSTGRES,
  pool
};
