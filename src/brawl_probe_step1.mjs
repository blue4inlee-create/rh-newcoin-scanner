import { createServer } from 'node:http';

const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const TOKEN = '0x519aA85cDD29755ba5651dE85194D3d5d209517e';
const CURVE = '0x017d702a515B2254BE04B6B5e8B7dEFa54A7011F';
const LAUNCH_BLOCK = '0x384eaa1'; // 59042465
const PORT = Number(process.env.PORT || 3000);

const SEL = {
  getReserves: '0x0902f1ac',
  realQuoteReserve: '0x4f1f58fd',
  graduationThreshold: '0x8b0bc501',
  sellableTokens: '0x808bcddc',
  readyToGraduate: '0xc68360a5',
  graduated: '0xe7c2b772',
  pairToken: '0x3de35b79',
  reservedTokens: '0x15a55347',
  feeBps: '0x24a9d853',
  creatorTaxBps: '0xc1bb8901',
  totalSupply: '0x18160ddd',
  decimals: '0x313ce567',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function rpcCall(to, data, block = 'latest') {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: attempt, method: 'eth_call', params: [{ to, data }, block] })
      });
      const text = await res.text();
      if (res.status === 429 || /rate limit|too many requests/i.test(text)) {
        last = new Error(`rate limit: HTTP ${res.status} ${text}`);
        await sleep(65000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
      const j = JSON.parse(text);
      if (j.error) throw new Error(JSON.stringify(j.error));
      await sleep(1500);
      return j.result;
    } catch (e) {
      last = e;
      if (attempt < 4) await sleep(2500 * attempt);
    }
  }
  throw last;
}

const words = hex => {
  const s = String(hex || '0x').slice(2);
  const out = [];
  for (let i = 0; i < s.length; i += 64) out.push('0x' + s.slice(i, i + 64));
  return out.filter(x => x.length === 66);
};
const uint = hex => BigInt(hex || '0x0');
const bool = hex => uint(hex) !== 0n;
const addr = hex => '0x' + String(hex).slice(-40);
const fmt = (n, d) => {
  n = BigInt(n); const neg = n < 0n; if (neg) n = -n;
  const s = n.toString().padStart(d + 1, '0');
  const a = d ? s.slice(0, -d) : s;
  let b = d ? s.slice(-d).replace(/0+$/, '') : '';
  return `${neg ? '-' : ''}${a}${b ? '.' + b : ''}`;
};

async function readUint(to, selector, block) { return uint(await rpcCall(to, selector, block)); }
async function readBool(to, selector, block) { return bool(await rpcCall(to, selector, block)); }

async function probe(block) {
  const reserveHex = await rpcCall(CURVE, SEL.getReserves, block);
  const rw = words(reserveHex);
  if (rw.length < 2) throw new Error(`getReserves decode failed: ${reserveHex}`);
  const quoteReserve = uint(rw[0]);
  const tokenReserve = uint(rw[1]);
  const realQuoteReserve = await readUint(CURVE, SEL.realQuoteReserve, block);
  const graduationThreshold = await readUint(CURVE, SEL.graduationThreshold, block);
  const sellableTokens = await readUint(CURVE, SEL.sellableTokens, block);
  const reservedTokens = await readUint(CURVE, SEL.reservedTokens, block);
  const readyToGraduate = await readBool(CURVE, SEL.readyToGraduate, block);
  const graduated = await readBool(CURVE, SEL.graduated, block);
  const pairTokenHex = await rpcCall(CURVE, SEL.pairToken, block);
  const pairToken = addr(pairTokenHex);
  const tokenDecimals = Number(await readUint(TOKEN, SEL.decimals, block));
  const totalSupply = await readUint(TOKEN, SEL.totalSupply, block);
  const quoteDecimals = /^0x0{40}$/i.test(pairToken) ? 18 : Number(await readUint(pairToken, SEL.decimals, block));

  const qNorm = Number(fmt(quoteReserve, quoteDecimals));
  const tNorm = Number(fmt(tokenReserve, tokenDecimals));
  const priceQuote = tNorm ? qNorm / tNorm : null;
  const supplyNorm = Number(fmt(totalSupply, tokenDecimals));
  const marketCapQuote = priceQuote == null ? null : priceQuote * supplyNorm;
  const progress = graduationThreshold === 0n ? null : Number(realQuoteReserve * 1_000_000n / graduationThreshold) / 10_000;

  return {
    block,
    raw: {
      quoteReserve: quoteReserve.toString(),
      tokenReserve: tokenReserve.toString(),
      realQuoteReserve: realQuoteReserve.toString(),
      graduationThreshold: graduationThreshold.toString(),
      sellableTokens: sellableTokens.toString(),
      reservedTokens: reservedTokens.toString(),
      totalSupply: totalSupply.toString(),
      pairToken,
      tokenDecimals,
      quoteDecimals,
      readyToGraduate,
      graduated,
    },
    formatted: {
      quoteReserve: fmt(quoteReserve, quoteDecimals),
      tokenReserve: fmt(tokenReserve, tokenDecimals),
      realQuoteReserve: fmt(realQuoteReserve, quoteDecimals),
      graduationThreshold: fmt(graduationThreshold, quoteDecimals),
      sellableTokens: fmt(sellableTokens, tokenDecimals),
      reservedTokens: fmt(reservedTokens, tokenDecimals),
      totalSupply: fmt(totalSupply, tokenDecimals),
      quoteSymbol: /^0x0{40}$/i.test(pairToken) ? 'ETH' : pairToken,
      marginalPriceInQuote: priceQuote,
      estimatedMarketCapInQuote: marketCapQuote,
      graduationProgressPct: progress,
    }
  };
}

let result = { ok: false, running: true, token: TOKEN, curve: CURVE };
(async () => {
  const started = Date.now();
  try {
    const launch = await probe(LAUNCH_BLOCK);
    const latest = await probe('latest');
    result = { ok: true, token: TOKEN, curve: CURVE, launchBlockDecimal: 59042465, launch, latest, elapsedMs: Date.now() - started };
    console.log('BRAWL_PROBE_RESULT=' + JSON.stringify(result));
  } catch (e) {
    result = { ok: false, token: TOKEN, curve: CURVE, error: String(e?.stack || e), elapsedMs: Date.now() - started };
    console.error('BRAWL_PROBE_ERROR=' + JSON.stringify(result));
  }
})();

createServer((req, res) => {
  res.writeHead(result.ok ? 200 : (result.running ? 202 : 500), { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(result));
}).listen(PORT, '0.0.0.0', () => console.log(`[probe] listening on ${PORT}`));
