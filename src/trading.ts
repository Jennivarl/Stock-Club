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
  fromToken: string;      // what the wallet gives (USDT for a buy, the stock token for a sell)
  fromQty: number;
  amountRaw: string;      // fromQty in the token's smallest unit
  expectedQty: number;    // what the wallet gets, about
  minQty: number;         // ...and at least
  spender: string;        // the router that takes fromToken
  approve?: { to: string; data: string; gas: string }; // only if the allowance is too low
  tx: { to: string; data: string; value: string; gas: string };
  balances: { bnb: number; usdt: number };
};

const decimalsCache = new Map<string, number>();
export async function decimals(token: string): Promise<number> {
  const k = token.toLowerCase();
  if (!decimalsCache.has(k)) decimalsCache.set(k, Number(await erc20(token, "0x313ce567"))); // decimals()
  return decimalsCache.get(k)!;
}

export async function tokenBalance(wallet: string, token: string): Promise<{ raw: bigint; qty: number }> {
  const [raw, d] = await Promise.all([erc20(token, "0x70a08231" + pad(wallet)), decimals(token)]);
  return { raw, qty: Number(raw) / 10 ** d };
}

// Asks Binance for a swap route and the transaction to send. Throws a plain-words Error when it can't.
async function planSwap(wallet: string, from: string, to: string, amountRaw: bigint, bal: BuyPlan["balances"]): Promise<BuyPlan> {
  if (bal.bnb < 0.0003) throw new Error(`Your wallet needs a little BNB on BNB Smart Chain for the network fee (has ${bal.bnb.toFixed(5)}).`);
  const base = { binanceChainId: "56", amount: amountRaw.toString(), fromTokenAddress: from, toTokenAddress: to, userWalletAddress: wallet };
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

  // The router needs permission to take the tokens. Approve only this amount, not unlimited.
  const spender = quote.approveTarget ?? tx.to;
  const allowance = await erc20(from, "0xdd62ed3e" + pad(wallet) + pad(spender)); // allowance(owner, spender)
  const approve =
    allowance < amountRaw
      ? { to: from, data: "0x095ea7b3" + pad(spender) + amountRaw.toString(16).padStart(64, "0"), gas: "0x" + (80_000).toString(16) }
      : undefined;

  // Binance's gas limit can be too low: for a bStocks sale it said 250k, the trade needs ~654k and
  // runs out of gas (Oct 10, DX log). Once the allowance is in place, ask the chain and add 25%.
  // (Before the approval the trade can't be simulated, so the page asks for a fresh plan after it.)
  let gas = BigInt(tx.gas ?? 450000);
  if (!approve) {
    const est = await rpc<string>("eth_estimateGas", [{ from: wallet, to: tx.to, data: tx.data, value: "0x" + BigInt(tx.value ?? 0).toString(16) }])
      .then(BigInt)
      .catch(() => { throw new Error("Binance's route for this trade would fail on-chain right now. Nothing was sent. Try again in a few minutes."); });
    if ((est * 5n) / 4n > gas) gas = (est * 5n) / 4n;
  }

  const [dFrom, dTo] = await Promise.all([decimals(from), decimals(to)]);
  return {
    mode: "SWAP",
    vendor: quote.vendorName,
    fromToken: from,
    fromQty: Number(amountRaw) / 10 ** dFrom,
    amountRaw: amountRaw.toString(),
    expectedQty: Number(quote.toTokenAmount) / 10 ** dTo,
    minQty: Number(tx.minReceiveAmount ?? 0) / 10 ** dTo,
    spender,
    approve,
    tx: { to: tx.to, data: tx.data, value: "0x" + BigInt(tx.value ?? 0).toString(16), gas: "0x" + gas.toString(16) },
    balances: bal,
  };
}

export async function planBuy(wallet: string, token: string, usd: number): Promise<BuyPlan> {
  const bal = await balances(wallet);
  if (bal.usdt < usd) throw new Error(`Your wallet has ${bal.usdt.toFixed(2)} USDT on BNB Smart Chain. You need ${usd}.`);
  return planSwap(wallet, USDT, token, BigInt(toWei(usd)), bal);
}

// Sells everything the wallet holds of this stock. `tokens` = the stock's tokens from each issuer, with prices.
// If the wallet holds more than one issuer's token, it sells the one worth the most (one sale per vote).
export const ONDO_MIN_USD = 5; // Trading API: "Minimum order amount is 5 USD" (code 40375)
export async function planSell(wallet: string, ticker: string, tokens: { address: string; platform: string; price: number }[]): Promise<BuyPlan> {
  const held = await Promise.all(tokens.map(async (t) => ({ ...t, ...(await tokenBalance(wallet, t.address)) })));
  const pick = held.filter((h) => h.raw > 0n).sort((a, b) => b.qty * b.price - a.qty * a.price)[0];
  if (!pick) throw new Error(`This wallet doesn't hold any ${ticker}, so there's nothing to sell.`);
  if (pick.platform === "ondo" && pick.qty * pick.price < ONDO_MIN_USD) {
    throw new Error(`Your ${ticker} is worth about $${(pick.qty * pick.price).toFixed(2)}. Ondo only takes sales of $${ONDO_MIN_USD} or more.`);
  }
  return planSwap(wallet, pick.address, USDT, pick.raw, await balances(wallet));
}

// True once the wallet has allowed the router to take this amount of the token.
export async function isApproved(wallet: string, spender: string, token: string, amountRaw: bigint): Promise<boolean> {
  return (await erc20(token, "0xdd62ed3e" + pad(wallet) + pad(spender))) >= amountRaw;
}

export const sentCount = async (wallet: string) => Number(await rpc<string>("eth_getTransactionCount", [wallet, "latest"]));
export const blockNumber = async () => Number(await rpc<string>("eth_blockNumber", []));

// Looks through blocks [from, to] for a tx the wallet sent to the router that trades this token.
// (The public BSC node refuses log searches, so we read the blocks.)
export async function findBuyTx(wallet: string, router: string, token: string, from: number, to: number): Promise<string | undefined> {
  const w = wallet.toLowerCase(), r = router.toLowerCase(), t = token.toLowerCase().replace(/^0x/, "");
  for (let b = from; b <= to; b++) {
    const block: any = await rpc("eth_getBlockByNumber", ["0x" + b.toString(16), true]);
    const tx = (block?.transactions ?? []).find((x: any) =>
      x.from?.toLowerCase() === w && x.to?.toLowerCase() === r && String(x.input).toLowerCase().includes(t));
    if (tx) return tx.hash;
  }
  return undefined;
}

export async function receiptStatus(txHash: string): Promise<string | null> {
  const r: any = await rpc("eth_getTransactionReceipt", [txHash]).catch(() => null);
  return r?.status ?? null; // "0x1" ok, "0x0" failed, null = not mined yet
}

// Waits for the tx, then reads how much of `token` reached the wallet from the Transfer logs
// (the stock token for a buy, USDT for a sell).
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
