import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.RH_DB_PATH || '/data/rh_newcoin.sqlite';
const SCHEMA_VERSION = '1';

let db = null;
let dbOk = false;
let lastDbError = '';

function lc(v) { return String(v || '').toLowerCase(); }
function text(v) { return v == null ? '' : String(v); }
function nowIso() { return new Date().toISOString(); }
function json(v) { try { return JSON.stringify(v ?? {}); } catch { return '{}'; } }

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS db_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      token_address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      decimals INTEGER,
      total_supply TEXT,
      creator_address TEXT,
      source TEXT,
      launchpad TEXT,
      curve_address TEXT,
      quote_token TEXT,
      quote_symbol TEXT,
      first_seen_block INTEGER,
      first_seen_at TEXT NOT NULL,
      first_price_quote TEXT,
      first_market_cap_quote TEXT,
      curve_progress REAL,
      status TEXT NOT NULL DEFAULT 'Discovery',
      last_updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tokens_first_seen_at
      ON tokens(first_seen_at);
    CREATE INDEX IF NOT EXISTS idx_tokens_status
      ON tokens(status);

    CREATE TABLE IF NOT EXISTS pools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_key TEXT NOT NULL UNIQUE,
      chain_id INTEGER NOT NULL DEFAULT 4663,
      pool_address TEXT,
      pool_id TEXT,
      token_address TEXT NOT NULL,
      dex TEXT,
      pool_version TEXT,
      quote_token TEXT,
      quote_symbol TEXT,
      discovered_at TEXT NOT NULL,
      block_number INTEGER,
      tx_hash TEXT,
      source TEXT,
      raw_payload TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );

    CREATE INDEX IF NOT EXISTS idx_pools_token
      ON pools(token_address);
    CREATE INDEX IF NOT EXISTS idx_pools_discovered_at
      ON pools(discovered_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pools_tx_pool
      ON pools(tx_hash, pool_key)
      WHERE tx_hash IS NOT NULL AND tx_hash <> '';

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      token_address TEXT,
      tx_hash TEXT,
      log_index INTEGER NOT NULL DEFAULT -1,
      block_number INTEGER,
      event_time TEXT NOT NULL,
      source TEXT,
      raw_payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_chain_unique
      ON events(event_type, tx_hash, log_index)
      WHERE tx_hash IS NOT NULL AND tx_hash <> '';
    CREATE INDEX IF NOT EXISTS idx_events_token_time
      ON events(token_address, event_time);
    CREATE INDEX IF NOT EXISTS idx_events_type_time
      ON events(event_type, event_time);

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      block_number INTEGER,
      price_quote TEXT,
      price_usd REAL,
      market_cap_quote TEXT,
      market_cap_usd REAL,
      quote_reserve TEXT,
      token_reserve TEXT,
      real_quote_reserve TEXT,
      graduation_threshold TEXT,
      curve_progress REAL,
      sellable_tokens TEXT,
      holder_count INTEGER,
      volume_5m REAL,
      buys_5m INTEGER,
      sells_5m INTEGER,
      raw_payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address),
      UNIQUE(token_address, snapshot_type, captured_at)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_token_time
      ON snapshots(token_address, captured_at);

    CREATE TABLE IF NOT EXISTS stage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_address TEXT NOT NULL,
      old_stage TEXT,
      new_stage TEXT NOT NULL,
      trigger TEXT,
      evidence TEXT,
      event_time TEXT NOT NULL,
      tx_hash TEXT,
      project_score REAL,
      entry_score REAL,
      raw_payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(token_address) REFERENCES tokens(token_address),
      UNIQUE(token_address, new_stage)
    );

    CREATE INDEX IF NOT EXISTS idx_stage_history_time
      ON stage_history(event_time);
  `);
}

function getMeta(key) {
  return db.prepare('SELECT value FROM db_meta WHERE key = ?').get(key)?.value ?? null;
}

function setMeta(key, value) {
  db.prepare(`
    INSERT INTO db_meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function bumpBootMeta() {
  let uuid = getMeta('db_uuid');
  if (!uuid) {
    uuid = randomUUID();
    setMeta('db_uuid', uuid);
    setMeta('created_at', nowIso());
    setMeta('boot_count', '0');
  }
  const bootCount = Number(getMeta('boot_count') || 0) + 1;
  setMeta('boot_count', String(bootCount));
  setMeta('schema_version', SCHEMA_VERSION);
  setMeta('last_boot_at', nowIso());
  return { uuid, bootCount };
}

