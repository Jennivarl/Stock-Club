// AI analyst: reads live market data for the club's stocks and decides BUY (one stock, one amount) or HOLD,
// with reasons. A BUY becomes a normal club vote (same rule + market checks as /propose); the AI never trades.
// Every call is scored 24 h later against the on-chain price, so the club can see the AI's track record.
import type { Api } from "grammy";
import { db, getMember, getRules, type Club, type Member } from "./db.js";
import { getOpenProposalForTicker, startProposal } from "./proposals.js";
import { candles, news, stockDetail } from "./tools.js";
import { rememberLogo, WATCH } from "./appapi.js";

db.exec(`
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  at TEXT NOT NULL DEFAULT (datetime('now')),
  action TEXT NOT NULL,                 -- buy | hold
  ticker TEXT,
  amount_usd REAL,
  confidence REAL,
  summary TEXT,
  reasons TEXT,                         -- JSON array
  price_at REAL,                        -- on-chain share price when the call was made
  proposal_id INTEGER,                  -- the vote it started (buy only)
  price_after REAL,                     -- on-chain share price 24 h later
  scored_at TEXT
);
CREATE TABLE IF NOT EXISTS ai_settings (
  club_id INTEGER PRIMARY KEY REFERENCES clubs(id),
  auto INTEGER NOT NULL DEFAULT 0,      -- 1 = the analyst runs by itself every AUTO_HOURS
  last_run TEXT
)`);

const MODEL = process.env.AI_MODEL ?? "gpt-5.4-mini";
const AUTO_HOURS = 6;
const COOLDOWN_MIN = 10;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

export const aiAvailable = () => Boolean(process.env.OPENAI_API_KEY);

function rsi14(closes: number[]): number | null {
  if (closes.length < 15) return null;
  let g = 0, l = 0;
  for (let i = closes.length - 14; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; d > 0 ? (g += d) : (l -= d); }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;

// What the AI sees for one stock. Everything is live data we already show in the app.
async function signals(ticker: string) {
  const d = await stockDetail(ticker, rememberLogo);
  if (!d || !d.tradable || !d.onchain) return null;
  const k = await candles(ticker, "1d").catch(() => []);
  const c = k.map((x) => x.c);
  const n = await news(ticker).catch(() => ({ news: [], earnings: null }));
  return {
    ticker, name: d.name, onchainPrice: r2(d.onchain), realPrice: r2(d.real?.price), gapPct: r2(d.gapPct), changeVsLastClosePct: r2(d.changePct),
    change7dPct: c.length > 7 ? r2((c.at(-1)! / c.at(-8)! - 1) * 100) : null,
    change30dPct: c.length > 30 ? r2((c.at(-1)! / c.at(-31)! - 1) * 100) : null,
    rsi14: r2(rsi14(c)), ma20: c.length >= 20 ? r2(avg(c.slice(-20))) : null, ma50: c.length >= 50 ? r2(avg(c.slice(-50))) : null,
    peTTM: d.stats?.pe ?? null, nextEarnings: n.earnings?.date ?? null,
    daysToEarnings: n.earnings?.date ? Math.ceil((Date.parse(n.earnings.date) - Date.now()) / 864e5) : null,
    headlines: n.news.slice(0, 4).map((x: any) => x.headline),
  };
}

type Decision = { action: "buy" | "hold"; ticker: string | null; amount_usd: number; confidence: number; summary: string; reasons: string[] };

async function ask(data: unknown[], maxUsd: number, maxGap: number): Promise<Decision> {
  const system = `You are the AI analyst of a small friends' investment club. The club trades tokenized US stocks on BNB Chain (on-chain tokens that follow real shares; they trade 24/7, so their price can drift from the real stock: the "gap").
Each time you're asked, decide ONE thing: BUY one stock from the list, or HOLD (no trade). Be careful and honest: HOLD is the right answer when nothing stands out. Never invent data; use only what you're given.
Club rules: at most $${maxUsd} per member per trade; trades are blocked when the gap is over ±${maxGap}%. Prefer small amounts. Avoid stocks with a big positive gap (paying above the real price) or daysToEarnings of 2 or less. RSI over 70 = stretched up, under 30 = stretched down.
Reply with JSON only: {"action":"buy"|"hold","ticker":string|null,"amount_usd":number,"confidence":number between 0 and 1,"summary":"one short sentence in plain words","reasons":["2-3 short, clean, plain-word reasons, each one complete sentence citing the numbers"]}`;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: `Today is ${new Date().toISOString().slice(0, 10)}. Live data:\n${JSON.stringify(data)}` }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j?.error?.message ?? `AI error ${r.status}`);
  const d = JSON.parse(j.choices[0].message.content);
  return {
    action: d.action === "buy" ? "buy" : "hold",
    ticker: typeof d.ticker === "string" ? d.ticker.toUpperCase() : null,
    amount_usd: Number(d.amount_usd) || 0,
    confidence: Math.max(0, Math.min(1, Number(d.confidence) || 0)),
    summary: String(d.summary ?? "").slice(0, 300),
    reasons: (Array.isArray(d.reasons) ? d.reasons : []).map(String).slice(0, 3).map((x: string) => x.slice(0, 200)),
  };
}

