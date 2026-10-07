// Autopilot: buys for a member through their own Binance Agentic Wallet, using the `baw` CLI.
// Each member gets their own session folder (BINANCE_BAW_DIR). This only stays separate when the
// OS keychain is unavailable (true on our Linux server: keytar can't load), see DX log.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";

const BAW_BIN = process.env.BAW_BIN ?? "/opt/stock-club/tools/node_modules/.bin/baw";
const BAW_ROOT = process.env.BAW_ROOT ?? "/opt/stock-club/baw";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const BSC = "56";

export const autopilotAvailable = () => fs.existsSync(BAW_BIN) && Boolean(process.env.BINANCE_INSTANCE_ID);

type BawResult = { success: boolean; data?: any; error?: { code?: number; name?: string; message?: string } };

function memberDir(telegramUserId: number): string {
  const dir = path.join(BAW_ROOT, String(telegramUserId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Runs one baw command for one member. Never throws: errors come back as { success: false }.
function baw(telegramUserId: number, args: string[], timeoutMs = 60_000): Promise<BawResult> {
  return new Promise((resolve) => {
    // A .mjs BAW_BIN is a fake CLI for tests; run it with node.
    const [cmd, pre] = BAW_BIN.endsWith(".mjs") ? [process.execPath, [BAW_BIN]] : [BAW_BIN, []];
    const child = spawn(cmd, [...pre, ...args, "--json"], {
      env: {
        ...process.env,
        BINANCE_BAW_DIR: memberDir(telegramUserId),
        BINANCE_INSTANCE_ID: process.env.BINANCE_INSTANCE_ID,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out));
      } catch {
        resolve({ success: false, error: { message: (err || out || "no output").trim().slice(0, 300) } });
      }
    });
  });
}

const errText = (r: BawResult) => r.error?.message ?? r.error?.name ?? "unknown error";

// One buy at a time on the whole server: each baw run is a Node process (~60-100 MB) and we have 1 GB.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export async function isConnected(telegramUserId: number): Promise<boolean> {
  const r = await baw(telegramUserId, ["wallet", "status"]);
  return r.success && r.data?.status === "CONNECTED";
}

export async function walletInfo(telegramUserId: number) {
  const [addr, settings, bal] = await Promise.all([
    baw(telegramUserId, ["wallet", "address"]),
    baw(telegramUserId, ["wallet", "settings"]),
    baw(telegramUserId, ["wallet", "balance", "--binanceChainId", BSC]),
  ]);
  const bsc = (addr.data?.addresses ?? []).find((a: any) => a.binanceChainId === BSC)?.address as string | undefined;
  const usdt = (bal.data ?? []).find((t: any) => t.address?.toLowerCase() === USDT.toLowerCase())?.balance as string | undefined;
  const bnb = (bal.data ?? []).find((t: any) => t.symbol === "BNB")?.balance as string | undefined;
  return { address: bsc, usdt: Number(usdt ?? 0), bnb: Number(bnb ?? 0), settings: settings.data };
}

// Sign-in: returns the link + code to show the member. Then call waitForSignin.
export async function startSignin(
  telegramUserId: number,
): Promise<{ url: string; code: string; qrCodeId: string } | { already: true } | { error: string }> {
  const r = await baw(telegramUserId, ["auth", "signin"]);
  if (!r.success) return { error: errText(r) };
  if (r.data?.status === "ALREADY_CONNECTED") return { already: true };
  return { url: r.data.urlForWeb, code: r.data.pairingCode, qrCodeId: r.data.qrCodeId };
}

// Blocks until the member approves in the Binance App (or ~5 min timeout).
export async function waitForSignin(telegramUserId: number, qrCodeId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await baw(telegramUserId, ["auth", "verify", "--qrCodeId", qrCodeId], 330_000);
  if (!r.success) return { ok: false, error: errText(r) };
  return { ok: await isConnected(telegramUserId) };
}

export function signout(telegramUserId: number) {
  return baw(telegramUserId, ["auth", "signout"]);
}

export type BuyResult = {
  status: "filled" | "failed" | "submitted" | "skipped";
  txHash?: string;
  qty?: string;
  returnedOrderId?: string;
  realOrderId?: string;
  error?: string;
};

// Buys `usd` USDT worth of `token` for one member and waits for a final status.
// We do NOT trust the orderId that `market-order swap` returns: on Oct 7 it returned an id that
// `market-order list --orderId` never found (DX log). So we also match recent orders by token + time.
export function buy(telegramUserId: number, token: string, usd: number): Promise<BuyResult> {
  return serial(async () => {
    if (!(await isConnected(telegramUserId))) {
      return { status: "skipped", error: "Autopilot isn't connected (the login may have expired). Send /autopilot to me in a private chat." };
    }
    const startedAt = Date.now();
    const r = await baw(telegramUserId, [
      "market-order", "swap",
      "--fromTokenQty", String(usd),
      "--fromToken", USDT,
      "--toToken", token,
      "--binanceChainId", BSC,
      "--slippage", "1",
    ]);
    if (!r.success) return { status: "failed", error: errText(r) };
    const returnedOrderId = String(r.data?.orderId ?? "");

    const claimed = new Set(
      (db.prepare("SELECT real_order_id FROM orders WHERE real_order_id IS NOT NULL").all() as { real_order_id: string }[]).map(
        (x) => x.real_order_id,
      ),
    );
    for (let i = 0; i < 15; i++) {
      await new Promise((res) => setTimeout(res, 4000));
      // 1) The documented way: look up the returned orderId.
      let order: any;
      if (returnedOrderId) {
        const byId = await baw(telegramUserId, ["market-order", "list", "--orderId", returnedOrderId]);
        order = byId.data?.list?.[0];
      }
      // 2) Fallback: newest order for this token, booked after we started, not already matched to another buy.
      if (!order) {
        const recent = await baw(telegramUserId, ["market-order", "list", "--binanceChainId", BSC, "--toToken", token, "--pageSize", "10"]);
        order = (recent.data?.list ?? []).find(
          (o: any) => !claimed.has(o.orderId) && new Date(o.bookTime).getTime() >= startedAt - 15_000,
        );
      }
      if (order?.status === "FINISHED") {
        return { status: "filled", txHash: order.txHash, qty: order.toTokenActualQty, returnedOrderId, realOrderId: order.orderId };
      }
      if (order?.status === "FAILED") {
        return { status: "failed", txHash: order.txHash ?? undefined, returnedOrderId, realOrderId: order.orderId, error: "The order failed on-chain." };
      }
    }
    return { status: "submitted", returnedOrderId, error: "Submitted, but not confirmed after 60 s. It may still be processing." };
  });
}
