// Real US stock price from Finnhub (outside Binance), to compare with on-chain prices.
// Binance's RWA "referencePrice" is derived from the token price, so it can't be used for this.
import "dotenv/config";

export type RealQuote = { price: number; prevClose: number; at: number };

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; q: RealQuote | null }>();

export const hasRealPrices = () => Boolean(process.env.FINNHUB_API_KEY);

export async function realQuote(ticker: string): Promise<RealQuote | null> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) return null;
  const t = ticker.toUpperCase();
  const hit = cache.get(t);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.q;

  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(t)}`, {
    headers: { "X-Finnhub-Token": key },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  // c = last price, pc = previous close, t = unix seconds. Unknown symbols come back as all zeros.
  const q = Number(j.c) > 0 ? { price: Number(j.c), prevClose: Number(j.pc), at: Number(j.t) * 1000 } : null;
  cache.set(t, { at: Date.now(), q });
  return q;
}
