// Price card: one stock, every issuer on BSC, plus the real stock price, in plain words.
import { ISSUER_NAME, isTradable, quotesFor, statusWords, wallStreetNow, type Quote } from "./rwa.js";
import { realQuote, type RealQuote } from "./stocks.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const nyTime = (ms: number) =>
  new Date(ms).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " NY time";

export type Card = {
  text: string;
  quotes: Quote[];
  best?: Quote;
  spreadPct?: number;     // price difference between issuers (A)
  real?: RealQuote | null;
  gapPct?: number;        // cheapest on-chain share price vs real stock price (B)
};

export async function priceCard(ticker: string): Promise<Card> {
  const quotes = await quotesFor(ticker);
  if (!quotes.length) {
    return { text: `I can't find <b>${esc(ticker.toUpperCase())}</b> as a tokenized stock on BNB Chain (bStocks or Ondo).`, quotes };
  }

  // Real price is optional: if Finnhub fails, the card still works.
  let real: RealQuote | null = null;
  try {
    real = await realQuote(quotes[0].underlyingTicker);
  } catch (e) {
    console.error("finnhub error", e);
  }

  const open = quotes.filter(isTradable);
  const best = [...open].sort((a, b) => a.sharePrice - b.sharePrice)[0];
  const prices = open.map((q) => q.sharePrice);
  const spreadPct = prices.length > 1 ? (Math.max(...prices) / Math.min(...prices) - 1) * 100 : undefined;
  const gapPct = best && real ? (best.sharePrice / real.price - 1) * 100 : undefined;
  const ws = wallStreetNow();

  const lines = [
    `📈 <b>${esc(quotes[0].underlyingName)} (${esc(quotes[0].underlyingTicker)})</b>`,
    `Wall Street: ${ws.open ? "🟢" : "🔴"} ${ws.label}`,
  ];
  if (real) lines.push(`Real stock: <b>${usd(real.price)}</b> (last trade ${nyTime(real.at)})`);
  lines.push("");

  for (const q of quotes) {
    const ratio = Number(q.tokenToShareRatio);
    const vsReal = real ? `, ${signed((q.sharePrice / real.price - 1) * 100)} vs real` : "";
    lines.push(
      `<b>${ISSUER_NAME[q.platformId] ?? q.platformId}</b> · ${esc(q.tokenSymbol)} · ${statusWords(q)}`,
      `   ${usd(q.sharePrice)} per share${vsReal}` + (Math.abs(ratio - 1) > 1e-6 ? `\n   (1 token = ${ratio.toFixed(4)} shares = ${usd(q.tokenPrice)})` : ""),
    );
  }
  lines.push("");

  if (best) {
    lines.push(`💡 Cheapest now: <b>${ISSUER_NAME[best.platformId]}</b>` + (spreadPct !== undefined ? ` (${spreadPct.toFixed(2)}% cheaper than the other)` : ""));
    if (gapPct !== undefined) {
      const word = Math.abs(gapPct) < 0.05 ? "about the same as" : gapPct > 0 ? "above" : "below";
      lines.push(`🧭 On-chain is ${signed(gapPct)} ${word} the real stock` + (ws.open ? "." : " (Wall Street is closed, so this compares to the last trade)."));
    }
  } else {
    lines.push("⛔ No issuer is trading this stock right now.");
  }
  lines.push(`<i>On-chain prices: Binance Web3 RWA API, BNB Chain. Real price: Finnhub.</i>`);

  return { text: lines.join("\n"), quotes, best, spreadPct, real, gapPct };
}
