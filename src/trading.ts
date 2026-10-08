// "Tap to buy": builds the buy for the member's own wallet with the Binance Trading API.
// The member signs and sends it themselves; we never hold keys or money.
import { signedGet } from "./binance.js";

export const USDT = "0x55d398326f99059fF775485246999027B3197955";
const RPC = process.env.BSC_RPC ?? "https://bsc-dataseed.bnbchain.org";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const toWei = (usd: number) => (BigInt(Math.round(usd * 1e6)) * 10n ** 12n).toString(); // USDT on BSC has 18 decimals
const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await r.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

async function erc20(token: string, data: string): Promise<bigint> {
  return BigInt(await rpc<string>("eth_call", [{ to: token, data }, "latest"]));
}

export async function balances(wallet: string) {
  const [bnb, usdt] = await Promise.all([
    rpc<string>("eth_getBalance", [wallet, "latest"]).then(BigInt),
    erc20(USDT, "0x70a08231" + pad(wallet)), // balanceOf
  ]);
  return { bnb: Number(bnb) / 1e18, usdt: Number(usdt) / 1e18 };
}

export type BuyPlan = {
  mode: "SWAP";
  vendor: string;
  expectedQty: number;
  minQty: number;
  approve?: { to: string; data: string; gas: string }; // only if USDT allowance is too low
  tx: { to: string; data: string; value: string; gas: string };
  balances: { bnb: number; usdt: number };
};

// Returns what the wallet must send. Throws a plain-words Error when it can't buy.
export async function planBuy(wallet: string, token: string, usd: number): Promise<BuyPlan> {
  const amount = toWei(usd);
  const base = { binanceChainId: "56", amount, fromTokenAddress: USDT, toTokenAddress: token, userWalletAddress: wallet };
  const bal = await balances(wallet);
  if (bal.usdt < usd) throw new Error(`Your wallet has ${bal.usdt.toFixed(2)} USDT on BNB Smart Chain. You need ${usd}.`);
  if (bal.bnb < 0.0003) throw new Error(`Your wallet needs a little BNB on BNB Smart Chain for the network fee (has ${bal.bnb.toFixed(5)}).`);

  const q: any = await signedGet("/api/v1/dex/aggregator/quote", base);
  const quotes: any[] = q.data ?? [];
  // bStocks came back as normal SWAP routes in our tests, even though the docs say equity tokens use RFQ.
  const quote = quotes.find((x) => x.executionMode === "SWAP");
  if (!quote) {
    const modes = quotes.map((x) => `${x.vendorName}/${x.executionMode}`).join(", ") || "none";
    throw new Error(`Binance only offered a route I can't use yet (${modes}). Try again later.`);
  }
  const s: any = await signedGet("/api/v1/dex/aggregator/swap", { ...base, quoteId: quote.quoteId, slippagePercent: "1" });
  const tx = s.data?.tx;
  if (s.data?.executionMode !== "SWAP" || !tx?.to || !tx?.data) throw new Error("Binance didn't return a transaction to send. Try again.");

  // The router needs permission to take the USDT. Approve only this buy's amount, not unlimited.
  const spender = quote.approveTarget ?? tx.to;
  const allowance = await erc20(USDT, "0xdd62ed3e" + pad(wallet) + pad(spender)); // allowance(owner, spender)
  const approve =
    allowance < BigInt(amount)
      ? { to: USDT, data: "0x095ea7b3" + pad(spender) + BigInt(amount).toString(16).padStart(64, "0"), gas: "0x" + (80_000).toString(16) }
      : undefined;

  return {
    mode: "SWAP",
    vendor: quote.vendorName,
    expectedQty: Number(quote.toTokenAmount) / 1e18,
    minQty: Number(tx.minReceiveAmount ?? 0) / 1e18,
    approve,
    tx: { to: tx.to, data: tx.data, value: "0x" + BigInt(tx.value ?? 0).toString(16), gas: "0x" + BigInt(tx.gas ?? 450000).toString(16) },
    balances: bal,
  };
}

export async function receiptStatus(txHash: string): Promise<string | null> {
  const r: any = await rpc("eth_getTransactionReceipt", [txHash]).catch(() => null);
  return r?.status ?? null; // "0x1" ok, "0x0" failed, null = not mined yet
}

// Waits for the buy tx, then reads how many stock tokens reached the wallet from the Transfer logs.
export async function confirmBuy(txHash: string, wallet: string, token: string, timeoutMs = 120_000): Promise<{ ok: boolean; qty?: number; error?: string }> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r: any = await rpc("eth_getTransactionReceipt", [txHash]).catch(() => null);
    if (r) {
      if (r.status !== "0x1") return { ok: false, error: "The transaction failed on-chain." };
      const got = (r.logs ?? [])
        .filter((l: any) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === "0x" + pad(wallet))
        .reduce((sum: bigint, l: any) => sum + BigInt(l.data), 0n);
      return { ok: true, qty: Number(got) / 1e18 };
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return { ok: false, error: "Not confirmed after 2 minutes. Check BscScan." };
}
