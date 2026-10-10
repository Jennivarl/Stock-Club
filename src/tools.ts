// Trader tools for the Mini App: on-chain candles, news + earnings, price impact ("depth"), the full stock list.
import { signedGet } from "./binance.js";
import { isTradable, ISSUER_NAME, listTokens, quotesForMany } from "./rwa.js";
import { realQuote } from "./stocks.js";
import { USDT } from "./trading.js";

const memo = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const c = memo.get(key);
  if (c && Date.now() - c.at < ms) return c.v as T;
  const v = await fn();
  memo.set(key, { at: Date.now(), v });
  return v;
}

// The stock's main token: bStocks if listed, else Ondo.
async function mainToken(ticker: string) {
  const toks = (await listTokens()).filter((t) => t.underlyingTicker?.toUpperCase() === ticker);
  return toks.find((t) => t.platformId === "bstock") ?? toks[0];
}

// On-chain candles from Binance's RWA kline endpoint (found Oct 10; bars 5m..1d, max 100 per call).
// For 1d we page back with endTime to the token's launch (NVDAB: Jun 12 2026).
// Rows: [openTime, o, h, l, c, vol|null, closeTime].
export async function candles(ticker: string, bar: "1h" | "4h" | "1d") {
  return cached(`k:${ticker}:${bar}`, 60_000, async () => {
    const tok = await mainToken(ticker);
    if (!tok) return [];
    const rows: any[] = [];
    let endTime: string | undefined;
    for (let page = 0; page < (bar === "1d" ? 3 : 1); page++) {
      const r: any = await signedGet("/api/v1/dex/market/rwa/kline", {
        binanceChainId: "56", tokenContractAddress: tok.tokenContractAddress, bar, limit: "100", ...(endTime ? { endTime } : {}),
      });
      const d: any[] = r.data ?? [];
      if (!d.length) break;
      rows.unshift(...d);
      if (d.length < 100) break;
      endTime = String(Number(d[0][0]) - 1);
    }
    const ratio = Number(tok.tokenToShareRatio) || 1; // per real share, like everywhere else in the app
    const seen = new Set<number>();
    return rows
      .filter((r) => !seen.has(+r[0]) && seen.add(+r[0]))
      .sort((a, b) => a[0] - b[0])
      .map((r) => ({ t: Math.floor(+r[0] / 1000), o: +r[1] / ratio, h: +r[2] / ratio, l: +r[3] / ratio, c: +r[4] / ratio }));
  });
}

const FINN = (p: string) =>
  fetch(`https://finnhub.io/api/v1${p}${p.includes("?") ? "&" : "?"}token=${process.env.FINNHUB_API_KEY}`, { signal: AbortSignal.timeout(10_000) })
    .then((r) => (r.ok ? r.json() : null));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Company news (last 7 days) + next earnings date. Finnhub free plan (checked Oct 10: both work; stock candles are 403).
export async function news(ticker: string) {
  return cached(`n:${ticker}`, 20 * 60_000, async () => {
    const [items, cal]: any[] = await Promise.all([
      FINN(`/company-news?symbol=${ticker}&from=${day(Date.now() - 7 * 864e5)}&to=${day(Date.now())}`).catch(() => null),
      FINN(`/calendar/earnings?symbol=${ticker}&from=${day(Date.now())}&to=${day(Date.now() + 150 * 864e5)}`).catch(() => null),
    ]);
    const next = (cal?.earningsCalendar ?? [])
      .filter((e: any) => e.date >= day(Date.now()))
      .sort((a: any, b: any) => a.date.localeCompare(b.date))[0];
    return {
      news: (Array.isArray(items) ? items : []).filter((n: any) => n.headline && n.url).slice(0, 8)
        .map((n: any) => ({ headline: n.headline, source: n.source, url: n.url, at: n.datetime * 1000, image: n.image || null })),
      earnings: next ? { date: next.date, hour: next.hour, epsEstimate: next.epsEstimate, quarter: next.quarter, year: next.year } : null,
    };
  });
}

