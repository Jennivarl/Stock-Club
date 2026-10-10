// RWA Data API helpers: token list (cached), fresh prices, market status in plain words.
import { signedGet } from "./binance.js";

export type RwaToken = {
  tokenContractAddress: string;
  platformId: "bstock" | "ondo";
  tokenSymbol: string;
  underlyingTicker: string;
  underlyingName: string;
  tokenToShareRatio: string;
  tokenLogoUrl?: string;   // Binance-hosted token logo (bnbstatic.com)
  marketCap?: string;      // looks company-level (NVDA ~ $5.5T), same value on each issuer's token
  volume24H?: string;      // looks like the stock's daily volume (NVDA ~ $36B), not on-chain only
  peRatioTTM?: string;     // the company's P/E (trailing 12 months)
  statusInfo?: { openState: boolean | null; marketStatus: string | null; reasonCode: string | null; reasonMsg: string | null; nextOpenTime: number | null };
};

export type Quote = RwaToken & {
  tokenPrice: number;   // USD per token, on-chain
  sharePrice: number;   // USD per 1 real share (API "referencePrice": token price / tokenToShareRatio)
  priceUpdatedAt: number;
};

const PLATFORMS = ["bstock", "ondo"] as const;
const LIST_TTL_MS = 60_000;
let cache: { at: number; tokens: RwaToken[] } | undefined;

export async function listTokens(): Promise<RwaToken[]> {
  if (cache && Date.now() - cache.at < LIST_TTL_MS) return cache.tokens;
  const tokens: RwaToken[] = [];
  for (const platformId of PLATFORMS) {
    const r = await signedGet("/api/v1/dex/market/rwa/tokens", { binanceChainId: "56", platformId });
    tokens.push(...r.data);
  }
  cache = { at: Date.now(), tokens };
  return tokens;
}

// All BSC tokens (bStocks + Ondo) for a ticker, with fresh prices.
export async function quotesFor(ticker: string): Promise<Quote[]> {
  const t = ticker.toUpperCase();
  const tokens = (await listTokens()).filter((x) => x.underlyingTicker?.toUpperCase() === t);
  if (!tokens.length) return [];
  // Docs say up to 100 addresses, but 90+ fails with HTTP 414. One ticker is at most a few tokens anyway.
  const r = await signedGet("/api/v1/dex/market/rwa/price", {
    binanceChainId: "56",
    tokenContractAddresses: tokens.map((x) => x.tokenContractAddress).join(","),
  });
  const byAddr = new Map<string, any>(r.data.map((p: any) => [p.tokenContractAddress.toLowerCase(), p]));
  return tokens.flatMap((tok) => {
    const p = byAddr.get(tok.tokenContractAddress.toLowerCase());
    if (!p) return [];
    return [{ ...tok, tokenPrice: Number(p.tokenPrice), sharePrice: Number(p.referencePrice), priceUpdatedAt: p.tokenPriceUpdatedAt }];
  });
}

export function isTradable(q: RwaToken): boolean {
  return q.statusInfo?.reasonCode === "TRADING";
}

const REASON_WORDS: Record<string, string> = {
  TRADING: "🟢 open",
  MARKET_CLOSED: "🔴 closed",
  MARKET_PAUSED: "⏸ paused",
  MARKET_MAINTENANCE: "🛠 maintenance",
  ASSET_PAUSED: "⏸ this token is paused",
  ASSET_LIMITED: "⚠️ limited",
  UNSUPPORTED: "❌ not supported",
};

export function statusWords(q: RwaToken): string {
  const code = q.statusInfo?.reasonCode;
  return (code && REASON_WORDS[code]) ?? `❔ unknown (${code ?? "no status"})`;
}

export const ISSUER_NAME: Record<string, string> = { bstock: "bStocks", ondo: "Ondo" };

// US stock market session from the clock (New York time). Ignores US holidays.
export function wallStreetNow(now = new Date()): { open: boolean; label: string } {
  const ny = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = ny.getDay();
  const mins = ny.getHours() * 60 + ny.getMinutes();
  if (day === 0 || day === 6) return { open: false, label: "closed (weekend)" };
  if (mins >= 570 && mins < 960) return { open: true, label: "open" };
  return { open: false, label: mins < 570 ? "closed (before open)" : "closed (after close)" };
}

// Prices for many tickers in ONE /rwa/price call (keeps us far under the 5 req/s limit). Up to ~25 tickers.
export async function quotesForMany(tickers: string[]): Promise<Map<string, Quote[]>> {
  const want = new Set(tickers.map((t) => t.toUpperCase()));
  const tokens = (await listTokens()).filter((x) => want.has(x.underlyingTicker?.toUpperCase()));
  const out = new Map<string, Quote[]>();
  for (let i = 0; i < tokens.length; i += 50) {
    const batch = tokens.slice(i, i + 50);
    const r = await signedGet("/api/v1/dex/market/rwa/price", { binanceChainId: "56", tokenContractAddresses: batch.map((x) => x.tokenContractAddress).join(",") });
    const byAddr = new Map<string, any>(r.data.map((p: any) => [p.tokenContractAddress.toLowerCase(), p]));
    for (const tok of batch) {
      const p = byAddr.get(tok.tokenContractAddress.toLowerCase());
      if (!p) continue;
      const t = tok.underlyingTicker.toUpperCase();
      out.set(t, [...(out.get(t) ?? []), { ...tok, tokenPrice: Number(p.tokenPrice), sharePrice: Number(p.referencePrice), priceUpdatedAt: p.tokenPriceUpdatedAt }]);
    }
  }
  return out;
}
