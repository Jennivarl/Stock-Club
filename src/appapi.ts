// API for the Stock Club Mini App (public/app.html): stock list, charts, portfolio, and starting votes.
// Who's calling: Telegram's signed initData (checked with the bot token), so nobody logs in.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { Api } from "grammy";
import { clubsOf, createTapOrder, db, getClub, getMember, getMembers, getRules, setAutopilot, setRule, soloDesk } from "./db.js";
import { checkMarket, pickIssuer, startProposal } from "./proposals.js";
import { priceCard, type Card } from "./card.js";
import { candles, impact, news, stockDetail, universe } from "./tools.js";
import { activeAlerts, addAlert, describe } from "./alerts.js";
import { autopilotAvailable, isConnected, startSignin, waitForSignin, walletInfo } from "./autopilot.js";
import { isTradable, ISSUER_NAME, quotesForMany, wallStreetNow } from "./rwa.js";
import { realQuote } from "./stocks.js";
import { balances, tokenBalance } from "./trading.js";

// The 15 stocks our logger has tracked (real price + on-chain) since Oct 4.
export const WATCH = ["NVDA", "TSLA", "AAPL", "MSFT", "META", "AMZN", "GOOGL", "AMD", "MU", "COIN", "CRCL", "QQQ", "SPY", "PLTR", "NFLX"];

type TgUser = { id: number; first_name?: string; username?: string };

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function userFromInitData(initData: string): TgUser | undefined {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return undefined;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.TELEGRAM_BOT_TOKEN ?? "").digest();
  const mine = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (mine.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(hash))) return undefined;
  if (Date.now() / 1000 - Number(params.get("auth_date") ?? 0) > 24 * 3600) return undefined;
  try { return JSON.parse(params.get("user") ?? ""); } catch { return undefined; }
}

