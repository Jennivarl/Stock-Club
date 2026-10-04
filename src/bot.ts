import "dotenv/config";
import { Bot, type Context } from "grammy";
import { addMember, createClub, getClub, getMembers, getRules, RULE_KEYS, setRule, type Rules } from "./db.js";
import { priceCard } from "./card.js";

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
].join("\n");

function rulesText(r: Rules): string {
  return [
    "📜 <b>Club rules</b>",
    `Max per trade: $${r.max_per_trade} per member  <code>max_trade</code>`,
    `Max per week: $${r.max_per_week} per member  <code>max_week</code>`,
    `Vote passes at: ${r.vote_pass_percent}% yes  <code>pass</code>`,
    `Vote time: ${r.vote_hours} h  <code>hours</code>`,
    `Max price difference between issuers: ${r.max_spread_percent}%  <code>max_spread</code>`,
    `Allowed stocks: ${r.allowed_tickers ?? "any"}  <code>allowed</code>`,
    r.paused ? "⛔ Club is <b>paused</b>." : "",
  ].filter(Boolean).join("\n");
}

bot.command(["start", "help"], (ctx) => ctx.reply(HELP, { parse_mode: "HTML" }));

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
      max_per_trade: [1, 1000], max_per_week: [1, 5000], vote_pass_percent: [50, 100], vote_hours: [0.05, 72], max_spread_percent: [0.1, 20],
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

bot.catch((err) => console.error("bot error", err.error));

await bot.api.setMyCommands([
  { command: "club", description: "start a club: /club start [name]" },
  { command: "join", description: "join this group's club" },
  { command: "members", description: "who's in the club" },
  { command: "rules", description: "show or change club rules" },
  { command: "price", description: "live price card: /price NVDA" },
  { command: "help", description: "how Stock Club works" },
]);
console.log("Stock Club bot running");
bot.start();
