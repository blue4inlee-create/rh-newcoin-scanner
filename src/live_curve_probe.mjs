import { persistToken, persistSnapshot, persistEvent } from './db.mjs';

const RPC = process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com';
const ENABLED = process.env.LIVE_CURVE_PROBE === '1';
const ZERO = '0x0000000000000000000000000000000000000000';
const PONS_V2_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const PONS_V2_TOPIC = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const MAX_DISCOVERY_AGE_S = 60;
const CALL_GAP_MS = 450;
const POLL_MS = 1500;
const MAX_LOG_BLOCKS = 200n;

const SEL = {
  getReserves: '0x0902f1ac',
  realQuoteReserve: '0x4f1f58fd',
  graduationThreshold: '0x8b0bc501',
  sellableTokens: '0x808bcddc',
  graduated: '0xe7c2b772',
  pairToken: '0x3de35b79',
  totalSupply: '0x18160ddd',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
};

const queue = [];
const queued = new Set();
const completed = new Set();
let working = false;
let rpc429 = 0;
let rawCursor = null;
let rawPollStarted = false;
const blockTimeCache = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lc = v => String(v || '').toLowerCase();
const nowIso = () => new Date().toISOString();

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  if (res.status === 429 || /rate limit/i.test(text)) rpc429++;
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${text.slice(0, 180)}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`RPC invalid JSON: ${text.slice(0, 180)}`); }
  if (j.error) throw new Error(`${j.error.code}: ${j.error.message}`);
  return j.result;
}

async function call(to, data) {
  const out = await rpc('eth_call', [{ to, data }, 'latest']);
  await sleep(CALL_GAP_MS);
  return out;
}