// Token logos come from Binance (onchainos.bnbstatic.com). Some networks block Binance domains (the
// developer's home ISP does), so the app loads them from us: /api/app/logo/<id>.png, cached on disk.
const logoUrls = new Map<string, string>();
export function rememberLogo(url?: string): string | null {
  const m = url?.match(/^https:\/\/onchainos\.bnbstatic\.com\/[\w/.-]+\/([0-9a-fA-F]{32})\.png$/);
  if (!m) return null;
  logoUrls.set(m[1], url!);
  return `/api/app/logo/${m[1]}.png`;
}
async function logo(id: string): Promise<Buffer | undefined> {
  const file = path.resolve(`data/logos/${id}.png`);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const url = logoUrls.get(id);
  if (!url) return undefined;
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return undefined;
  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

// "Log in with Telegram" on the website (https://core.telegram.org/widgets/login#checking-authorization):
// hash = HMAC-SHA256(data_check_string, SHA256(bot_token)). We accept a login for 7 days.
export function userFromLoginWidget(header: string): TgUser | undefined {
  let d: Record<string, string | number>;
  // The page sends base64 of the UTF-8 JSON (headers can't carry names with emoji/symbols); plain JSON also accepted.
  const json = header.trim().startsWith("{") ? header : Buffer.from(header, "base64").toString("utf8");
  try { d = JSON.parse(json); } catch { return undefined; }
  if (!d || typeof d.hash !== "string" || !d.id) return undefined;
  const check = Object.keys(d).filter((k) => k !== "hash" && d[k] != null).sort().map((k) => `${k}=${d[k]}`).join("\n");
  const secret = crypto.createHash("sha256").update(process.env.TELEGRAM_BOT_TOKEN ?? "").digest();
  const mine = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (mine.length !== d.hash.length || !crypto.timingSafeEqual(Buffer.from(mine), Buffer.from(d.hash))) return undefined;
  if (Date.now() / 1000 - Number(d.auth_date ?? 0) > 7 * 24 * 3600) return undefined;
  return { id: Number(d.id), first_name: d.first_name as string | undefined, username: d.username as string | undefined };
}

let stocksCache: { at: number; data: unknown } | undefined;
async function stocks() {
  if (stocksCache && Date.now() - stocksCache.at < 30_000) return stocksCache.data;
  const quotes = await quotesForMany(WATCH);
  const reals = await Promise.all(WATCH.map((t) => realQuote(t).catch(() => null)));
  const ws = wallStreetNow();
  const data = {
    wallStreet: ws,
    stocks: WATCH.map((ticker, i) => {
      const qs = quotes.get(ticker) ?? [];
      const tradable = qs.filter(isTradable);
      const best = [...tradable].sort((a, b) => a.sharePrice - b.sharePrice)[0];
      const real = reals[i];
      const bs = qs.find((q) => q.platformId === "bstock");
      // These look company-level (NVDA marketCap ~ $5.5T, volume ~ $36B/day), repeated on each issuer's token,
      // so take one value; don't add them up.
      const one = (k: "volume24H" | "marketCap" | "peRatioTTM") => Number(bs?.[k] ?? qs.find((q) => q[k])?.[k]) || null;
      return {
        ticker,
        name: qs[0]?.underlyingName ?? ticker,
        logo: rememberLogo(bs?.tokenLogoUrl ?? qs.find((q) => q.tokenLogoUrl)?.tokenLogoUrl),
        stats: { pe: one("peRatioTTM"), volume24h: one("volume24H"), marketCap: one("marketCap") },
        onchain: best?.sharePrice ?? qs[0]?.sharePrice ?? null,
        bestIssuer: best ? ISSUER_NAME[best.platformId] : null,
        tradable: tradable.length > 0,
        issuers: qs.map((q) => ({ name: ISSUER_NAME[q.platformId], symbol: q.tokenSymbol, price: q.sharePrice, open: isTradable(q), logo: rememberLogo(q.tokenLogoUrl) })),
        real: real ? { price: real.price, prevClose: real.prevClose, at: real.at } : null,
        gapPct: best && real ? (best.sharePrice / real.price - 1) * 100 : null,
        changePct: best && real?.prevClose ? (best.sharePrice / real.prevClose - 1) * 100 : null,
      };
    }),
  };
  stocksCache = { at: Date.now(), data };
  return data;
}

// History from our own logger (data/real-YYYY-MM-DD.jsonl, every 15 min): on-chain per-share vs real price.
const chartCache = new Map<string, { at: number; data: unknown }>();
function chart(ticker: string, days: number) {
  const key = `${ticker}:${days}`;
  const c = chartCache.get(key);
  if (c && Date.now() - c.at < 5 * 60_000) return c.data;
  const points: { t: number; onchain: number; real: number }[] = [];
  for (let d = days; d >= 0; d--) {
    const day = new Date(Date.now() - d * 86400_000).toISOString().slice(0, 10);
    const file = path.resolve(`data/real-${day}.jsonl`);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes(`"ticker":"${ticker}"`) || !line.includes('"platform":"bstock"')) continue;
      try {
        const r = JSON.parse(line);
        if (r.realPrice && r.sharePrice) points.push({ t: Date.parse(r.time), onchain: Number(r.sharePrice), real: Number(r.realPrice) });
      } catch {}
    }
  }
  // One point per hour is plenty for a phone chart.
  const hourly = [...new Map(points.map((p) => [Math.floor(p.t / 3600_000), p])).values()];
  const data = { ticker, points: hourly };
  chartCache.set(key, { at: Date.now(), data });
  return data;
}

function lastWallet(telegramUserId: number): string | undefined {
  const r = db.prepare(`SELECT o.wallet_address AS w FROM orders o JOIN members m ON m.id = o.member_id
    WHERE m.telegram_user_id = ? AND o.wallet_address IS NOT NULL ORDER BY o.id DESC LIMIT 1`).get(telegramUserId) as { w: string } | undefined;
  return r?.w;
}

