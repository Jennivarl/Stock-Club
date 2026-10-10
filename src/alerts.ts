// Club alerts: "tell us when NVDA's gap goes over 1%", "...when TSLA goes above $400".
// Checked every 2 minutes; when one triggers, the bot posts in the club's group (once) with a chart button.
import type { Api } from "grammy";
import { db } from "./db.js";
import { appLink } from "./proposals.js";
import { stockDetail } from "./tools.js";
import { rememberLogo } from "./appapi.js";

db.exec(`
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  created_by INTEGER NOT NULL,          -- telegram user id
  creator_name TEXT,
  ticker TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- gap | above | below
  value REAL NOT NULL,                  -- gap: percent; above/below: USD per share
  active INTEGER NOT NULL DEFAULT 1,
  fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

export type Alert = { id: number; club_id: number; created_by: number; creator_name: string | null; ticker: string; kind: "gap" | "above" | "below"; value: number; active: number };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function describe(a: Pick<Alert, "ticker" | "kind" | "value">) {
  return a.kind === "gap" ? `${a.ticker} gap over ±${a.value}%` : `${a.ticker} ${a.kind} $${a.value}`;
}

// Returns an error in plain words, or the new alert.
export async function addAlert(clubId: number, userId: number, name: string, ticker: string, kind: string, value: number): Promise<string | Alert> {
  if (!["gap", "above", "below"].includes(kind)) return "Kind must be gap, above or below.";
  if (!Number.isFinite(value) || value <= 0) return "Give a number, like 1 (for 1%) or 240 (for $240).";
  if (kind === "gap" && value > 50) return "Gap is in percent, like 1 or 2.5.";
  const d = await stockDetail(ticker, rememberLogo);
  if (!d) return `${ticker} isn't a tokenized stock on BNB Chain that I can find.`;
  if (kind === "gap" && !d.real) return `I don't have a real price for ${ticker}, so I can't watch its gap. Try a price alert.`;
  const n = (db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE club_id = ? AND active = 1").get(clubId) as { n: number }).n;
  if (n >= 20) return "This club already has 20 active alerts. Remove one with /alert off <id>.";
  const r = db.prepare("INSERT INTO alerts (club_id, created_by, creator_name, ticker, kind, value) VALUES (?, ?, ?, ?, ?, ?)").run(clubId, userId, name, ticker, kind, value);
  return db.prepare("SELECT * FROM alerts WHERE id = ?").get(r.lastInsertRowid) as Alert;
}

export const activeAlerts = (clubId: number) =>
  db.prepare("SELECT * FROM alerts WHERE club_id = ? AND active = 1 ORDER BY id").all(clubId) as Alert[];

export const removeAlert = (clubId: number, id: number) =>
  db.prepare("UPDATE alerts SET active = 0 WHERE club_id = ? AND id = ? AND active = 1").run(clubId, id).changes > 0;

let running = false;
export async function checkAlerts(api: Api) {
  if (running) return;
  running = true;
  try {
    const all = db.prepare("SELECT a.*, c.telegram_chat_id FROM alerts a JOIN clubs c ON c.id = a.club_id WHERE a.active = 1").all() as (Alert & { telegram_chat_id: number })[];
    for (const a of all) {
      const d = await stockDetail(a.ticker, rememberLogo).catch(() => null);
      if (!d) continue;
      const hit = a.kind === "gap" ? d.gapPct != null && Math.abs(d.gapPct) >= a.value
        : a.kind === "above" ? d.onchain >= a.value : d.onchain <= a.value;
      if (!hit) continue;
      db.prepare("UPDATE alerts SET active = 0, fired_at = datetime('now') WHERE id = ?").run(a.id);
      const gapLine = d.gapPct != null ? `\nOn-chain $${d.onchain.toFixed(2)} vs real $${d.real!.price.toFixed(2)}: gap <b>${d.gapPct >= 0 ? "+" : ""}${d.gapPct.toFixed(2)}%</b>` : `\nOn-chain price: <b>$${d.onchain.toFixed(2)}</b>`;
      const text = `🔔 <b>Alert: ${esc(describe(a))}</b>${gapLine}\n\nSet by ${esc(a.creator_name ?? "a member")}. Want to act? <code>/propose ${a.ticker} 10</code>`;
      await api.sendMessage(a.telegram_chat_id, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: `View ${a.ticker} chart`, url: await appLink(api, a.ticker) }]] },
      }).catch((e) => console.error("alert send", e.message));
      console.log("alert fired", a.id, describe(a));
    }
  } finally {
    running = false;
  }
}