function runUniqueSelfTest() {
  const testCa = '0x00000000000000000000000000000000db5e1f01';
  const testTx = '0x' + 'ab'.repeat(32);
  let tokenUnique = false;
  let eventUnique = false;

  db.exec('BEGIN IMMEDIATE');
  try {
    const ts = nowIso();
    db.prepare(`
      INSERT OR IGNORE INTO tokens(token_address, first_seen_at, status, last_updated_at)
      VALUES (?, ?, 'Discovery', ?)
    `).run(testCa, ts, ts);
    db.prepare(`
      INSERT OR IGNORE INTO tokens(token_address, first_seen_at, status, last_updated_at)
      VALUES (?, ?, 'Discovery', ?)
    `).run(testCa, ts, ts);
    tokenUnique = Number(db.prepare('SELECT changes() AS n').get()?.n || 0) === 0;

    db.prepare(`
      INSERT OR IGNORE INTO events(event_type, token_address, tx_hash, log_index, event_time, created_at)
      VALUES ('TOKEN_DISCOVERED', ?, ?, 7, ?, ?)
    `).run(testCa, testTx, ts, ts);
    db.prepare(`
      INSERT OR IGNORE INTO events(event_type, token_address, tx_hash, log_index, event_time, created_at)
      VALUES ('TOKEN_DISCOVERED', ?, ?, 7, ?, ?)
    `).run(testCa, testTx, ts, ts);
    eventUnique = Number(db.prepare('SELECT changes() AS n').get()?.n || 0) === 0;
  } finally {
    db.exec('ROLLBACK');
  }

  if (!tokenUnique || !eventUnique) {
    throw new Error(`SQLite UNIQUE self-test failed token=${tokenUnique} event=${eventUnique}`);
  }
  return { tokenUnique, eventUnique };
}

export function initDb() {
  if (db && dbOk) return getDbHealth();
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode=WAL;');
    db.exec('PRAGMA synchronous=NORMAL;');
    db.exec('PRAGMA foreign_keys=ON;');
    db.exec('PRAGMA busy_timeout=5000;');

    createSchema();
    const meta = bumpBootMeta();
    const selfTest = runUniqueSelfTest();

    dbOk = true;
    lastDbError = '';
    console.log(`[sqlite] ready path=${DB_PATH} schema=${SCHEMA_VERSION} uuid=${meta.uuid} boot=${meta.bootCount} token_unique=${selfTest.tokenUnique ? 'PASS' : 'FAIL'} event_unique=${selfTest.eventUnique ? 'PASS' : 'FAIL'}`);
    return getDbHealth();
  } catch (err) {
    dbOk = false;
    lastDbError = String(err?.message || err);
    console.error('[sqlite] init failed', lastDbError);
    return getDbHealth();
  }
}

function ensureDb() {
  if (db && dbOk) return true;
  return Boolean(initDb().ok);
}

export function persistToken(payload = {}) {
  if (!ensureDb()) return { ok: false, error: lastDbError };
  const ca = lc(payload.token_ca || payload.token_address);
  if (!ca) return { ok: false, error: 'missing token_ca' };
  const at = text(payload.event_time || payload.first_seen_at || nowIso());
  const updated = nowIso();

  db.prepare(`
    INSERT INTO tokens(
      token_address, symbol, name, decimals, total_supply, creator_address,
      source, launchpad, curve_address, quote_token, quote_symbol,
      first_seen_block, first_seen_at, first_price_quote, first_market_cap_quote,
      curve_progress, status, last_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(token_address) DO UPDATE SET
      symbol=COALESCE(NULLIF(excluded.symbol,''), tokens.symbol),
      name=COALESCE(NULLIF(excluded.name,''), tokens.name),
      decimals=COALESCE(excluded.decimals, tokens.decimals),
      total_supply=COALESCE(NULLIF(excluded.total_supply,''), tokens.total_supply),
      creator_address=COALESCE(NULLIF(excluded.creator_address,''), tokens.creator_address),
      source=COALESCE(NULLIF(excluded.source,''), tokens.source),
      launchpad=COALESCE(NULLIF(excluded.launchpad,''), tokens.launchpad),
      curve_address=COALESCE(NULLIF(excluded.curve_address,''), tokens.curve_address),
      quote_token=COALESCE(NULLIF(excluded.quote_token,''), tokens.quote_token),
      quote_symbol=COALESCE(NULLIF(excluded.quote_symbol,''), tokens.quote_symbol),
      first_price_quote=COALESCE(tokens.first_price_quote, NULLIF(excluded.first_price_quote,'')),
      first_market_cap_quote=COALESCE(tokens.first_market_cap_quote, NULLIF(excluded.first_market_cap_quote,'')),
      curve_progress=COALESCE(excluded.curve_progress, tokens.curve_progress),
      status=COALESCE(NULLIF(excluded.status,''), tokens.status),
      last_updated_at=excluded.last_updated_at
  `).run(
    ca, text(payload.symbol), text(payload.name), payload.decimals ?? null,
    text(payload.total_supply), lc(payload.deployer || payload.creator_address),
    text(payload.source), text(payload.launchpad), lc(payload.curve || payload.curve_address || payload.pair),
    lc(payload.quote_token), text(payload.quote_symbol || payload.quote),
    payload.block_number ?? payload.first_seen_block ?? null, at,
    text(payload.price_quote || payload.first_price_quote),
    text(payload.market_cap_quote || payload.first_market_cap_quote),
    payload.curve_progress ?? null, text(payload.stage || payload.status || 'Discovery'), updated
  );
  return { ok: true, token_address: ca };
}