async function portfolio(wallet: string) {
  const quotes = await quotesForMany(WATCH);
  const tokens = [...quotes.values()].flat();
  const [bal, held] = await Promise.all([
    balances(wallet),
    Promise.all(tokens.map(async (q) => ({ q, b: await tokenBalance(wallet, q.tokenContractAddress).catch(() => ({ raw: 0n, qty: 0 })) }))),
  ]);
  const holdings = held.filter((h) => h.b.raw > 0n).map(({ q, b }) => ({
    ticker: q.underlyingTicker, symbol: q.tokenSymbol, issuer: ISSUER_NAME[q.platformId], qty: b.qty, value: b.qty * q.tokenPrice,
  }));
  return { wallet, usdt: bal.usdt, bnb: bal.bnb, holdings, total: bal.usdt + holdings.reduce((s, h) => s + h.value, 0) };
}

let botName: string | undefined;
// /resetapp in the bot: next app open starts like a brand-new user (intro, checklist, no remembered wallet).
export const freshStart = new Set<number>();
const forgetWallet = new Set<number>();
const signins = new Map<number, { url: string; code: string; at: number; status: "waiting" | "ok" | "failed"; error?: string }>();
const isAddr = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);

// Returns true if it handled the request.
export async function handleApp(api: Api, req: http.IncomingMessage, url: URL, send: (code: number, body: unknown) => void, readJson: () => Promise<any>, res?: http.ServerResponse): Promise<boolean> {
  if (!url.pathname.startsWith("/api/app/")) return false;
  const lm = url.pathname.match(/^\/api\/app\/logo\/([0-9a-fA-F]{32})\.png$/);
  if (req.method === "GET" && lm && res) {
    if (!logoUrls.size) await stocks();
    const buf = await logo(lm[1]).catch(() => undefined);
    if (!buf) { send(404, { error: "No logo" }); return true; }
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    res.end(buf); return true;
  }
  // Debug: website login steps from the browser (event names only).
  if (req.method === "POST" && url.pathname === "/api/app/clientlog") {
    const b = await readJson().catch(() => ({}));
    console.log("weblog", String(b.event ?? "").slice(0, 40), String(b.detail ?? "").slice(0, 160));
    send(200, { ok: true }); return true;
  }
  if (req.method === "GET" && url.pathname === "/api/app/info") {
    botName ??= (await api.getMe()).username;
    // The bot's numeric id is public (it's the part of the token before ":"); Telegram's login needs it.
    send(200, { bot: botName, botId: Number(String(process.env.TELEGRAM_BOT_TOKEN ?? "").split(":")[0]) || null }); return true;
  }
  if (req.method === "GET" && url.pathname === "/api/app/stocks") { send(200, await stocks()); return true; }
  if (req.method === "GET" && url.pathname === "/api/app/chart") {
    const t = String(url.searchParams.get("ticker") ?? "").toUpperCase();
    if (!WATCH.includes(t)) { send(404, { error: "Unknown stock." }); return true; }
    send(200, chart(t, Math.min(14, Number(url.searchParams.get("days") ?? 7)))); return true;
  }

  const tk = String(url.searchParams.get("ticker") ?? "").toUpperCase().replace(/[^A-Z.]/g, "");
  if (req.method === "GET" && url.pathname === "/api/app/candles") {
    const bar = (["1h", "4h", "1d"] as const).find((b) => b === url.searchParams.get("bar")) ?? "1d";
    send(200, await candles(tk, bar).catch((e) => { console.error("candles", e.message); return []; })); return true;
  }
  if (req.method === "GET" && url.pathname === "/api/app/news") { send(200, await news(tk).catch(() => ({ news: [], earnings: null }))); return true; }
  if (req.method === "GET" && url.pathname === "/api/app/impact") { send(200, await impact(tk).catch(() => [])); return true; }
  if (req.method === "GET" && url.pathname === "/api/app/universe") { send(200, await universe(rememberLogo)); return true; }
  if (req.method === "GET" && url.pathname === "/api/app/stock") {
    const d = await stockDetail(tk, rememberLogo);
    send(d ? 200 : 404, d ?? { error: "Not listed." }); return true;
  }
  if (req.method === "GET" && url.pathname === "/api/app/sparks") {
    // Last ~48 h of on-chain prices per stock, for the small charts in the list.
    const out: Record<string, number[]> = {};
    for (const t of WATCH) out[t] = ((chart(t, 2) as any).points as { t: number; onchain: number }[]).filter((p) => p.t > Date.now() - 48 * 3600_000).map((p) => p.onchain);
    send(200, out); return true;
  }

  // Inside Telegram: the Mini App's signed initData. On the website: the signed "Log in with Telegram" data.
  const user = userFromInitData(String(req.headers["x-init-data"] ?? "")) ?? userFromLoginWidget(String(req.headers["x-tg-login"] ?? ""));
  if (!req.headers["x-init-data"] && req.headers["x-tg-login"] && url.pathname === "/api/app/me") console.log("web login", user ? `ok ${user.id}` : "REJECTED");
  if (!user) { send(401, { error: "Open this from Telegram." }); return true; }

  if (req.method === "GET" && url.pathname === "/api/app/me") {
    const clubs = clubsOf(user.id).map((c) => {
      const m = getMember(c.id, user.id);
      return { chatId: c.telegram_chat_id, name: c.name, isCreator: c.created_by === user.id, members: getMembers(c.id).length, autopilot: Boolean(m?.autopilot_on), rules: getRules(c.id) };
    });
    botName ??= (await api.getMe()).username;
    const reset = freshStart.delete(user.id); // /resetapp: the app forgets this user once
    if (reset) forgetWallet.add(user.id);
    send(200, { user: { id: user.id, name: user.first_name ?? user.username ?? "you" }, bot: botName, clubs, wallet: forgetWallet.has(user.id) ? null : lastWallet(user.id) ?? null, reset });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/app/portfolio") {
    if (url.searchParams.get("wallet")) forgetWallet.delete(user.id);
    const w = url.searchParams.get("wallet") || (forgetWallet.has(user.id) ? null : lastWallet(user.id));
    if (!isAddr(w)) { send(200, { wallet: null }); return true; }
    send(200, await portfolio(w)); return true;
  }
  // Edit the club's rules (creator only, like /rules set). The bot posts what changed in the group.
  if (req.method === "POST" && url.pathname === "/api/app/rules") {
    const { chatId, changes } = await readJson();
    const club = getClub(Number(chatId));
    if (!club || !getMember(club.id, user.id)) { send(403, { error: "You're not a member of that club." }); return true; }
    if (club.created_by !== user.id) { send(403, { error: "Only the club creator can change the rules." }); return true; }
    const LIMITS: Record<string, [number, number, string, (v: number) => string]> = {
      max_per_trade: [1, 1000, "Max per trade", (v) => `$${v}`], max_per_week: [1, 5000, "Max per week", (v) => `$${v}`],
      vote_pass_percent: [50, 100, "Vote passes at", (v) => `${v}% yes`], vote_hours: [0.05, 72, "Vote length", (v) => v < 1 ? `${Math.round(v * 60)} min` : `${v} h`],
      max_gap_percent: [0.1, 20, "Max gap vs real price", (v) => `${v}%`], max_spread_percent: [0.1, 20, "Max bStocks/Ondo difference", (v) => `${v}%`],
    };
    const before = getRules(club.id) as any, lines: string[] = [];
    for (const [k, raw] of Object.entries(changes ?? {})) {
      if (k === "allowed_tickers") {
        const v = raw == null || String(raw).trim() === "" ? null : String(raw).toUpperCase().split(/[\s,]+/).map((x) => x.replace(/[^A-Z.]/g, "")).filter(Boolean).slice(0, 50).join(",");
        if ((before.allowed_tickers ?? null) !== v) { setRule(club.id, "allowed_tickers", v); lines.push(`Allowed stocks: ${before.allowed_tickers ?? "any"} → ${v ?? "any"}`); }
        continue;
      }
      const lim = LIMITS[k];
      if (!lim) continue;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < lim[0] || v > lim[1]) { send(422, { error: `${lim[2]} must be from ${lim[0]} to ${lim[1]}.` }); return true; }
      if (Number(before[k]) !== v) { setRule(club.id, k as any, v); lines.push(`${lim[2]}: ${lim[3](Number(before[k]))} → ${lim[3](v)}`); }
    }
    if (lines.length) {
      await api.sendMessage(club.telegram_chat_id, `✏️ <b>${user.first_name ?? "The creator"} changed the club rules</b>\n${lines.map((l) => `• ${l}`).join("\n")}`, { parse_mode: "HTML" }).catch(() => {});
    }
    send(200, { ok: true, changed: lines.length, rules: getRules(club.id) }); return true;
  }

  // Autopilot (Binance Agentic Wallet) from the app: same flow as /autopilot in the bot.
  if (url.pathname === "/api/app/autopilot") {
    if (!autopilotAvailable()) { send(200, { available: false }); return true; }
    const inClub = clubsOf(user.id).length > 0;
    if (req.method === "POST") {
      const { action } = await readJson();
      if (!inClub) { send(409, { error: "Join a club first." }); return true; }
      if (action === "off") { setAutopilot(user.id, false); send(200, { ok: true }); return true; }
      if (action === "on") {
        if (!(await isConnected(user.id))) { send(409, { error: "Connect your Agentic Wallet first." }); return true; }
        setAutopilot(user.id, true); send(200, { ok: true }); return true;
      }
      if (action === "connect") {
        if (await isConnected(user.id)) { setAutopilot(user.id, true); send(200, { connected: true }); return true; }
        const p = signins.get(user.id);
        if (p?.status === "waiting" && Date.now() - p.at < 5 * 60_000) { send(200, { url: p.url, code: p.code }); return true; }
        const s = await startSignin(user.id);
        if ("error" in s) { send(502, { error: `Couldn't start the Binance login: ${s.error}` }); return true; }
        if ("already" in s) { setAutopilot(user.id, true); send(200, { connected: true }); return true; }
        const entry = { url: s.url, code: s.code, at: Date.now(), status: "waiting" as "waiting" | "ok" | "failed", error: undefined as string | undefined };
        signins.set(user.id, entry);
        // Waits in the background (up to ~5 min); the app polls GET /api/app/autopilot.
        waitForSignin(user.id, s.qrCodeId).then(async (r) => {
          entry.status = r.ok ? "ok" : "failed"; entry.error = r.error;
          if (r.ok) {
            setAutopilot(user.id, true);
            await api.sendMessage(user.id, "✅ Agentic Wallet connected. Autopilot is ON: when your club votes yes and you voted yes, I buy for you.").catch(() => {});
          }
        }).catch((e) => { entry.status = "failed"; entry.error = String(e?.message ?? e); });
        send(200, { url: s.url, code: s.code }); return true;
      }
      send(400, { error: "Unknown action." }); return true;
    }
    const connected = await isConnected(user.id);
    const on = connected && clubsOf(user.id).some((c) => getMember(c.id, user.id)?.autopilot_on);
    const p = signins.get(user.id);
    let wallet = null;
    if (connected) {
      const w = await walletInfo(user.id);
      wallet = { address: w.address ?? null, usdt: w.usdt, bnb: w.bnb, dailyLimit: w.settings?.dailyLimit ?? null, loginEnds: w.settings?.inactiveSignOutTime ?? null };
    }
    send(200, { available: true, inClub, connected, on, wallet, pending: p && p.status === "waiting" && Date.now() - p.at < 5 * 60_000 ? { url: p.url, code: p.code } : null, failed: p?.status === "failed" ? (p.error ?? "not approved") : null });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/app/alert") {
    const { chatId, ticker, kind, value } = await readJson();
    const club = getClub(Number(chatId));
    if (!club || !getMember(club.id, user.id)) { send(403, { error: "You're not a member of that club." }); return true; }
    const r = await addAlert(club.id, user.id, user.first_name ?? user.username ?? "a member", String(ticker ?? "").toUpperCase().replace(/[^A-Z.]/g, ""), String(kind), Number(value));
    if (typeof r === "string") { send(422, { error: r }); return true; }
    await api.sendMessage(club.telegram_chat_id, `🔔 ${user.first_name ?? "A member"} set an alert: <b>${describe(r)}</b>. I'll post here when it happens.`, { parse_mode: "HTML" }).catch(() => {});
    send(200, { ok: true, alert: r, text: describe(r) }); return true;
  }
  if (req.method === "GET" && url.pathname === "/api/app/alerts") {
    const club = getClub(Number(url.searchParams.get("chatId")));
    if (!club || !getMember(club.id, user.id)) { send(403, { error: "You're not a member of that club." }); return true; }
    send(200, activeAlerts(club.id).map((a) => ({ id: a.id, ticker: a.ticker, text: describe(a), by: a.creator_name }))); return true;
  }
  // Solo: buy or sell right away, no vote. Same safety checks (gap vs real price) and the same Buy/Sell page.
  if (req.method === "POST" && url.pathname === "/api/app/solo") {
    const { ticker, amount, side } = await readJson();
    const t = String(ticker ?? "").toUpperCase().replace(/[^A-Z.]/g, "");
    const sd: "buy" | "sell" = side === "sell" ? "sell" : "buy";
    const usd = sd === "sell" ? 0 : Number(amount);
    if (sd === "buy" && (!Number.isFinite(usd) || usd < 1 || usd > 1000)) { send(422, { error: "Pick an amount from $1 to $1,000." }); return true; }
    const { club, member } = soloDesk(user.id, user.first_name ?? user.username ?? "Trader");
    let card: Card;
    try { card = await priceCard(t); } catch { send(502, { error: "Couldn't get prices from Binance right now. Try again in a minute." }); return true; }
    const marketNo = checkMarket(card, getRules(club.id), usd, sd);
    if (marketNo) { send(422, { error: marketNo.replace(/<[^>]+>/g, "") }); return true; }
    const best = pickIssuer(card, usd, sd)!;
    const pr = db.prepare("INSERT INTO proposals (club_id, proposer_id, ticker, amount_usd, closes_at, side, status, platform, token_address) VALUES (?, ?, ?, ?, ?, ?, 'solo', ?, ?)")
      .run(club.id, member.id, t, usd, new Date().toISOString(), sd, best.platformId, best.tokenContractAddress);
    const tapToken = crypto.randomBytes(18).toString("base64url");
    createTapOrder(Number(pr.lastInsertRowid), member.id, usd, tapToken);
    send(200, { url: `/buy?t=${tapToken}` });
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/app/propose") {
    const { chatId, ticker, amount, side } = await readJson();
    const club = getClub(Number(chatId));
    const member = club && getMember(club.id, user.id);
    if (!club || !member) { send(403, { error: "You're not a member of that club." }); return true; }
    const t = String(ticker ?? "").toUpperCase().replace(/[^A-Z.]/g, "");
    const s = side === "sell" ? "sell" : "buy";
    const err = await startProposal(api, club, member, t, s === "sell" ? 0 : Number(amount), s);
    send(err ? 422 : 200, err ? { error: err.replace(/<[^>]+>/g, "") } : { ok: true, club: club.name });
    return true;
  }
  send(404, { error: "Not found" });
  return true;
}