function word(hex, i = 0) {
  if (!hex || hex === '0x') throw new Error('empty eth_call result');
  return BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
}
function addr(hex) { return '0x' + hex.slice(-40).toLowerCase(); }
function topicAddr(hex) { return '0x' + String(hex || '').slice(-40).toLowerCase(); }
function bool(hex) { return word(hex) !== 0n; }
function pow10(n) { return 10n ** BigInt(n); }
function fmt(raw, dec, places = 18) {
  const d = pow10(dec);
  const whole = raw / d;
  const frac = (raw % d).toString().padStart(dec, '0').slice(0, places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}
function ratio(num, den, precision = 24) {
  if (den === 0n) return null;
  const scale = pow10(precision);
  const q = num * scale / den;
  const s = q.toString().padStart(precision + 1, '0');
  return `${s.slice(0, -precision)}.${s.slice(-precision)}`.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
function decodeAbiString(hex) {
  try {
    const body = String(hex || '').replace(/^0x/, '');
    if (body.length < 64) return '';
    const offset = Number(BigInt('0x' + body.slice(0, 64)));
    if (offset >= 0 && offset * 2 + 64 <= body.length) {
      const lenPos = offset * 2;
      const len = Number(BigInt('0x' + body.slice(lenPos, lenPos + 64)));
      const data = body.slice(lenPos + 64, lenPos + 64 + len * 2);
      if (data) return Buffer.from(data, 'hex').toString('utf8').replace(/\0/g, '').trim();
    }
    return Buffer.from(body.slice(0, 64), 'hex').toString('utf8').replace(/\0/g, '').trim();
  } catch {
    return '';
  }
}
async function readSymbol(address, fallback = '') {
  if (lc(address) === ZERO) return 'ETH';
  try {
    const s = decodeAbiString(await call(address, SEL.symbol));
    return s || fallback;
  } catch {
    return fallback;
  }
}

function eventAgeSeconds(payload) {
  const direct = Number(payload?.age_seconds);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const t = Date.parse(String(payload?.event_time || ''));
  if (Number.isFinite(t)) return Math.max(0, (Date.now() - t) / 1000);
  return 0;
}

async function blockEventTime(blockHex) {
  const key = lc(blockHex);
  if (blockTimeCache.has(key)) return blockTimeCache.get(key);
  const b = await rpc('eth_getBlockByNumber', [blockHex, false]);
  const iso = b?.timestamp ? new Date(Number(BigInt(b.timestamp)) * 1000).toISOString() : nowIso();
  blockTimeCache.set(key, iso);
  if (blockTimeCache.size > 1000) {
    const first = blockTimeCache.keys().next().value;
    blockTimeCache.delete(first);
  }
  return iso;
}

async function probe(payload) {
  const started = Date.now();
  const token = lc(payload.token_ca);
  const curve = lc(payload.pair || payload.curve);
  let symbol = String(payload.symbol || '');
  let quoteSymbol = String(payload.quote_symbol || payload.quote || '');
  const initialAge = eventAgeSeconds(payload);

  if (!token || !curve) throw new Error('missing token or curve');

  const reservesHex = await call(curve, SEL.getReserves);
  const qRaw = word(reservesHex, 0);
  const tRaw = word(reservesHex, 1);
  const realRaw = word(await call(curve, SEL.realQuoteReserve));
  const thresholdRaw = word(await call(curve, SEL.graduationThreshold));
  const sellableRaw = word(await call(curve, SEL.sellableTokens));
  const graduated = bool(await call(curve, SEL.graduated));
  const pair = addr(await call(curve, SEL.pairToken));
  const supplyRaw = word(await call(token, SEL.totalSupply));
  const tokenDec = Number(word(await call(token, SEL.decimals)));
  const quoteDec = pair === ZERO ? 18 : Number(word(await call(pair, SEL.decimals)));
  if (!symbol) symbol = await readSymbol(token, token.slice(0, 10));
  if (!quoteSymbol) quoteSymbol = pair === ZERO ? 'ETH' : await readSymbol(pair, pair.slice(0, 10));

  const q = fmt(qRaw, quoteDec, quoteDec);
  const t = fmt(tRaw, tokenDec, tokenDec);
  const real = fmt(realRaw, quoteDec, quoteDec);
  const threshold = fmt(thresholdRaw, quoteDec, quoteDec);
  const sellable = fmt(sellableRaw, tokenDec, tokenDec);
  const supply = fmt(supplyRaw, tokenDec, tokenDec);
  const price = tRaw === 0n ? null : ratio(qRaw * pow10(tokenDec), tRaw * pow10(quoteDec), 24);
  const mc = tRaw === 0n ? null : ratio(qRaw * supplyRaw, tRaw * pow10(quoteDec), 18);
  const progressStr = thresholdRaw === 0n ? null : ratio(realRaw * 100n, thresholdRaw, 12);
  const progress = progressStr == null ? null : Number(progressStr);
  const capturedAt = nowIso();

  if (!graduated && (!price || !mc || progress == null || tRaw === 0n)) {
    throw new Error('curve invariant failed');
  }

  persistToken({
    token_ca: token,
    symbol,
    source: 'Pons V2',
    launchpad: 'Pons V2',
    curve,
    quote_token: pair,
    quote_symbol: quoteSymbol,
    block_number: payload.block_number ?? null,
    first_seen_at: payload.event_time || capturedAt,
    decimals: tokenDec,
    total_supply: supply,
    price_quote: price || '',
    market_cap_quote: mc || '',
    curve_progress: progress,
    status: graduated ? 'Graduated' : 'Curve',
  });

  const saved = persistSnapshot({
    token_ca: token,
    event_time: capturedAt,
    block_number: payload.block_number ?? null,
    price_quote: price || '',
    market_cap_quote: mc || '',
    quote_reserve: q,
    token_reserve: t,
    real_quote_reserve: real,
    graduation_threshold: threshold,
    curve_progress: progress,
    sellable_tokens: sellable,
    phase: graduated ? 'PoolCreated' : 'NotGraduated',
    graduated,
    pair_token: pair,
    quote_symbol: quoteSymbol,
    quote_decimals: quoteDec,
    token_decimals: tokenDec,
    discovery_tx: payload.discovery_tx || payload.tx_hash || '',
    discovery_age_seconds: initialAge,
  }, 'LIVE_CURVE_DISCOVERY');

  persistEvent({
    event_type: 'LIVE_CURVE_DISCOVERY',
    token_ca: token,
    tx_hash: payload.discovery_tx || payload.tx_hash || '',
    log_index: payload.log_index ?? -1,
    block_number: payload.block_number ?? null,
    event_time: capturedAt,
    source: payload.discovery_source || 'Pons V2',
    price_quote: price || '',
    market_cap_quote: mc || '',
    curve_progress: progress,
  });

  const probeMs = Date.now() - started;
  const totalAge = initialAge + probeMs / 1000;
  console.log(`[LIVE-CURVE] PASS ${symbol || token} ca=${token} quote=${quoteSymbol || pair} qdec=${quoteDec} price=${price ?? 'N/A'} mc=${mc ?? 'N/A'} progress=${progressStr ?? 'N/A'}% discovery_age=${initialAge.toFixed(2)}s probe_ms=${probeMs} total_age=${totalAge.toFixed(2)}s db_inserted=${saved.inserted} rpc429=${rpc429}`);
  return { token, symbol, quoteSymbol, price, mc, progress, totalAge, saved };
}

async function drain() {
  if (working) return;
  working = true;
  try {
    while (queue.length) {
      const payload = queue.shift();
      const key = `${lc(payload.token_ca)}:${lc(payload.discovery_tx || payload.tx_hash)}`;
      try {
        await probe(payload);
        completed.add(key);
        if (completed.size > 5000) {
          const first = completed.values().next().value;
          completed.delete(first);
        }
      } catch (err) {
        console.error(`[LIVE-CURVE] FAIL ${payload.symbol || payload.token_ca || ''} ca=${lc(payload.token_ca)} ${String(err?.message || err)}`);
      } finally {
        queued.delete(key);
      }
    }
  } finally {
    working = false;
  }
}

export function queueLiveCurveProbe(payload = {}) {
  if (!ENABLED) return { queued: false, reason: 'disabled' };
  if (String(payload.event_type || '').toUpperCase() !== 'TOKEN_DISCOVERED') return { queued: false, reason: 'event_type' };
  if (String(payload.source || '') !== 'Pons V2') return { queued: false, reason: 'source' };
  if (eventAgeSeconds(payload) > MAX_DISCOVERY_AGE_S) return { queued: false, reason: 'stale' };

  const key = `${lc(payload.token_ca)}:${lc(payload.discovery_tx || payload.tx_hash)}`;
  if (!payload.token_ca || !payload.pair || queued.has(key) || completed.has(key)) return { queued: false, reason: 'duplicate_or_missing' };
  queued.add(key);
  queue.push({ ...payload });
  queueMicrotask(() => { drain().catch(err => console.error('[LIVE-CURVE] drain failed', String(err?.message || err))); });
  console.log(`[LIVE-CURVE] QUEUED ${payload.symbol || ''} ${lc(payload.token_ca)} age=${eventAgeSeconds(payload).toFixed(2)}s depth=${queue.length}`);
  return { queued: true };
}

async function processRawPonsLog(log) {
  if (!Array.isArray(log?.topics) || log.topics.length < 4) return;
  const token = topicAddr(log.topics[1]);
  const curve = topicAddr(log.topics[2]);
  const deployer = topicAddr(log.topics[3]);
  const pairToken = addr(String(log.data || '').slice(0, 66));
  const eventTime = await blockEventTime(log.blockNumber);
  const age = Math.max(0, (Date.now() - Date.parse(eventTime)) / 1000);
  const blockNumber = Number(BigInt(log.blockNumber));
  const logIndex = Number(BigInt(log.logIndex || '0x0'));

  persistToken({
    token_ca: token,
    source: 'Pons V2',
    launchpad: 'Pons V2',
    curve,
    quote_token: pairToken,
    block_number: blockNumber,
    first_seen_at: eventTime,
    deployer,
    status: 'Discovery',
  });

  console.log(`[LIVE-PONS] RAW token=${token} curve=${curve} pair=${pairToken} block=${blockNumber} age=${age.toFixed(2)}s tx=${log.transactionHash}`);
  queueLiveCurveProbe({
    event_type: 'TOKEN_DISCOVERED',
    event_time: eventTime,
    age_seconds: age,
    block_number: blockNumber,
    log_index: logIndex,
    tx_hash: log.transactionHash,
    discovery_tx: log.transactionHash,
    token_ca: token,
    pair: curve,
    curve,
    deployer,
    quote_token: pairToken,
    source: 'Pons V2',
    launchpad: 'Pons V2',
    dex_version: 'Curve',
    stage: 'Discovery',
    discovery_source: 'raw-factory-poll',
  });
}

async function rawPollOnce() {
  const latestHex = await rpc('eth_blockNumber', []);
  const latest = BigInt(latestHex);
  if (rawCursor == null) {
    rawCursor = latest;
    console.log(`[LIVE-PONS] START rpc=${RPC} cursor=${rawCursor}`);
    return;
  }
  if (latest <= rawCursor) return;

  let from = rawCursor + 1n;
  while (from <= latest) {
    const to = from + MAX_LOG_BLOCKS - 1n > latest ? latest : from + MAX_LOG_BLOCKS - 1n;
    const logs = await rpc('eth_getLogs', [{
      address: PONS_V2_FACTORY,
      topics: [PONS_V2_TOPIC],
      fromBlock: '0x' + from.toString(16),
      toBlock: '0x' + to.toString(16),
    }]);
    for (const log of logs || []) await processRawPonsLog(log);
    rawCursor = to;
    from = to + 1n;
  }
}

export function startLivePonsPoller() {
  if (!ENABLED || rawPollStarted) return;
  rawPollStarted = true;
  const loop = async () => {
    try {
      await rawPollOnce();
    } catch (err) {
      console.error('[LIVE-PONS] POLL_FAIL', String(err?.message || err));
    } finally {
      const timer = setTimeout(loop, POLL_MS);
      timer.unref?.();
    }
  };
  loop().catch(err => console.error('[LIVE-PONS] START_FAIL', String(err?.message || err)));
}
