// Price card: one stock, every issuer on BSC, in plain words.
import { ISSUER_NAME, isTradable, quotesFor, statusWords, wallStreetNow, type Quote } from "./rwa.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type Card = { text: string; quotes: Quote[]; best?: Quote; spreadPct?: number };

export async function priceCard(ticker: string): Promise<Card> {
  const quotes = await quotesFor(ticker);
  if (!quotes.length) {
    return { text: `I can't find <b>${esc(ticker.toUpperCase())}</b> as a tokenized stock on BNB Chain (bStocks or Ondo).`, quotes };
  }

  const open = quotes.filter(isTradable);
  const best = [...open].sort((a, b) => a.sharePrice - b.sharePrice)[0];
  const prices = open.map((q) => q.sharePrice);
  const spreadPct = prices.length > 1 ? (Math.max(...prices) / Math.min(...prices) - 1) * 100 : undefined;
  const ws = wallStreetNow();

  const lines = [
    `📈 <b>${esc(quotes[0].underlyingName)} (${esc(quotes[0].underlyingTicker)})</b>`,
    `Wall Street: ${ws.open ? "🟢" : "🔴"} ${ws.label}`,
    "",
  ];
  for (const q of quotes) {
    const ratio = Number(q.tokenToShareRatio);
    lines.push(
      `<b>${ISSUER_NAME[q.platformId] ?? q.platformId}</b> · ${esc(q.tokenSymbol)} · ${statusWords(q)}`,
      `   ${usd(q.sharePrice)} per share` + (Math.abs(ratio - 1) > 1e-6 ? ` (1 token = ${ratio.toFixed(4)} shares, ${usd(q.tokenPrice)})` : ""),
    );
  }
  lines.push("");
  if (best) {
    lines.push(`💡 Cheapest right now: <b>${ISSUER_NAME[best.platformId]}</b>` + (spreadPct !== undefined ? ` (${spreadPct.toFixed(2)}% cheaper)` : ""));
  } else {
    lines.push("⛔ No issuer is trading this stock right now.");
  }
  lines.push(`<i>On-chain prices on BNB Chain. Updated ${new Date(Math.max(...quotes.map((q) => q.priceUpdatedAt))).toISOString().slice(11, 16)} UTC.</i>`);

  return { text: lines.join("\n"), quotes, best, spreadPct };
}
