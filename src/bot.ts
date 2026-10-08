import "dotenv/config";
import { Bot, type Context } from "grammy";
import {
  addMember, clubsOf, createClub, db, expireOldTapOrders, getClub, getTapOrder, getMember, getMembers, getRules, RULE_KEYS, setAutopilot, setPaused, setRule, type Rules,
} from "./db.js";
import { priceCard } from "./card.js";
import { autopilotAvailable, isConnected, signout, startSignin, waitForSignin, walletInfo } from "./autopilot.js";
import {
  attachPoll, checkMarket, checkRules, closeProposal, createProposal, dueProposals, getOpenProposalForTicker, proposalIntro, recordVote, tally,
  WEB_URL,
} from "./proposals.js";
import { startWeb } from "./web.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN in .env");
const bot = new Bot(token);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const isGroup = (ctx: Context) => ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
const userName = (ctx: Context) => ctx.from?.first_name ?? ctx.from?.username ?? "member";

const HELP = [
  "<b>Stock Club</b>: friends vote on stocks, everyone buys in their own wallet.",
  "",
  "<b>In a group:</b>",
  "/club start [name] - start a club in this group",
  "/join - join the club",
  "/members - who's in",
  "/rules - show club rules",
  "/price NVDA - live price card",
  "/propose NVDA 20 - vote on everyone buying $20 of NVDA",
  "/stop - any member can pause the club",
  "/resume - un-pause (club creator)",
  "",
  "<b>In a private chat with me:</b>",
  "/autopilot - connect your Binance Agentic Wallet so I buy for you when a vote passes",
  "/autopilot off - pause (you get Buy buttons instead)",
  "/autopilot logout - pause and sign out of your Agentic Wallet",
].join("\n");

function rulesText(r: Rules): string {
  return [
    "📜 <b>Club rules</b>",
    `Max per trade: $${r.max_per_trade} per member  <code>max_trade</code>`,
    `Max per week: $${r.max_per_week} per member  <code>max_week</code>`,
    `Vote passes at: ${r.vote_pass_percent}% yes  <code>pass</code>`,
    `Vote time: ${r.vote_hours} h  <code>hours</code>`,
    `Max gap vs real stock price: ${r.max_gap_percent}%  <code>max_gap</code>`,
    `Max price difference between issuers: ${r.max_spread_percent}%  <code>max_spread</code>`,
    `Allowed stocks: ${r.allowed_tickers ?? "any"}  <code>allowed</code>`,
    r.paused ? "⛔ Club is <b>paused</b>." : "",
  ].filter(Boolean).join("\n");
}

bot.command(["start", "help"], async (ctx) => {
  // Deep link from a group: t.me/<bot>?start=autopilot
  if (ctx.chat?.type === "private" && ctx.match === "autopilot") return autopilotCommand(ctx, "");
  // Deep link to a Buy button: t.me/<bot>?start=buy_<token> (used when we couldn't DM first)
  if (ctx.chat?.type === "private" && ctx.match.startsWith("buy_")) {
    const o = getTapOrder(ctx.match.slice(4));
    if (!o || o.telegram_user_id !== ctx.from?.id) return ctx.reply("This Buy link isn't for you or has expired.");
    if (o.status !== "pending") return ctx.reply(`This buy is already ${o.status}.`);
    return ctx.reply(`Buy <b>$${o.amount_usd} of ${esc(o.ticker)}</b> in your own wallet:`, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: `Buy $${o.amount_usd} ${o.ticker}`, web_app: { url: `${WEB_URL}/buy?t=${ctx.match.slice(4)}` } }]] },
    });
  }
  await ctx.reply(HELP, { parse_mode: "HTML" });
});

// ---- Autopilot (Binance Agentic Wallet) ----
const signinInProgress = new Set<number>();

