// Propose -> vote -> pass/fail. Every check gives a plain-words reason when it says no.
import crypto from "node:crypto";
import type { Api } from "grammy";
import { createOrder, createTapOrder, db, finishOrder, getMembers, getRules, spentThisWeek, type Club, type Member, type Proposal, type Rules } from "./db.js";
import { priceCard, type Card } from "./card.js";
import { ISSUER_NAME, type Quote } from "./rwa.js";
import { autopilotAvailable, buy } from "./autopilot.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Quorum: at least half the club must vote, so 1 person can't decide for 5.
const QUORUM = 0.5;

// Rule checks that don't need prices. Returns a refusal reason, or null if OK.
export function checkRules(rules: Rules, ticker: string, amount: number, proposer: Member): string | null {
  if (rules.paused) return "⛔ The club is paused (someone used /stop). Use /resume first.";
  if (!Number.isFinite(amount) || amount <= 0) return "Amount must be a number of dollars, like <code>/propose NVDA 20</code>.";
  if (amount > rules.max_per_trade) {
    return `⛔ $${amount} is over the club's limit of <b>$${rules.max_per_trade} per trade</b>. Try a smaller amount.`;
  }
  const allowed = rules.allowed_tickers?.split(",") ?? null;
  if (allowed && !allowed.includes(ticker)) {
    return `⛔ ${esc(ticker)} isn't on the club's allowed list (${esc(allowed.join(", "))}).`;
  }
  const left = rules.max_per_week - spentThisWeek(proposer.id);
  if (amount > left) {
    return `⛔ That would put you over the club's <b>$${rules.max_per_week} per week</b> limit. You have $${Math.max(0, left).toFixed(2)} left this week.`;
  }
  return null;
}

// Market checks on a fresh price card. Returns a refusal reason, or null if OK.
export function checkMarket(card: Card, rules: Rules): string | null {
  if (!card.quotes.length) return card.text;
  if (!card.best) {
    const why = card.quotes.map((q) => `${ISSUER_NAME[q.platformId]}: ${q.statusInfo?.reasonMsg ?? q.statusInfo?.reasonCode ?? "no status"}`).join("; ");
    return `⛔ Nobody is trading ${esc(card.quotes[0].underlyingTicker)} right now (${esc(why)}).`;
  }
  if (card.gapPct !== undefined && Math.abs(card.gapPct) > rules.max_gap_percent) {
    const dir = card.gapPct > 0 ? "above" : "below";
    return `⛔ The on-chain price is <b>${card.gapPct.toFixed(2)}% ${dir}</b> the real stock. The club's limit is ${rules.max_gap_percent}%. Too risky right now.`;
  }
  if (card.spreadPct !== undefined && card.spreadPct > rules.max_spread_percent) {
    return `⛔ bStocks and Ondo prices are <b>${card.spreadPct.toFixed(2)}% apart</b> (limit ${rules.max_spread_percent}%). Something looks off, so I'm not buying.`;
  }
  return null;
}

export function getOpenProposalForTicker(clubId: number, ticker: string): Proposal | undefined {
  return db.prepare("SELECT * FROM proposals WHERE club_id = ? AND ticker = ? AND status = 'open'").get(clubId, ticker) as Proposal | undefined;
}

export function createProposal(clubId: number, proposerId: number, ticker: string, amount: number, hours: number): Proposal {
  const closes = new Date(Date.now() + hours * 3600_000).toISOString();
  const r = db.prepare("INSERT INTO proposals (club_id, proposer_id, ticker, amount_usd, closes_at) VALUES (?, ?, ?, ?, ?)")
    .run(clubId, proposerId, ticker, amount, closes);
  return db.prepare("SELECT * FROM proposals WHERE id = ?").get(r.lastInsertRowid) as Proposal;
}

export function attachPoll(proposalId: number, pollId: string, messageId: number) {
  db.prepare("UPDATE proposals SET poll_id = ?, poll_message_id = ? WHERE id = ?").run(pollId, messageId, proposalId);
}