// "6 of 9 buy calls were up 24 h later · avg +0.8% · paper P&L +$0.31"
export function trackRecord(clubId: number): string {
  const rows = db.prepare("SELECT amount_usd, price_at, price_after FROM ai_calls WHERE club_id = ? AND action = 'buy' AND scored_at IS NOT NULL").all(clubId) as { amount_usd: number; price_at: number; price_after: number }[];
  const pending = (db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE club_id = ? AND action = 'buy' AND scored_at IS NULL").get(clubId) as { n: number }).n;
  if (!rows.length) return pending ? `Track record: ${pending} buy call${pending > 1 ? "s" : ""} waiting to be scored (24 h after each call).` : "Track record: no calls scored yet (each buy call is scored 24 h later).";
  const rets = rows.map((x) => x.price_after / x.price_at - 1);
  const up = rets.filter((x) => x > 0).length, pnl = rows.reduce((s, x, i) => s + x.amount_usd * rets[i], 0);
  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  return `Track record: ${up} of ${rows.length} buy calls were up 24 h later · avg ${pct(avg(rets))} · paper P&L ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}` + (pending ? ` · ${pending} waiting` : "");
}

const running = new Set<number>();
// Runs the analyst for a club and posts the result in the group. `member` is who asked (or the club creator for auto runs);
// a BUY is proposed in their name for the club's per-member limits, but the message says it's the AI's call.
export async function runAnalyst(api: Api, club: Club, member: Member, opts: { auto?: boolean } = {}): Promise<string | null> {
  if (!aiAvailable()) return "The AI analyst isn't set up on this server.";
  const set = db.prepare("SELECT * FROM ai_settings WHERE club_id = ?").get(club.id) as { last_run: string | null } | undefined;
  if (!opts.auto && set?.last_run && Date.now() - Date.parse(set.last_run + "Z") < COOLDOWN_MIN * 60_000) return `The AI analyst ran less than ${COOLDOWN_MIN} minutes ago. Try again in a bit.`;
  if (running.has(club.id)) return "The AI analyst is already thinking for this club.";
  running.add(club.id);
  db.prepare("INSERT INTO ai_settings (club_id, last_run) VALUES (?, datetime('now')) ON CONFLICT(club_id) DO UPDATE SET last_run = datetime('now')").run(club.id);
  try {
    const rules = getRules(club.id);
    const allowed = rules.allowed_tickers?.split(",") ?? null;
    const list = (allowed ?? WATCH).filter((t) => !getOpenProposalForTicker(club.id, t));
    await api.sendMessage(club.telegram_chat_id, `🤖 <b>AI analyst</b> is reading live prices, gaps, charts and news for ${list.length} stocks…`, { parse_mode: "HTML" });
    const data = [];
    for (const t of list) { const s = await signals(t).catch(() => null); if (s) data.push(s); }
    if (!data.length) { await api.sendMessage(club.telegram_chat_id, "🤖 Nothing on the club's list is trading on-chain right now, so no call."); return null; }
    const maxUsd = Math.min(rules.max_per_trade, 1000);
    const d = await ask(data, maxUsd, rules.max_gap_percent);
    const pick = d.action === "buy" ? data.find((x) => x.ticker === d.ticker) : undefined;
    const amount = Math.max(1, Math.min(maxUsd, Math.round(d.amount_usd) || 1));
    const reasons = d.reasons.map((x) => `• ${esc(x)}`).join("\n");
    const conf = `${Math.round(d.confidence * 100)}% sure`;
    if (!pick) {
      db.prepare("INSERT INTO ai_calls (club_id, action, confidence, summary, reasons) VALUES (?, 'hold', ?, ?, ?)").run(club.id, d.confidence, d.summary, JSON.stringify(d.reasons));
      await api.sendMessage(club.telegram_chat_id, `🤖 <b>AI analyst: hold, no trade right now</b> (${conf})\n${esc(d.summary)}\n${reasons}\n\n<i>${esc(trackRecord(club.id))}</i>`, { parse_mode: "HTML" });
      return null;
    }
    const note = `<b>Why</b> (${conf}): ${esc(d.summary)}\n${reasons}\n<i>The AI only proposes. Your club votes, and the usual rules still apply.</i>`;
    const err = await startProposal(api, club, member, pick.ticker, amount, "buy", { name: "🤖 <b>AI analyst</b>", note });
    if (err) {
      await api.sendMessage(club.telegram_chat_id, `🤖 The AI analyst wanted to buy $${amount} of ${esc(pick.ticker)}, but the club's checks said no:\n${err}`, { parse_mode: "HTML" });
      return null;
    }
    const prop = getOpenProposalForTicker(club.id, pick.ticker);
    db.prepare("INSERT INTO ai_calls (club_id, action, ticker, amount_usd, confidence, summary, reasons, price_at, proposal_id) VALUES (?, 'buy', ?, ?, ?, ?, ?, ?, ?)")
      .run(club.id, pick.ticker, amount, d.confidence, d.summary, JSON.stringify(d.reasons), pick.onchainPrice, prop?.id ?? null);
    return null;
  } catch (e: any) {
    console.error("analyst", e);
    await api.sendMessage(club.telegram_chat_id, "🤖 The AI analyst couldn't finish this time. Try again in a few minutes.").catch(() => {});
    return null;
  } finally {
    running.delete(club.id);
  }
}

export function setAuto(clubId: number, on: boolean) {
  db.prepare("INSERT INTO ai_settings (club_id, auto) VALUES (?, ?) ON CONFLICT(club_id) DO UPDATE SET auto = excluded.auto").run(clubId, on ? 1 : 0);
}
export const isAuto = (clubId: number) => Boolean((db.prepare("SELECT auto FROM ai_settings WHERE club_id = ?").get(clubId) as { auto: number } | undefined)?.auto);

// Every few minutes: score buy calls that are 24 h old, and run clubs that turned on auto mode.
export async function analystTick(api: Api) {
  const due = db.prepare("SELECT id, ticker FROM ai_calls WHERE action = 'buy' AND scored_at IS NULL AND at <= datetime('now', '-24 hours')").all() as { id: number; ticker: string }[];
  for (const c of due) {
    const d = await stockDetail(c.ticker, rememberLogo).catch(() => null);
    if (d?.onchain) db.prepare("UPDATE ai_calls SET price_after = ?, scored_at = datetime('now') WHERE id = ?").run(d.onchain, c.id);
  }
  if (!aiAvailable()) return;
  const clubs = db.prepare(`SELECT c.* FROM clubs c JOIN ai_settings s ON s.club_id = c.id
    WHERE s.auto = 1 AND (s.last_run IS NULL OR s.last_run <= datetime('now', '-${AUTO_HOURS} hours'))`).all() as Club[];
  for (const club of clubs) {
    const m = getMember(club.id, club.created_by);
    if (m) await runAnalyst(api, club, m, { auto: true });
  }
}

// Dry run for testing: the AI's decision on live data, without posting or proposing anything.
export async function dryRun(tickers: string[] = WATCH, maxUsd = 20, maxGap = 2) {
  const data = [];
  for (const t of tickers) { const s = await signals(t).catch(() => null); if (s) data.push(s); }
  return { stocks: data.map((d) => d.ticker), decision: data.length ? await ask(data, maxUsd, maxGap) : null };
}
