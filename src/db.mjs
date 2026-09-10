import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.env.RH_DB_PATH || '/data/rh_monitor.db';
let db = null;
let dbOk = false;
let lastDbError = '';

function lc(v) { return String(v || '').toLowerCase(); }
function nowIso() { return new Date().toISOString(); }
function json(v) { try { return JSON.stringify(v ?? {}); } catch { return '{}'; } }

export function initDb() {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        token_address TEXT PRIMARY KEY,
        symbol TEXT,
        name TEXT,
        decimals INTEGER,
        total_supply TEXT,
        creator_address TEXT,
        first_seen_at TEXT NOT NULL,
        first_pool_address TEXT,
        pool_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'Discovery',
        last_updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pool_key TEXT NOT NULL UNIQUE,
        chain_id INTEGER NOT NULL DEFAULT 4663,
        pool_address TEXT,
        pool_id TEXT,
        token_address TEXT NOT NULL,
        token_symbol TEXT,
        token_name TEXT,
        dex TEXT,
        pool_version TEXT,
        quote_token TEXT,
        quote_symbol TEXT,
        discovered_at TEXT NOT NULL,
        block_number INTEGER,
        tx_hash TEXT,
        creator_address TEXT,
        source TEXT,
        raw_payload TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(token_address) REFERENCES tokens(token_address)
      );

      CREATE INDEX IF NOT EXISTS idx_pools_token ON pools(token_address);
      CREATE INDEX IF NOT EXISTS idx_pools_discovered_at ON pools(discovered_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_pools_tx_pool ON pools(tx_hash, pool_key) WHERE tx_hash IS NOT NULL AND tx_hash <> '';
    `);
    dbOk = true;
    lastDbError = '';
    console.log(`[sqlite] connected ${DB_PATH}`);
    return true;
  } catch (err) {
    dbOk = false;
    lastDbError = String(err?.message || err);
    console.error('[sqlite] init failed', lastDbError);
    return false;
  }
}

function ensureDb() {
  if (db) return true;
  return initDb();
}

function derivePoolKey(payload) {
  const poolId = String(payload.pool_id || '').trim();
  if (poolId) return `v4:${lc(poolId)}`;
  const pair = String(payload.pair || payload.pool_address || '').trim();
  if (pair) return `pool:${lc(pair)}`;
  const token = String(payload.token_ca || '').trim();
  const tx = String(payload.discovery_tx || payload.tx_hash || '').trim();
  return `token:${lc(token)}:tx:${lc(tx)}`;
}

export function persistDiscovery(payload = {}) {
  if (!ensureDb()) return { ok: false, error: lastDbError };
  try {
    const token = lc(payload.token_ca);
    if (!token) return { ok: false, error: 'missing token_ca' };
    const at = payload.event_time || nowIso();
    const pair = String(payload.pair || '');
    const poolKey = derivePoolKey(payload);

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tokens (token_address, symbol, creator_address, first_seen_at, first_pool_address, pool_count, status, last_updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(token_address) DO UPDATE SET
          symbol=COALESCE(NULLIF(excluded.symbol,''), tokens.symbol),
          creator_address=COALESCE(NULLIF(excluded.creator_address,''), tokens.creator_address),
          last_updated_at=excluded.last_updated_at
      `).run(token, String(payload.symbol || ''), lc(payload.deployer), at, lc(pair), String(payload.stage || 'Discovery'), at);

      const before = db.prepare('SELECT id FROM pools WHERE pool_key = ?').get(poolKey);
      db.prepare(`
        INSERT INTO pools (
          pool_key, pool_address, pool_id, token_address, token_symbol, dex, pool_version,
          quote_token, quote_symbol, discovered_at, block_number, tx_hash, creator_address,
          source, raw_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pool_key) DO UPDATE SET
          token_symbol=COALESCE(NULLIF(excluded.token_symbol,''), pools.token_symbol),
          quote_token=COALESCE(NULLIF(excluded.quote_token,''), pools.quote_token),
          quote_symbol=COALESCE(NULLIF(excluded.quote_symbol,''), pools.quote_symbol),
          tx_hash=COALESCE(NULLIF(excluded.tx_hash,''), pools.tx_hash),
          creator_address=COALESCE(NULLIF(excluded.creator_address,''), pools.creator_address),
          source=COALESCE(NULLIF(excluded.source,''), pools.source),
          raw_payload=excluded.raw_payload,
          updated_at=excluded.updated_at
      `).run(
        poolKey, lc(pair), String(payload.pool_id || ''), token, String(payload.symbol || ''),
        String(payload.source || payload.launchpad || ''), String(payload.dex_version || ''),
        lc(payload.quote_token), String(payload.quote_symbol || ''), at,
        Number(payload.block_number || 0) || null, String(payload.discovery_tx || payload.tx_hash || ''),
        lc(payload.deployer), String(payload.source || ''), json(payload), at, at
      );
      if (!before) {
        db.prepare('UPDATE tokens SET pool_count = pool_count + 1, last_updated_at = ? WHERE token_address = ?').run(at, token);
      }
    });
    tx();
    dbOk = true;
    lastDbError = '';
    return { ok: true, pool_key: poolKey, token_address: token };
  } catch (err) {
    dbOk = false;
    lastDbError = String(err?.message || err);
    console.error('[sqlite] persist discovery failed', lastDbError);
    return { ok: false, error: lastDbError };
  }
}

export function getDbHealth() {
  return { ok: dbOk, path: DB_PATH, last_error: lastDbError };
}

initDb();
