// API for the Stock Club Mini App (public/app.html): stock list, charts, portfolio, and starting votes.
// Who's calling: Telegram's signed initData (checked with the bot token), so nobody logs in.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { Api } from "grammy";
import { clubsOf, db, getClub, getMember, getMembers, getRules } from "./db.js";
import { startProposal } from "./proposals.js";
import { candles, impact, news, stockDetail, universe } from "./tools.js";
import { activeAlerts, addAlert, describe } from "./alerts.js";
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

  const user = userFromInitData(String(req.headers["x-init-data"] ?? ""));
  if (!user) { send(401, { error: "Open this from Telegram." }); return true; }

  if (req.method === "GET" && url.pathname === "/api/app/me") {
    const clubs = clubsOf(user.id).map((c) => {
      const m = getMember(c.id, user.id);
      return { chatId: c.telegram_chat_id, name: c.name, members: getMembers(c.id).length, autopilot: Boolean(m?.autopilot_on), rules: getRules(c.id) };
    });
    botName ??= (await api.getMe()).username;
    send(200, { user: { id: user.id, name: user.first_name ?? user.username ?? "you" }, bot: botName, clubs, wallet: lastWallet(user.id) ?? null });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/app/portfolio") {
    const w = url.searchParams.get("wallet") || lastWallet(user.id);
    if (!isAddr(w)) { send(200, { wallet: null }); return true; }
    send(200, await portfolio(w)); return true;
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