export function persistEvent(payload = {}) {
  if (!ensureDb()) return { ok: false, error: lastDbError };
  const eventType = text(payload.event_type).toUpperCase();
  if (!eventType) return { ok: false, error: 'missing event_type' };
  const ca = lc(payload.token_ca || payload.token_address);
  const txHash = lc(payload.tx_hash || payload.discovery_tx || payload.first_swap_tx);
  const logIndex = Number.isFinite(Number(payload.log_index)) ? Number(payload.log_index) : -1;
  const at = text(payload.event_time || nowIso());
  const r = db.prepare(`
    INSERT OR IGNORE INTO events(
      event_type, token_address, tx_hash, log_index, block_number,
      event_time, source, raw_payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(eventType, ca || null, txHash || null, logIndex,
    payload.block_number ?? null, at, text(payload.source), json(payload), nowIso());
  return { ok: true, inserted: Number(r.changes || 0) === 1 };
}

export function persistSnapshot(payload = {}, snapshotType = '') {
  if (!ensureDb()) return { ok: false, error: lastDbError };
  const ca = lc(payload.token_ca || payload.token_address);
  if (!ca) return { ok: false, error: 'missing token_ca' };
  const kind = text(snapshotType || payload.snapshot_type || payload.event_type || 'snapshot');
  const at = text(payload.event_time || payload.captured_at || nowIso());
  const r = db.prepare(`
    INSERT OR IGNORE INTO snapshots(
      token_address, snapshot_type, captured_at, block_number,
      price_quote, price_usd, market_cap_quote, market_cap_usd,
      quote_reserve, token_reserve, real_quote_reserve, graduation_threshold,
      curve_progress, sellable_tokens, holder_count, volume_5m, buys_5m, sells_5m,
      raw_payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ca, kind, at, payload.block_number ?? null,
    text(payload.price_quote), payload.price_usd ?? null,
    text(payload.market_cap_quote), payload.market_cap_usd ?? null,
    text(payload.quote_reserve), text(payload.token_reserve),
    text(payload.real_quote_reserve), text(payload.graduation_threshold),
    payload.curve_progress ?? null, text(payload.sellable_tokens),
    payload.holder_count ?? null, payload.volume_5m ?? null,
    payload.buys_5m ?? null, payload.sells_5m ?? null,
    json(payload), nowIso()
  );
  return { ok: true, inserted: Number(r.changes || 0) === 1 };
}

export function persistStageChange(payload = {}) {
  if (!ensureDb()) return { ok: false, error: lastDbError };
  const ca = lc(payload.token_ca || payload.token_address);
  const newStage = text(payload.new_stage || payload.stage);
  if (!ca || !newStage) return { ok: false, error: 'missing token_ca or new_stage' };
  const r = db.prepare(`
    INSERT OR IGNORE INTO stage_history(
      token_address, old_stage, new_stage, trigger, evidence,
      event_time, tx_hash, project_score, entry_score, raw_payload, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ca, text(payload.old_stage), newStage, text(payload.trigger), text(payload.evidence),
    text(payload.event_time || nowIso()), lc(payload.tx_hash || payload.first_swap_tx),
    payload.project_score ?? null, payload.entry_score ?? null, json(payload), nowIso()
  );
  if (Number(r.changes || 0) === 1) {
    db.prepare('UPDATE tokens SET status = ?, last_updated_at = ? WHERE token_address = ?')
      .run(newStage, nowIso(), ca);
  }
  return { ok: true, inserted: Number(r.changes || 0) === 1 };
}

export function getDbHealth() {
  let meta = {};
  if (db) {
    try {
      meta = {
        uuid: getMeta('db_uuid'),
        boot_count: Number(getMeta('boot_count') || 0),
        schema_version: getMeta('schema_version'),
        tokens: Number(db.prepare('SELECT COUNT(*) AS n FROM tokens').get()?.n || 0),
        events: Number(db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n || 0),
        snapshots: Number(db.prepare('SELECT COUNT(*) AS n FROM snapshots').get()?.n || 0),
        stage_history: Number(db.prepare('SELECT COUNT(*) AS n FROM stage_history').get()?.n || 0)
      };
    } catch {}
  }
  return { ok: dbOk, path: DB_PATH, last_error: lastDbError, ...meta };
}
