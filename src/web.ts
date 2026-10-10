// Web server for the Telegram Mini App "Buy" page. Caddy serves it over HTTPS in front of this.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Api } from "grammy";
import { getTapOrder, updateTapOrder, type TapOrder } from "./db.js";
import { blockNumber, confirmBuy, findBuyTx, isApproved, planBuy, planSell, receiptStatus, sentCount, USDT } from "./trading.js";
import { isTradable, quotesFor } from "./rwa.js";

const PORT = Number(process.env.WEB_PORT ?? 8080);
const PUBLIC = path.resolve("public");
const isAddr = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
const isHash = (s: unknown): s is string => typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function send(res: http.ServerResponse, code: number, body: unknown, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("too big");
  }
  return JSON.parse(raw || "{}");
}

export function startWeb(api: Api) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/buy") {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, "buy.html"), "utf8"), "text/html; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/wallet.js") {
        return send(res, 200, fs.readFileSync(path.join(PUBLIC, "wallet.js"), "utf8"), "text/javascript; charset=utf-8");
      }
      if (req.method === "GET" && url.pathname === "/api/config") {
        return send(res, 200, { walletConnectProjectId: process.env.WALLETCONNECT_PROJECT_ID ?? "" });
      }

      const order = getTapOrder(String(url.searchParams.get("t") ?? ""));
      if (url.pathname.startsWith("/api/") && !order) return send(res, 404, { error: "This Buy link isn't valid." });

      if (req.method === "GET" && url.pathname === "/api/order") {
        return send(res, 200, {
          ticker: order!.ticker, amount: order!.amount_usd, status: order!.status, name: order!.member_name,
          token: order!.token_address, platform: order!.platform, txHash: order!.tx_hash, qty: order!.qty, error: order!.error, side: order!.side,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/log") {
        const b = await readJson(req).catch(() => ({}));
        if (b.event === "ws-url") fs.appendFileSync(path.resolve("data/ws-urls.log"), `${new Date().toISOString()} ${String(b.detail).slice(0, 3000)}\n`);
        else console.log("miniapp", JSON.stringify({ order: order!.id, ...b }).slice(0, 800));
        return send(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/api/receipt") {
        const h = url.searchParams.get("h");
        if (!isHash(h)) return send(res, 400, { error: "Bad transaction hash." });
        return send(res, 200, { status: await receiptStatus(h) });
      }

      if (req.method === "POST" && url.pathname === "/api/plan") {
        if (order!.status !== "pending") return send(res, 409, { error: `This buy is already ${order!.status}.` });
        const { wallet } = await readJson(req);
        if (!isAddr(wallet)) return send(res, 400, { error: "Bad wallet address." });
        try {
          if (order!.side === "buy") return send(res, 200, await planBuy(wallet, order!.token_address, order!.amount_usd));
          const tokens = (await quotesFor(order!.ticker)).filter(isTradable)
            .map((q) => ({ address: q.tokenContractAddress, platform: q.platformId, price: q.tokenPrice }));
          if (!tokens.length) return send(res, 422, { error: `Nobody is trading ${order!.ticker} right now. Try again later.` });
          return send(res, 200, await planSell(wallet, order!.ticker, tokens));
        } catch (e: any) {
          return send(res, 422, { error: e.message ?? String(e) });
        }
      }

      if (req.method === "GET" && url.pathname === "/api/approved") {
        const [wallet, spender, token, amount] = ["wallet", "spender", "token", "amount"].map((k) => url.searchParams.get(k));
        if (!isAddr(wallet) || !isAddr(spender) || !isAddr(token) || !/^\d{1,78}$/.test(amount ?? "")) return send(res, 400, { error: "Bad request." });
        return send(res, 200, { ok: await isApproved(wallet, spender, token, BigInt(amount!)) });
      }

      // The page is about to ask the wallet for the buy. We watch the chain ourselves, because on a phone
      // the page often freezes while the user is in the wallet app and never gets the wallet's answer.
      if (req.method === "POST" && url.pathname === "/api/watch") {
        const { wallet, router, token } = await readJson(req);
        if (!isAddr(wallet) || !isAddr(router) || !isAddr(token)) return send(res, 400, { error: "Bad address." });
        watchForBuy(api, order!, wallet, router, token);
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/sent") {
        const { wallet, txHash } = await readJson(req);
        if (!isAddr(wallet) || !isHash(txHash)) return send(res, 400, { error: "Bad wallet or transaction hash." });
        send(res, 200, { ok: true });
        return finishBuy(api, order!, wallet, txHash);
      }

      send(res, 404, { error: "Not found" });
    } catch (e) {
      console.error("web error", e);
      if (!res.headersSent) send(res, 500, { error: "Server error" });
    }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`web on 127.0.0.1:${PORT}`));
}

// Marks the order as sent, waits for it on-chain, then tells the group. Safe to call twice for the same order.
const finishing = new Set<number>();
async function finishBuy(api: Api, order: TapOrder, wallet: string, txHash: string) {
  if (finishing.has(order.id) || getTapOrder(order.tap_token)?.status !== "pending") return;
  finishing.add(order.id);
  updateTapOrder(order.id, { status: "submitted", txHash, wallet });
  const sell = order.side === "sell";
  // qty = what reached the wallet: stock tokens for a buy, USDT for a sell.
  const r = await confirmBuy(txHash, wallet, sell ? USDT : order.token_address);
  updateTapOrder(order.id, { status: r.ok ? "filled" : "failed", qty: r.qty?.toString(), error: r.error });
  const link = `<a href="https://bscscan.com/tx/${txHash}">BscScan</a>`;
  const name = esc(order.member_name), ticker = esc(order.ticker);
  const text = !r.ok
    ? `❌ ${name}'s ${ticker} ${sell ? "sale" : "buy"} didn't go through: ${esc(r.error ?? "")} · ${link}`
    : sell
      ? `✅ ${name} sold their ${ticker} for ${(r.qty ?? 0).toFixed(2)} USDT (tap to sell) · ${link}`
      : `✅ ${name} bought ${(r.qty ?? 0).toFixed(6)} ${ticker} for $${order.amount_usd} (tap to buy) · ${link}`;
  await api.sendMessage(order.telegram_chat_id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
}

// Every 3 s for up to 30 min: if the wallet sent a new transaction, look for our trade in the new blocks.
// `token` = the stock token being bought or sold; the router call data contains its address.
const watching = new Set<number>();
async function watchForBuy(api: Api, order: TapOrder, wallet: string, router: string, token: string) {
  if (watching.has(order.id)) return;
  watching.add(order.id);
  try {
    let count = await sentCount(wallet), checked = await blockNumber();
    const until = Date.now() + 30 * 60_000;
    while (Date.now() < until && getTapOrder(order.tap_token)?.status === "pending") {
      await new Promise((res) => setTimeout(res, 3000));
      try {
        const [now, head] = [await sentCount(wallet), await blockNumber()];
        if (now > count) {
          const hash = await findBuyTx(wallet, router, token, checked - 2, head);
          if (hash) {
            console.log("watch found buy", order.id, hash);
            return await finishBuy(api, order, wallet, hash);
          }
          count = now; // something else (e.g. the USDT approval)
        }
        checked = head;
      } catch (e: any) { console.error("watch", order.id, e.message); }
    }
  } finally { watching.delete(order.id); }
}
