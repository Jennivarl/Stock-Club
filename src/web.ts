// Web server for the Telegram Mini App "Buy" page. Caddy serves it over HTTPS in front of this.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Api } from "grammy";
import { getTapOrder, updateTapOrder } from "./db.js";
import { confirmBuy, planBuy, receiptStatus } from "./trading.js";

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
          token: order!.token_address, platform: order!.platform, txHash: order!.tx_hash,
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
          return send(res, 200, await planBuy(wallet, order!.token_address, order!.amount_usd));
        } catch (e: any) {
          return send(res, 422, { error: e.message ?? String(e) });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/sent") {
        if (order!.status !== "pending") return send(res, 409, { error: `This buy is already ${order!.status}.` });
        const { wallet, txHash } = await readJson(req);
        if (!isAddr(wallet) || !isHash(txHash)) return send(res, 400, { error: "Bad wallet or transaction hash." });
        updateTapOrder(order!.id, { status: "submitted", txHash, wallet });
        send(res, 200, { ok: true });
        // Confirm on-chain in the background, then tell the group.
        const r = await confirmBuy(txHash, wallet, order!.token_address);
        updateTapOrder(order!.id, { status: r.ok ? "filled" : "failed", qty: r.qty?.toString(), error: r.error });
        const link = `<a href="https://bscscan.com/tx/${txHash}">BscScan</a>`;
        const text = r.ok
          ? `✅ ${esc(order!.member_name)} bought ${(r.qty ?? 0).toFixed(6)} ${esc(order!.ticker)} for $${order!.amount_usd} (tap to buy) · ${link}`
          : `❌ ${esc(order!.member_name)}'s ${esc(order!.ticker)} buy didn't go through: ${esc(r.error ?? "")} · ${link}`;
        await api.sendMessage(order!.telegram_chat_id, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
        return;
      }

      send(res, 404, { error: "Not found" });
    } catch (e) {
      console.error("web error", e);
      if (!res.headersSent) send(res, 500, { error: "Server error" });
    }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`web on 127.0.0.1:${PORT}`));
}
