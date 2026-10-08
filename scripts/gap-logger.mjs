// Gap logger: every 15 min, saves on-chain vs reference price + market status
// for every bStocks and Ondo token on BSC. No dependencies (Node >= 20.12).
// Output: data/gap-YYYY-MM-DD.jsonl (one line per token per run) + data/errors.jsonl
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

try { process.loadEnvFile(); } catch {}
const KEY = process.env.BINANCE_API_KEY, SECRET = process.env.BINANCE_API_SECRET;
if (!KEY || !SECRET) { console.error("Missing BINANCE_API_KEY / BINANCE_API_SECRET in .env"); process.exit(1); }

const DATA = path.resolve("data");
fs.mkdirSync(DATA, { recursive: true });
const EVERY_MS = 15 * 60 * 1000;

async function get(p, params) {
  // Binance allows 5 requests/s per endpoint, shared with the bot. Go slow so the bot never gets a 429.
  await new Promise((r) => setTimeout(r, 600));
  const pathWithQuery = "/build" + p + "?" + new URLSearchParams(params);
  const ts = new Date().toISOString();
  const sign = crypto.createHmac("sha256", SECRET).update(ts + "GET" + pathWithQuery).digest("base64");
  const t0 = Date.now();
  const res = await fetch("https://web3.binance.com" + pathWithQuery, {
    headers: { "X-OC-APIKEY": KEY, "X-OC-TIMESTAMP": ts, "X-OC-SIGN": sign },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${p} HTTP ${res.status} not JSON (${ms}ms): ${text.slice(0, 200)}`); }
  if (!res.ok || json.code !== 0) throw new Error(`${p} HTTP ${res.status} code ${json.code} (${ms}ms): ${json.msg}`);
  return { data: json.data, ms };
}

const gap = (a, b) => (Number(a) && Number(b) ? +((Number(a) / Number(b) - 1) * 100).toFixed(4) : null);
const day = () => new Date().toISOString().slice(0, 10);
const append = (file, rows) => fs.appendFileSync(path.join(DATA, file), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

// Real stock prices (Finnhub) for a small watchlist. Binance's referencePrice is derived from the token
// price, so this is the only way to measure the real on-chain vs stock gap. Free plan = 60 calls/min,
// shared with the bot, so keep the list short.
const WATCH = ["NVDA", "TSLA", "AAPL", "MSFT", "META", "AMZN", "GOOGL", "AMD", "MU", "COIN", "CRCL", "QQQ", "SPY", "PLTR", "NFLX"];

async function logRealPrices(time, rows) {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return 0;
  const out = [];
  for (const ticker of WATCH) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}`, { headers: { "X-Finnhub-Token": key }, signal: AbortSignal.timeout(10000) });
      const q = await res.json();
      if (!(q.c > 0)) continue;
      for (const r of rows.filter((x) => x.ticker === ticker && x.ref)) {
        out.push({ time, ticker, symbol: r.symbol, platform: r.platform, sharePrice: r.ref, realPrice: q.c, realPrevClose: q.pc,
          realAt: q.t * 1000, gapVsRealPct: +((Number(r.ref) / q.c - 1) * 100).toFixed(4), reason: r.reason, marketStatus: r.marketStatus });
      }
    } catch (e) {
      append("errors.jsonl", [{ time, error: `finnhub ${ticker}: ${e.message ?? e}` }]);
    }
  }
  if (out.length) append(`real-${day()}.jsonl`, out);
  return out.length;
}

async function run() {
  const time = new Date().toISOString();
  try {
    const tokens = [], timings = {};
    for (const platformId of ["bstock", "ondo"]) {
      const r = await get("/api/v1/dex/market/rwa/tokens", { binanceChainId: "56", platformId });
      timings[`tokens_${platformId}`] = r.ms;
      tokens.push(...r.data);
    }
    // Docs say max 100 addresses, but 90+ fails with HTTP 414 (URL too long). Use 50.
    // /rwa/price gives different numbers than /rwa/tokens (see DX log), so save both.
    const price = new Map();
    for (let i = 0; i < tokens.length; i += 50) {
      const addrs = tokens.slice(i, i + 50).map((t) => t.tokenContractAddress).join(",");
      const r = await get("/api/v1/dex/market/rwa/price", { binanceChainId: "56", tokenContractAddresses: addrs });
      timings[`price_${i / 50}`] = r.ms;
      for (const p of r.data) price.set(p.tokenContractAddress.toLowerCase(), p);
    }
    const rows = tokens.map((t) => {
      const p = price.get(t.tokenContractAddress.toLowerCase());
      return {
        time, ticker: t.underlyingTicker, symbol: t.tokenSymbol, platform: t.platformId, address: t.tokenContractAddress,
        price: p?.tokenPrice ?? null, ref: p?.referencePrice ?? null, gapPct: gap(p?.tokenPrice, p?.referencePrice),
        priceUpdatedAt: p?.tokenPriceUpdatedAt ?? null,
        listPrice: t.tokenPrice, listRef: t.referencePrice, listGapPct: gap(t.tokenPrice, t.referencePrice),
        ratio: t.tokenToShareRatio, marketStatus: t.statusInfo?.marketStatus ?? null, reason: t.statusInfo?.reasonCode ?? null,
        reasonMsg: t.statusInfo?.reasonMsg ?? null, openState: t.statusInfo?.openState ?? null, volume24H: t.volume24H ?? null,
      };
    });
    append(`gap-${day()}.jsonl`, rows);
    const real = await logRealPrices(time, rows);
    append("runs.jsonl", [{ time, ok: true, tokens: tokens.length, priced: price.size, real, timings }]);
    console.log(`${time} saved ${rows.length} rows (${price.size} priced)`);
  } catch (e) {
    append("errors.jsonl", [{ time, error: String(e.message ?? e) }]);
    append("runs.jsonl", [{ time, ok: false }]);
    console.error(`${time} ERROR ${e.message ?? e}`);
  }
}

await run();
if (!process.argv.includes("--once")) {
  // Align to the next quarter hour, then every 15 min.
  setTimeout(() => { run(); setInterval(run, EVERY_MS); }, EVERY_MS - (Date.now() % EVERY_MS));
}