// "Depth" for pool-traded tokens: what a $100 / $1k / $10k buy really gets, from Binance Trading API quotes.
// avgPrice is computed from the quoted amount; impactPct is the API's own priceImpactPercent.
export async function impact(ticker: string) {
  return cached(`i:${ticker}`, 5 * 60_000, async () => {
    const tok = await mainToken(ticker);
    if (!tok) return [];
    const ratio = Number(tok.tokenToShareRatio) || 1;
    const out = [];
    for (const usd of [100, 1000, 10000]) {
      try {
        const q: any = await signedGet("/api/v1/dex/aggregator/quote", {
          binanceChainId: "56", amount: (BigInt(usd) * 10n ** 18n).toString(), fromTokenAddress: USDT, toTokenAddress: tok.tokenContractAddress,
        });
        const x = (q.data ?? []).find((d: any) => d.executionMode === "SWAP") ?? (q.data ?? [])[0];
        const qty = Number(x?.toTokenAmount ?? 0) / 1e18;
        out.push({ usd, qty, avgPrice: qty ? usd / qty / ratio : null, impactPct: x?.priceImpactPercent != null ? Number(x.priceImpactPercent) : null, route: x?.vendorName ?? null });
      } catch (e: any) {
        out.push({ usd, error: String(e.message ?? e).slice(0, 80) });
      }
    }
    return out;
  });
}

// Every tokenized stock Binance lists on BNB Chain (bStocks + Ondo), one row per company, with on-chain price.
export async function universe(logo: (url?: string) => string | null) {
  return cached("u", 60_000, async () => {
    const tickers = [...new Set((await listTokens()).map((t) => t.underlyingTicker?.toUpperCase()).filter(Boolean))] as string[];
    const quotes = new Map<string, any[]>();
    for (let i = 0; i < tickers.length; i += 20) for (const [k, v] of await quotesForMany(tickers.slice(i, i + 20))) quotes.set(k, v);
    return tickers
      .map((t) => {
        const qs = quotes.get(t) ?? [], tradable = qs.filter(isTradable);
        const best = [...tradable].sort((a, b) => a.sharePrice - b.sharePrice)[0] ?? qs[0];
        const bs = qs.find((q) => q.platformId === "bstock");
        return {
          ticker: t, name: qs[0]?.underlyingName ?? t, onchain: best?.sharePrice ?? null, tradable: tradable.length > 0,
          logo: logo(bs?.tokenLogoUrl ?? qs.find((q) => q.tokenLogoUrl)?.tokenLogoUrl), issuers: qs.map((q) => ISSUER_NAME[q.platformId]),
        };
      })
      .filter((s) => s.onchain)
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  });
}

// One stock's card for ANY listed ticker (not just the 15 we record): live on-chain + real price.
export async function stockDetail(ticker: string, logo: (url?: string) => string | null) {
  return cached(`d:${ticker}`, 30_000, async () => {
    const qs = (await quotesForMany([ticker])).get(ticker) ?? [];
    if (!qs.length) return null;
    const tradable = qs.filter(isTradable), best = [...tradable].sort((a, b) => a.sharePrice - b.sharePrice)[0];
    const bs = qs.find((q) => q.platformId === "bstock"), real = await realQuote(ticker).catch(() => null);
    const one = (k: "volume24H" | "marketCap" | "peRatioTTM") => Number(bs?.[k] ?? qs.find((q) => q[k])?.[k]) || null;
    return {
      ticker, name: qs[0].underlyingName, logo: logo(bs?.tokenLogoUrl ?? qs.find((q) => q.tokenLogoUrl)?.tokenLogoUrl),
      onchain: best?.sharePrice ?? qs[0].sharePrice, bestIssuer: best ? ISSUER_NAME[best.platformId] : null, tradable: tradable.length > 0,
      issuers: qs.map((q) => ({ name: ISSUER_NAME[q.platformId], symbol: q.tokenSymbol, price: q.sharePrice, open: isTradable(q), logo: logo(q.tokenLogoUrl) })),
      real: real ? { price: real.price, prevClose: real.prevClose, at: real.at } : null,
      gapPct: best && real ? (best.sharePrice / real.price - 1) * 100 : null,
      changePct: best && real?.prevClose ? (best.sharePrice / real.prevClose - 1) * 100 : null,
      stats: { pe: one("peRatioTTM"), volume24h: one("volume24H"), marketCap: one("marketCap") },
    };
  });
}
