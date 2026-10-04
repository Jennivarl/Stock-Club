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
`);

export type Club = { id: number; telegram_chat_id: number; name: string; created_by: number };
export type Rules = {
  club_id: number; max_per_trade: number; max_per_week: number; vote_pass_percent: number;
  vote_hours: number; max_spread_percent: number; allowed_tickers: string | null; paused: number;
};
export type Member = { id: number; club_id: number; telegram_user_id: number; name: string; wallet_address: string | null };

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
  allowed: "allowed_tickers",
};

export function setRule(clubId: number, column: keyof Rules, value: number | string | null) {
  if (!Object.values(RULE_KEYS).includes(column)) throw new Error("unknown rule");
  db.prepare(`UPDATE rules SET ${column} = ? WHERE club_id = ?`).run(value, clubId);
}