// Records a vote. Returns the proposal if the voter is a member of its club, else undefined.
export function recordVote(pollId: string, telegramUserId: number, optionIds: number[]): Proposal | undefined {
  const p = db.prepare("SELECT * FROM proposals WHERE poll_id = ? AND status = 'open'").get(pollId) as Proposal | undefined;
  if (!p) return undefined;
  const m = db.prepare("SELECT * FROM members WHERE club_id = ? AND telegram_user_id = ?").get(p.club_id, telegramUserId) as Member | undefined;
  if (!m) return undefined; // non-members can tap the poll, but it doesn't count
  if (!optionIds.length) {
    db.prepare("DELETE FROM votes WHERE proposal_id = ? AND member_id = ?").run(p.id, m.id); // vote retracted
  } else {
    db.prepare("INSERT INTO votes (proposal_id, member_id, yes) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET yes = excluded.yes, at = datetime('now')")
      .run(p.id, m.id, optionIds[0] === 0 ? 1 : 0);
  }
  return p;
}

type Tally = { members: number; yes: Member[]; no: number; voted: number };

export function tally(p: Proposal): Tally {
  const members = getMembers(p.club_id).length;
  const yes = db.prepare("SELECT m.* FROM votes v JOIN members m ON m.id = v.member_id WHERE v.proposal_id = ? AND v.yes = 1").all(p.id) as Member[];
  const no = (db.prepare("SELECT COUNT(*) AS n FROM votes WHERE proposal_id = ? AND yes = 0").get(p.id) as { n: number }).n;
  return { members, yes, no, voted: yes.length + no };
}

export function dueProposals(): (Proposal & { telegram_chat_id: number })[] {
  return db.prepare(
    "SELECT p.*, c.telegram_chat_id FROM proposals p JOIN clubs c ON c.id = p.club_id WHERE p.status = 'open' AND p.closes_at <= ?",
  ).all(new Date().toISOString()) as (Proposal & { telegram_chat_id: number })[];
}

function setStatus(id: number, status: string, note: string | null, platform?: string, token?: string) {
  db.prepare("UPDATE proposals SET status = ?, note = ?, platform = COALESCE(?, platform), token_address = COALESCE(?, token_address) WHERE id = ?")
    .run(status, note, platform ?? null, token ?? null, id);
}

// Closes a vote: stop the poll, count, re-check rules + market, post the result.
export async function closeProposal(api: Api, p: Proposal, chatId: number): Promise<void> {
  // Claim it first so two closers (timer + "everyone voted") can't both run.
  const claimed = db.prepare("UPDATE proposals SET status = 'closing' WHERE id = ? AND status = 'open'").run(p.id);
  if (claimed.changes === 0) return;

  if (p.poll_message_id) await api.stopPoll(chatId, p.poll_message_id).catch(() => {});
  const t = tally(p);
  const rules = getRules(p.club_id);
  const yesPct = t.voted ? (t.yes.length / t.voted) * 100 : 0;
  const head = `🗳 <b>Vote closed: buy $${p.amount_usd} of ${esc(p.ticker)}</b>\n👍 ${t.yes.length}  👎 ${t.no}  (${t.voted} of ${t.members} members voted)`;

  if (t.voted < Math.ceil(t.members * QUORUM)) {
    setStatus(p.id, "failed", "not enough votes");
    await api.sendMessage(chatId, `${head}\n\n❌ Not enough people voted (need at least half the club). Not this time.`, { parse_mode: "HTML" });
    return;
  }
  if (yesPct < rules.vote_pass_percent) {
    setStatus(p.id, "failed", `${yesPct.toFixed(0)}% yes`);
    await api.sendMessage(chatId, `${head}\n\n❌ ${yesPct.toFixed(0)}% said yes, the club needs ${rules.vote_pass_percent}%. Not this time.`, { parse_mode: "HTML" });
    return;
  }

  // Passed the vote. Prices move, so check everything again right before buying.
  if (rules.paused) {
    setStatus(p.id, "refused", "club paused");
    await api.sendMessage(chatId, `${head}\n\n✅ The vote passed, but ⛔ the club is paused, so nobody buys.`, { parse_mode: "HTML" });
    return;
  }
  let card: Card;
  try {
    card = await priceCard(p.ticker);
  } catch {
    setStatus(p.id, "refused", "price check failed");
    await api.sendMessage(chatId, `${head}\n\n✅ The vote passed, but I couldn't get fresh prices from Binance, so I'm not buying. Propose it again in a bit.`, { parse_mode: "HTML" });
    return;
  }
  const marketNo = checkMarket(card, rules);
  if (marketNo) {
    setStatus(p.id, "refused", marketNo.replace(/<[^>]+>/g, ""));
    await api.sendMessage(chatId, `${head}\n\n✅ The vote passed, but I checked again right now:\n${marketNo}`, { parse_mode: "HTML" });
    return;
  }

  const best = card.best!;
  setStatus(p.id, "passed", null, best.platformId, best.tokenContractAddress);
  const names = t.yes.map((m) => esc(m.name)).join(", ");
  await api.sendMessage(
    chatId,
    `${head}\n\n✅ <b>Passed!</b> Buying via <b>${ISSUER_NAME[best.platformId]}</b> (${esc(best.tokenSymbol)}).\n` +
      `Yes-voters: ${names}. Each buys $${p.amount_usd} in their own wallet.`,
    { parse_mode: "HTML" },
  );
  await runBuys(api, chatId, p, t.yes, best, rules);
}

