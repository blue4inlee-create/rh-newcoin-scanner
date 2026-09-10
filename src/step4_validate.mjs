import { persistToken, persistSnapshot, getDbHealth } from './db.mjs';

if (process.env.STEP4_VALIDATE !== '1') process.exit(0);

const RPC = process.env.RH_HTTP_URL || 'https://rpc.mainnet.chain.robinhood.com';
const ZERO = '0x0000000000000000000000000000000000000000';
const SEL = {
  getReserves: '0x0902f1ac',
  realQuoteReserve: '0x4f1f58fd',
  graduationThreshold: '0x8b0bc501',
  sellableTokens: '0x808bcddc',
  readyToGraduate: '0xc68360a5',
  graduated: '0xe7c2b772',
  pairToken: '0x3de35b79',
  totalSupply: '0x18160ddd',
  decimals: '0x313ce567',
};

const samples = [
  { symbol:'BRAWL', token:'0x519aa85cdd29755ba5651de85194d3d5d209517e', curve:'0x017d702a515b2254be04b6b5e8b7defa54a7011f', quote:'ETH', block:59042465, first_seen:'2026-09-10T10:21:40+08:00' },
  { symbol:'STOCKY', token:'0xde44e77deb94dc55a1f210d82e244f4ff27d8f09', curve:'0x48c108295cb20826c5553e2404a39ba0f6c0a008', quote:'ETH', block:59004692, first_seen:'2026-09-10T09:18:08+08:00' },
  { symbol:'CLARA', token:'0xbf342177b5e527033f030a4f3258f02995bbfe91', curve:'0x603656df12ea1711d66f5fbbb8f8c61f17c9f8cb', quote:'GOOGL', block:59086207, first_seen:'2026-09-10T11:35:14+08:00' },
  { symbol:'Ballscoin', token:'0x7e47575026705ba41f4174d2a03c4eb560331e8b', curve:'0x8b2b60438f6cfa50424e5ab04afba4332df7d5bb', quote:'SPCX', block:59093043, first_seen:'2026-09-10T11:46:45+08:00' },
  { symbol:'NFL', token:'0xa405af1b06b132a63219a976dd544ea71fca2edc', curve:'0x1dc2480b481d8f4f8b04e93142116e26f284f018', quote:'USDG', block:59157041, first_seen:'2026-09-10T13:34:22+08:00' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpc(method, params) {
  const res = await fetch(RPC, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}) });
  const j = await res.json();
  if (j.error) throw new Error(`${j.error.code}: ${j.error.message}`);
  return j.result;
}
async function call(to, data) {
  const out = await rpc('eth_call', [{to, data}, 'latest']);
  await sleep(1000);
  return out;
}
function word(hex, i=0) { return BigInt('0x' + hex.slice(2 + i*64, 2 + (i+1)*64)); }
function addr(hex) { return '0x' + hex.slice(-40).toLowerCase(); }
function bool(hex) { return word(hex) !== 0n; }
function pow10(n) { return 10n ** BigInt(n); }
function fmt(raw, dec, places=18) {
  const d = pow10(dec), whole = raw / d, frac = (raw % d).toString().padStart(dec,'0').slice(0, places).replace(/0+$/,'');
  return frac ? `${whole}.${frac}` : String(whole);
}
function ratio(num, den, precision=24) {
  if (den === 0n) return null;
  const scale = pow10(precision), q = num * scale / den;
  const s = q.toString().padStart(precision+1,'0');
  return `${s.slice(0,-precision)}.${s.slice(-precision)}`.replace(/\.0+$/,'').replace(/(\.\d*?)0+$/,'$1');
}

let ok = 0, failed = 0, rateLimits = 0;
for (const s of samples) {
  const started = Date.now();
  try {
    const reservesHex = await call(s.curve, SEL.getReserves);
    const qRaw = word(reservesHex,0), tRaw = word(reservesHex,1);
    const realRaw = word(await call(s.curve, SEL.realQuoteReserve));
    const thresholdRaw = word(await call(s.curve, SEL.graduationThreshold));
    const sellableRaw = word(await call(s.curve, SEL.sellableTokens));
    const ready = bool(await call(s.curve, SEL.readyToGraduate));
    const graduated = bool(await call(s.curve, SEL.graduated));
    const pair = addr(await call(s.curve, SEL.pairToken));
    const supplyRaw = word(await call(s.token, SEL.totalSupply));
    const tokenDec = Number(word(await call(s.token, SEL.decimals)));
    const quoteDec = pair === ZERO ? 18 : Number(word(await call(pair, SEL.decimals)));

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
    const at = new Date().toISOString();

    persistToken({ token_ca:s.token, symbol:s.symbol, source:'Pons V2', launchpad:'Pons V2', curve:s.curve, quote_token:pair, quote_symbol:s.quote, block_number:s.block, first_seen_at:s.first_seen, decimals:tokenDec, total_supply:supply, price_quote:price || '', market_cap_quote:mc || '', curve_progress:progress, status:graduated?'Graduated':'Curve' });
    const saved = persistSnapshot({ token_ca:s.token, event_time:at, block_number:s.block, price_quote:price || '', market_cap_quote:mc || '', quote_reserve:q, token_reserve:t, real_quote_reserve:real, graduation_threshold:threshold, curve_progress:progress, sellable_tokens:sellable, phase:graduated?'PoolCreated':'NotGraduated', ready_to_graduate:ready, graduated, pair_token:pair, quote_symbol:s.quote, quote_decimals:quoteDec, token_decimals:tokenDec }, 'STEP4_VALIDATION');

    const valid = graduated ? (tRaw === 0n && sellableRaw === 0n) : Boolean(price && mc && progressStr !== null && tRaw > 0n);
    if (!valid) throw new Error('validation invariant failed');
    ok++;
    console.log(`[STEP4] PASS ${s.symbol} phase=${graduated?'Graduated':'Curve'} quote=${s.quote} qdec=${quoteDec} price=${price ?? 'N/A'} mc=${mc ?? 'N/A'} progress=${progressStr ?? 'N/A'}% q=${q} real=${real} threshold=${threshold} sellable=${sellable} db_inserted=${saved.inserted} ms=${Date.now()-started}`);
  } catch (err) {
    failed++;
    if (/429|rate limit/i.test(String(err?.message || err))) rateLimits++;
    console.error(`[STEP4] FAIL ${s.symbol} ${String(err?.message || err)} ms=${Date.now()-started}`);
  }
}

const health = getDbHealth();
console.log(`[STEP4] SUMMARY ok=${ok}/5 failed=${failed} rate_limits=${rateLimits} db_tokens=${health.tokens} db_snapshots=${health.snapshots} db_uuid=${health.uuid}`);
if (ok !== 5 || failed !== 0 || rateLimits !== 0) process.exit(2);
