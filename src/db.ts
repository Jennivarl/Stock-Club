import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

fs.mkdirSync("data", { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH ?? "data/stock-club.db");

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY,
  telegram_chat_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by INTEGER NOT NULL,          -- telegram user id
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rules (
  club_id INTEGER PRIMARY KEY REFERENCES clubs(id),
  max_per_trade REAL NOT NULL DEFAULT 20,     -- USD per member per trade
  max_per_week REAL NOT NULL DEFAULT 50,      -- USD per member per week
  vote_pass_percent INTEGER NOT NULL DEFAULT 60,
  vote_hours REAL NOT NULL DEFAULT 2,
  max_spread_percent REAL NOT NULL DEFAULT 2, -- max price difference between issuers we accept
  max_gap_percent REAL NOT NULL DEFAULT 2,    -- max on-chain vs real stock price difference
  allowed_tickers TEXT,                       -- comma list, NULL = any
  paused INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  telegram_user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  wallet_address TEXT,
  autopilot_on INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (club_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL REFERENCES clubs(id),
  proposer_id INTEGER NOT NULL REFERENCES members(id),
  ticker TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open | passed | failed | refused | cancelled
  platform TEXT,                         -- issuer picked when the vote closed
  token_address TEXT,
  poll_id TEXT UNIQUE,
  poll_message_id INTEGER,
  note TEXT,                             -- why it failed / was refused
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closes_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  yes INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (proposal_id, member_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  mode TEXT NOT NULL,                    -- tap | autopilot
  amount_usd REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | submitted | filled | failed | skipped
  tx_hash TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Small migrations for databases made by older versions.
const ruleCols = (db.prepare("PRAGMA table_info(rules)").all() as { name: string }[]).map((c) => c.name);
if (!ruleCols.includes("max_gap_percent")) db.exec("ALTER TABLE rules ADD COLUMN max_gap_percent REAL NOT NULL DEFAULT 2");
const orderCols = (db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).map((c) => c.name);
// Agentic Wallet swaps can return an orderId that its own order list doesn't know, so keep both.
if (!orderCols.includes("returned_order_id")) db.exec("ALTER TABLE orders ADD COLUMN returned_order_id TEXT");
if (!orderCols.includes("real_order_id")) db.exec("ALTER TABLE orders ADD COLUMN real_order_id TEXT");
if (!orderCols.includes("qty")) db.exec("ALTER TABLE orders ADD COLUMN qty TEXT");
// Secret in the Buy-page link for "tap to buy" orders.
if (!orderCols.includes("tap_token")) db.exec("ALTER TABLE orders ADD COLUMN tap_token TEXT");
if (!orderCols.includes("wallet_address")) db.exec("ALTER TABLE orders ADD COLUMN wallet_address TEXT");

export type Club = { id: number; telegram_chat_id: number; name: string; created_by: number };
export type Rules = {
  club_id: number; max_per_trade: number; max_per_week: number; vote_pass_percent: number;
  vote_hours: number; max_spread_percent: number; max_gap_percent: number; allowed_tickers: string | null; paused: number;
};
export type Member = {
  id: number; club_id: number; telegram_user_id: number; name: string; wallet_address: string | null; autopilot_on: number;
};

export function getClub(chatId: number): Club | undefined {
  return db.prepare("SELECT * FROM clubs WHERE telegram_chat_id = ?").get(chatId) as Club | undefined;
}

export function createClub(chatId: number, name: string, userId: number, userName: string): Club {
  db.prepare("INSERT INTO clubs (telegram_chat_id, name, created_by) VALUES (?, ?, ?)").run(chatId, name, userId);
  const club = getClub(chatId)!;
  db.prepare("INSERT INTO rules (club_id) VALUES (?)").run(club.id);
  addMember(club.id, userId, userName);
  return club;
}

export function addMember(clubId: number, userId: number, name: string): boolean {
  const r = db.prepare("INSERT OR IGNORE INTO members (club_id, telegram_user_id, name) VALUES (?, ?, ?)").run(clubId, userId, name);
  return r.changes > 0;
}

export function getMembers(clubId: number): Member[] {
  return db.prepare("SELECT * FROM members WHERE club_id = ? ORDER BY joined_at").all(clubId) as Member[];
}

export function getRules(clubId: number): Rules {
  return db.prepare("SELECT * FROM rules WHERE club_id = ?").get(clubId) as Rules;
}

// Only these columns can be changed from chat. Maps chat names -> DB columns.
export const RULE_KEYS: Record<string, keyof Rules> = {
  max_trade: "max_per_trade",
  max_week: "max_per_week",
  pass: "vote_pass_percent",
  hours: "vote_hours",
  max_spread: "max_spread_percent",
  max_gap: "max_gap_percent",
  allowed: "allowed_tickers",
};

export function setRule(clubId: number, column: keyof Rules, value: number | string | null) {
  if (!Object.values(RULE_KEYS).includes(column)) throw new Error("unknown rule");
  db.prepare(`UPDATE rules SET ${column} = ? WHERE club_id = ?`).run(value, clubId);
}

export type Proposal = {
  id: number; club_id: number; proposer_id: number; ticker: string; amount_usd: number; status: string;
  platform: string | null; token_address: string | null; poll_id: string | null; poll_message_id: number | null;
  note: string | null; created_at: string; closes_at: string;
};

export function getMember(clubId: number, userId: number): Member | undefined {
  return db.prepare("SELECT * FROM members WHERE club_id = ? AND telegram_user_id = ?").get(clubId, userId) as Member | undefined;
}

export function setPaused(clubId: number, paused: boolean) {
  db.prepare("UPDATE rules SET paused = ? WHERE club_id = ?").run(paused ? 1 : 0, clubId);
}

// USD a member has bought (or is buying) in the last 7 days.
export function spentThisWeek(memberId: number): number {
  const r = db.prepare(
    "SELECT COALESCE(SUM(amount_usd), 0) AS s FROM orders WHERE member_id = ? AND status IN ('pending','submitted','filled') AND created_at >= datetime('now', '-7 days')",
  ).get(memberId) as { s: number };
  return r.s;
}

// Autopilot is per Telegram user (one Agentic Wallet each), so it's switched on in every club they're in.
export function setAutopilot(telegramUserId: number, on: boolean) {
  db.prepare("UPDATE members SET autopilot_on = ? WHERE telegram_user_id = ?").run(on ? 1 : 0, telegramUserId);
}

export function clubsOf(telegramUserId: number): Club[] {
  return db.prepare("SELECT c.* FROM clubs c JOIN members m ON m.club_id = c.id WHERE m.telegram_user_id = ?").all(telegramUserId) as Club[];
}

export function createOrder(proposalId: number, memberId: number, mode: "tap" | "autopilot", amount: number): number {
  const r = db.prepare("INSERT INTO orders (proposal_id, member_id, mode, amount_usd) VALUES (?, ?, ?, ?)").run(proposalId, memberId, mode, amount);
  return Number(r.lastInsertRowid);
}

export type TapOrder = {
  id: number; proposal_id: number; member_id: number; amount_usd: number; status: string; tx_hash: string | null;
  tap_token: string; wallet_address: string | null; ticker: string; token_address: string; platform: string;
  member_name: string; telegram_user_id: number; telegram_chat_id: number; created_at: string;
};

export function createTapOrder(proposalId: number, memberId: number, amount: number, token: string): number {
  const r = db.prepare("INSERT INTO orders (proposal_id, member_id, mode, amount_usd, tap_token) VALUES (?, ?, 'tap', ?, ?)")
    .run(proposalId, memberId, amount, token);
  return Number(r.lastInsertRowid);
}

export function getTapOrder(token: string): TapOrder | undefined {
  return db.prepare(`
    SELECT o.*, p.ticker, p.token_address, p.platform, m.name AS member_name, m.telegram_user_id, c.telegram_chat_id
    FROM orders o JOIN proposals p ON p.id = o.proposal_id JOIN members m ON m.id = o.member_id JOIN clubs c ON c.id = p.club_id
    WHERE o.tap_token = ? AND o.mode = 'tap'`).get(token) as TapOrder | undefined;
}

export function updateTapOrder(id: number, f: { status: string; txHash?: string; wallet?: string; qty?: string; error?: string }) {
  db.prepare("UPDATE orders SET status = ?, tx_hash = COALESCE(?, tx_hash), wallet_address = COALESCE(?, wallet_address), qty = COALESCE(?, qty), error = ? WHERE id = ?")
    .run(f.status, f.txHash ?? null, f.wallet ?? null, f.qty ?? null, f.error ?? null, id);
}

// Unused Buy links stop reserving the member's weekly budget after 2 hours.
export function expireOldTapOrders() {
  db.prepare("UPDATE orders SET status = 'expired' WHERE mode = 'tap' AND status = 'pending' AND created_at < datetime('now', '-2 hours')").run();
}

export function finishOrder(
  orderId: number,
  f: { status: string; txHash?: string; error?: string; returnedOrderId?: string; realOrderId?: string; qty?: string },
) {
  db.prepare(
    "UPDATE orders SET status = ?, tx_hash = ?, error = ?, returned_order_id = ?, real_order_id = ?, qty = ? WHERE id = ?",
  ).run(f.status, f.txHash ?? null, f.error ?? null, f.returnedOrderId ?? null, f.realOrderId ?? null, f.qty ?? null, orderId);
}