const ONDO_MIN_USD = 5;
export const WEB_URL = process.env.WEB_URL ?? "https://164-90-183-99.sslip.io";

async function runBuys(api: Api, chatId: number, p: Proposal, yes: Member[], best: Quote, rules: Rules) {
  const lines: string[] = [];
  const auto = yes.filter((m) => m.autopilot_on);
  if (auto.length && autopilotAvailable()) {
    await api.sendMessage(chatId, `🤖 Autopilot is buying for ${auto.length} member${auto.length > 1 ? "s" : ""}…`);
  }
  for (const m of yes) {
    const name = esc(m.name);
    // Check the club's rules again for each member right before spending.
    const left = rules.max_per_week - spentThisWeek(m.id);
    if (p.amount_usd > left) {
      lines.push(`⛔ ${name}: skipped, over the $${rules.max_per_week}/week limit ($${Math.max(0, left).toFixed(2)} left).`);
      continue;
    }
    // Trading API said "Minimum order amount is 5 USD" (code 40375) for Ondo.
    if (best.platformId === "ondo" && p.amount_usd < ONDO_MIN_USD) {
      lines.push(`⛔ ${name}: skipped, Ondo needs at least $${ONDO_MIN_USD} per trade.`);
      continue;
    }
    if (!m.autopilot_on || !autopilotAvailable()) {
      // Tap to buy: a private Buy button that opens the Mini App; the member signs in their own wallet.
      const tapToken = crypto.randomBytes(18).toString("base64url");
      createTapOrder(p.id, m.id, p.amount_usd, tapToken);
      const url = `${WEB_URL}/buy?t=${tapToken}`;
      const dm = await api
        .sendMessage(m.telegram_user_id, `🗳 Your club voted yes: buy <b>$${p.amount_usd} of ${esc(p.ticker)}</b>.\nTap the button to buy in your own wallet. The link works for 2 hours.`, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: `Buy $${p.amount_usd} ${p.ticker}`, web_app: { url } }]] },
        })
        .then(() => true)
        .catch(() => false); // fails if they never opened a private chat with the bot
      const me = await api.getMe();
      lines.push(
        dm
          ? `👆 ${name}: I sent you a Buy button in our private chat.`
          : `👆 ${name}: open t.me/${me.username}?start=buy_${tapToken} to get your Buy button.`,
      );
      continue;
    }
    const orderId = createOrder(p.id, m.id, "autopilot", p.amount_usd);
    const r = await buy(m.telegram_user_id, best.tokenContractAddress, p.amount_usd);
    finishOrder(orderId, { ...r, status: r.status });
    if (r.status === "filled") {
      const link = r.txHash ? ` · <a href="https://bscscan.com/tx/${r.txHash}">BscScan</a>` : "";
      lines.push(`✅ ${name} bought ${Number(r.qty ?? 0).toFixed(6)} ${esc(best.tokenSymbol)} for $${p.amount_usd}${link}`);
    } else if (r.status === "submitted") {
      lines.push(`⏳ ${name}: sent, still confirming. I'll keep the record.`);
    } else {
      lines.push(`❌ ${name}: ${esc(r.error ?? "failed")}`);
    }
  }
  const bought = lines.filter((l) => l.startsWith("✅")).length;
  await api.sendMessage(chatId, `🧾 <b>Results: ${bought} of ${yes.length} bought</b>\n${lines.join("\n")}`, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  });
}

export function proposalIntro(club: Club, proposer: Member, p: Proposal, card: Card, rules: Rules): string {
  const closes = new Date(p.closes_at);
  return (
    `🗳 <b>${esc(proposer.name)}</b> proposes: buy <b>$${p.amount_usd} of ${esc(p.ticker)}</b> each.\n\n` +
    `${card.text}\n\n` +
    `Vote below. Passes with ${rules.vote_pass_percent}% yes and at least half the club voting.\n` +
    `Closes at ${closes.toISOString().slice(11, 16)} UTC (${rules.vote_hours} h). Only members count, /join to vote.`
  );
}