async function autopilotCommand(ctx: Context, arg: string) {
  const uid = ctx.from!.id;
  if (ctx.chat?.type !== "private") {
    const me = await ctx.api.getMe();
    return ctx.reply(`Autopilot is set up in a private chat (it shows a login link just for you): t.me/${me.username}?start=autopilot`);
  }
  if (!clubsOf(uid).length) return ctx.reply("Join a club first: /join in your club's group. Then come back here.");
  if (!autopilotAvailable()) return ctx.reply("Autopilot isn't available on this server right now.");

  if (arg === "off") {
    // Pause only: the Binance login stays, so /autopilot turns it back on without a new approval.
    setAutopilot(uid, false);
    return ctx.reply("⏸ Autopilot is paused. I won't buy for you; you'll get a Buy button instead.\nTurn it back on: /autopilot\nFully log out of your Agentic Wallet: /autopilot logout");
  }
  if (arg === "logout") {
    setAutopilot(uid, false);
    await signout(uid);
    return ctx.reply("🛑 Autopilot is off and I signed out of your Agentic Wallet. To use it again, /autopilot and approve a new login.");
  }

  if (await isConnected(uid)) {
    setAutopilot(uid, true);
    const w = await walletInfo(uid);
    const s = w.settings ?? {};
    return ctx.reply(
      [
        "🤖 <b>Autopilot is ON.</b> When your club votes yes and you voted yes, I buy for you.",
        "",
        `Wallet (BSC): <code>${w.address ?? "?"}</code>`,
        `Balance: ${w.usdt.toFixed(2)} USDT, ${w.bnb.toFixed(5)} BNB (for fees)`,
        `Binance daily limit: $${s.dailyLimit ?? "?"} (change it only in the Binance App)`,
        `Login ends: ${s.inactiveSignOutTime ? new Date(s.inactiveSignOutTime).toUTCString() : "?"} if unused`,
        "",
        "Top up: send USDT + a little BNB on <b>BNB Smart Chain (BEP20)</b> to the address above. Not opBNB.",
        "Pause: /autopilot off · Sign out: /autopilot logout",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  }

  if (signinInProgress.has(uid)) return ctx.reply("I already sent you a login link. Approve it in the Binance App (it lasts 5 minutes).");
  const s = await startSignin(uid);
  if ("error" in s) return ctx.reply(`⚠️ Couldn't start the Binance login: ${s.error}`);
  if ("already" in s) return autopilotCommand(ctx, arg);

  signinInProgress.add(uid);
  await ctx.reply(
    [
      "🔐 <b>Connect your Binance Agentic Wallet</b>",
      "",
      `1. Open this link on your phone: ${s.url}`,
      `2. Check the code in the Binance App is <b>${s.code}</b>`,
      "3. If asked, create the Agentic Wallet. Tick <b>Secure Auto Sign</b>, then Confirm.",
      "",
      "The request comes from our server in Frankfurt, Germany. That's expected.",
      "You have 5 minutes. I'll tell you when it worked.",
    ].join("\n"),
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
  );
  // Waits in the background (up to ~5 min) so the bot keeps answering others.
  waitForSignin(uid, s.qrCodeId)
    .then(async (r) => {
      if (r.ok) {
        setAutopilot(uid, true);
        await ctx.reply("✅ Connected! Autopilot is ON. Send /autopilot to see your wallet, balance and limits.");
      } else {
        await ctx.reply(`❌ Login didn't finish (${r.error ?? "not approved"}). Send /autopilot to get a new link.`);
      }
    })
    .catch((e) => console.error("signin wait error", e))
    .finally(() => signinInProgress.delete(uid));
}

bot.command("autopilot", (ctx) => autopilotCommand(ctx, ctx.match.trim().toLowerCase()));

bot.command("club", async (ctx) => {
  const [sub, ...rest] = ctx.match.trim().split(/\s+/);
  if (sub !== "start") return ctx.reply("Use: /club start [name]");
  if (!isGroup(ctx)) return ctx.reply("Add me to a group first, then run /club start there.");
  const existing = getClub(ctx.chat.id);
  if (existing) return ctx.reply(`This group already has a club: <b>${esc(existing.name)}</b>. Use /join.`, { parse_mode: "HTML" });
  const name = rest.join(" ") || (ctx.chat as { title?: string }).title || "Stock Club";
  const club = createClub(ctx.chat.id, name.slice(0, 60), ctx.from!.id, userName(ctx));
  await ctx.reply(
    `🎉 <b>${esc(club.name)}</b> is open!\n${esc(userName(ctx))} is the first member.\n\nEveryone else: tap /join\n\n${rulesText(getRules(club.id))}`,
    { parse_mode: "HTML" },
  );
});

bot.command("join", async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply("Run /join inside the club's group.");
  const club = getClub(ctx.chat.id);
  if (!club) return ctx.reply("No club here yet. Start one with /club start");
  const added = addMember(club.id, ctx.from!.id, userName(ctx));
  const count = getMembers(club.id).length;
  await ctx.reply(added ? `👋 Welcome ${userName(ctx)}! The club has ${count} members.` : `${userName(ctx)}, you're already in.`);
});

bot.command("members", async (ctx) => {
  const club = isGroup(ctx) ? getClub(ctx.chat!.id) : undefined;
  if (!club) return ctx.reply("No club here yet. Start one with /club start");
  const list = getMembers(club.id).map((m, i) => `${i + 1}. ${esc(m.name)}${m.wallet_address ? " 💼" : ""}`);
  await ctx.reply(`<b>${esc(club.name)}</b> members:\n${list.join("\n")}\n\n💼 = wallet linked`, { parse_mode: "HTML" });
});

bot.command("rules", async (ctx) => {
  const club = isGroup(ctx) ? getClub(ctx.chat!.id) : undefined;
  if (!club) return ctx.reply("No club here yet. Start one with /club start");
  const [sub, key, ...val] = ctx.match.trim().split(/\s+/);
  if (sub !== "set") {
    return ctx.reply(rulesText(getRules(club.id)) + "\n\nChange one: <code>/rules set max_trade 30</code>", { parse_mode: "HTML" });
  }
  // For now only the club creator changes rules. (Later: changes go to a vote.)
  if (ctx.from!.id !== club.created_by) return ctx.reply("Only the club creator can change rules for now.");
  const column = RULE_KEYS[key];
  if (!column) return ctx.reply(`Unknown rule. Use one of: ${Object.keys(RULE_KEYS).join(", ")}`);
  const raw = val.join(" ");
  let value: number | string | null;
  if (column === "allowed_tickers") {
    value = raw.toLowerCase() === "any" || !raw ? null : raw.toUpperCase().split(/[\s,]+/).filter(Boolean).join(",");
  } else {
    value = Number(raw);
    const limits: Record<string, [number, number]> = {
      max_per_trade: [1, 1000], max_per_week: [1, 5000], vote_pass_percent: [50, 100], vote_hours: [0.05, 72], max_spread_percent: [0.1, 20], max_gap_percent: [0.1, 20],
    };
    const [min, max] = limits[column];
    if (!Number.isFinite(value) || value < min || value > max) return ctx.reply(`${key} must be a number from ${min} to ${max}.`);
  }
  setRule(club.id, column, value);
  await ctx.reply("✅ Updated.\n\n" + rulesText(getRules(club.id)), { parse_mode: "HTML" });
});

bot.command("price", async (ctx) => {
  const ticker = ctx.match.trim().split(/\s+/)[0];
  if (!ticker) return ctx.reply("Use: /price NVDA");
  try {
    const card = await priceCard(ticker);
    await ctx.reply(card.text, { parse_mode: "HTML" });
  } catch (e) {
    console.error("price error", e);
    await ctx.reply("⚠️ Couldn't get prices from Binance right now. Try again in a minute.");
  }
});

bot.command("propose", async (ctx) => {
  const club = isGroup(ctx) ? getClub(ctx.chat!.id) : undefined;
  if (!club) return ctx.reply("Run /propose inside a club group. No club yet? /club start");
  const member = getMember(club.id, ctx.from!.id);
  if (!member) return ctx.reply("Only members can propose. Tap /join first.");
  const [rawTicker, rawAmount] = ctx.match.trim().split(/\s+/);
  if (!rawTicker || !rawAmount) return ctx.reply("Use: /propose NVDA 20  (stock, then dollars per member)");
  const ticker = rawTicker.toUpperCase().replace(/[^A-Z.]/g, "");
  const amount = Number(rawAmount.replace("$", ""));
  const rules = getRules(club.id);

  const ruleNo = checkRules(rules, ticker, amount, member);
  if (ruleNo) return ctx.reply(ruleNo, { parse_mode: "HTML" });
  if (getOpenProposalForTicker(club.id, ticker)) return ctx.reply(`There's already an open vote on ${ticker}. Vote on that one first.`);

  let card;
  try {
    card = await priceCard(ticker);
  } catch (e) {
    console.error("propose price error", e);
    return ctx.reply("⚠️ Couldn't get prices from Binance right now. Try again in a minute.");
  }
  const marketNo = checkMarket(card, rules, amount);
  if (marketNo) return ctx.reply(marketNo, { parse_mode: "HTML" });

  const p = createProposal(club.id, member.id, ticker, amount, rules.vote_hours);
  await ctx.reply(proposalIntro(club, member, p, card, rules), { parse_mode: "HTML" });
  const poll = await ctx.api.sendPoll(ctx.chat!.id, `Buy $${amount} of ${ticker} each?`, [{ text: "👍 Yes, I'm in" }, { text: "👎 No" }], {
    is_anonymous: false,
  });
  attachPoll(p.id, poll.poll!.id, poll.message_id);
});

bot.on("poll_answer", async (ctx) => {
  const a = ctx.pollAnswer;
  if (!a.user) return;
  const p = recordVote(a.poll_id, a.user.id, a.option_ids);
  if (!p) return;
  // Everyone voted? Close early instead of waiting for the timer.
  const t = tally(p);
  if (t.voted >= t.members) {
    const { telegram_chat_id } = db.prepare("SELECT telegram_chat_id FROM clubs WHERE id = ?").get(p.club_id) as { telegram_chat_id: number };
    await closeProposal(ctx.api, p, telegram_chat_id);
  }
});

bot.command("stop", async (ctx) => {
  const club = isGroup(ctx) ? getClub(ctx.chat!.id) : undefined;
  if (!club) return ctx.reply("No club here yet.");
  if (!getMember(club.id, ctx.from!.id)) return ctx.reply("Only members can stop the club.");
  setPaused(club.id, true);
  await ctx.reply(`⛔ ${esc(userName(ctx))} paused the club. No new votes and no buying until the club creator uses /resume.`);
});

bot.command("resume", async (ctx) => {
  const club = isGroup(ctx) ? getClub(ctx.chat!.id) : undefined;
  if (!club) return ctx.reply("No club here yet.");
  if (ctx.from!.id !== club.created_by) return ctx.reply("Only the club creator can /resume for now.");
  setPaused(club.id, false);
  await ctx.reply("✅ Club resumed. Proposals are open again.");
});

// Close votes when their time is up. Runs every 20 s; also catches votes that ended while the bot was down.
async function sweep() {
  expireOldTapOrders();
  for (const p of dueProposals()) {
    try {
      await closeProposal(bot.api, p, p.telegram_chat_id);
    } catch (e) {
      console.error("close error", p.id, e);
    }
  }
}
setInterval(sweep, 20_000);

bot.catch((err) => console.error("bot error", err.error));

await bot.api.setMyCommands([
  { command: "club", description: "start a club: /club start [name]" },
  { command: "join", description: "join this group's club" },
  { command: "members", description: "who's in the club" },
  { command: "rules", description: "show or change club rules" },
  { command: "price", description: "live price card: /price NVDA" },
  { command: "propose", description: "start a vote: /propose NVDA 20" },
  { command: "stop", description: "pause the club (any member)" },
  { command: "resume", description: "un-pause the club (creator)" },
  { command: "autopilot", description: "let me buy for you (private chat)" },
  { command: "help", description: "how Stock Club works" },
]);
startWeb(bot.api);
console.log("Stock Club bot running");
bot.start({ allowed_updates: ["message", "poll_answer"] });
