import crypto from "node:crypto";
import "dotenv/config";

const HOST = "https://web3.binance.com";
const PREFIX = "/build"; // must be part of the signed path (docs: "Base URL = https://web3.binance.com/build")

const API_KEY = process.env.BINANCE_API_KEY ?? "";
const API_SECRET = process.env.BINANCE_API_SECRET ?? "";

// Signed GET. Signature = Base64(HMAC-SHA256(timestamp + method + pathWithQuery + body, secret)).
export async function signedGet<T = any>(path: string, params: Record<string, string> = {}): Promise<T> {
  if (!API_KEY || !API_SECRET) throw new Error("Missing BINANCE_API_KEY / BINANCE_API_SECRET in .env");

  const query = new URLSearchParams(params).toString();
  const pathWithQuery = PREFIX + path + (query ? `?${query}` : "");
  const timestamp = new Date().toISOString();
  const sign = crypto.createHmac("sha256", API_SECRET).update(timestamp + "GET" + pathWithQuery, "utf8").digest("base64");

  const res = await fetch(HOST + pathWithQuery, {
    headers: { "X-OC-APIKEY": API_KEY, "X-OC-TIMESTAMP": timestamp, "X-OC-SIGN": sign },
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}, not JSON: ${text.slice(0, 300)}`);
  }
  if (!res.ok || json.success === false || (json.code !== 0 && json.code !== "0")) {
    throw new Error(`HTTP ${res.status}, code ${json.code}: ${json.msg ?? text.slice(0, 300)}`);
  }
  return json;
}

// Free public list (no key). type: 1 = Ondo, 2 = xStocks, 3 = bStocks. Mixed chains, so filter BSC.
export async function publicStockList(type: 1 | 2 | 3) {
  const url = `https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/rwa/stock/detail/list/ai?type=${type}`;
  const json: any = await (await fetch(url)).json();
  return (json.data as any[]).filter((t) => t.chainId === "56");
}
