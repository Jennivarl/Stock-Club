// WalletConnect on the SERVER, not in the phone's browser.
// On iPhone, Telegram pauses the Mini App while you're in the Binance app, its WalletConnect socket
// drops, and Binance's answer is lost (DX log, Oct 10). Our server never sleeps, so it holds the
// connection: it makes the pairing link, waits for Binance's approval, and sends the transactions.
// The page only shows buttons and opens Binance.
import fs from "node:fs";
import path from "node:path";
import { SignClient } from "@walletconnect/sign-client";

const BINANCE_UNIVERSAL = "https://app.binance.com/cedefi"; // WalletConnect wallet directory, checked Oct 8
const CHAIN = "eip155:56";
const TOPICS_FILE = path.resolve("data/wc-topics.json"); // telegram user id -> session topic

type Client = Awaited<ReturnType<typeof SignClient.init>>;
let clientP: Promise<Client> | undefined;

function client(): Promise<Client> {
  clientP ??= SignClient.init({
    projectId: process.env.WALLETCONNECT_PROJECT_ID,
    metadata: {
      name: "Stock Club",
      description: "Buy tokenized stocks with your friends",
      url: process.env.WEB_URL ?? "https://164-90-183-99.sslip.io",
      icons: [],
    },
    storageOptions: { database: path.resolve("data/walletconnect.db") },
  }).then((c) => {
    c.on("session_delete", ({ topic }) => forgetTopic(topic));
    c.on("session_expire", ({ topic }) => forgetTopic(topic));
    return c;
  });
  return clientP;
}

const readTopics = (): Record<string, string> => {
  try { return JSON.parse(fs.readFileSync(TOPICS_FILE, "utf8")); } catch { return {}; }
};
const writeTopics = (t: Record<string, string>) => fs.writeFileSync(TOPICS_FILE, JSON.stringify(t));
function forgetTopic(topic: string) {
  const t = readTopics();
  for (const k of Object.keys(t)) if (t[k] === topic) delete t[k];
  writeTopics(t);
}

// The member's live session, if any: { topic, address }.
export async function sessionOf(telegramUserId: number): Promise<{ topic: string; address: string } | undefined> {
  const topic = readTopics()[telegramUserId];
  if (!topic) return undefined;
  const c = await client();
  const s = c.session.getAll().find((x) => x.topic === topic);
  if (!s || s.expiry * 1000 < Date.now()) return undefined;
  const acct = s.namespaces.eip155?.accounts.find((a) => a.startsWith(CHAIN + ":"));
  return acct ? { topic, address: acct.split(":")[2] } : undefined;
}

export async function disconnect(telegramUserId: number) {
  const s = await sessionOf(telegramUserId);
  if (s) await (await client()).disconnect({ topic: s.topic, reason: { code: 6000, message: "User disconnected" } }).catch(() => {});
  const t = readTopics(); delete t[telegramUserId]; writeTopics(t);
}

// A pairing link per member, made ahead of time so the page can open Binance right on the tap
// (Telegram on iOS only opens other apps straight from a tap). Pairing links last 5 minutes.
const pairings = new Map<number, { link: string; at: number; status: "waiting" | "approved" | "failed"; error?: string }>();

export async function pairingLink(telegramUserId: number): Promise<string> {
  const p = pairings.get(telegramUserId);
  if (p && p.status === "waiting" && Date.now() - p.at < 4 * 60_000) return p.link;
  const c = await client();
  const { uri, approval } = await c.connect({
    optionalNamespaces: { eip155: { chains: [CHAIN], methods: ["eth_sendTransaction"], events: ["accountsChanged", "chainChanged"] } },
  });
  if (!uri) throw new Error("WalletConnect didn't give a pairing link.");
  const entry = { link: `${BINANCE_UNIVERSAL}/wc?uri=${encodeURIComponent(uri)}`, at: Date.now(), status: "waiting" as const };
  pairings.set(telegramUserId, entry);
  approval()
    .then((s) => {
      const t = readTopics(); t[telegramUserId] = s.topic; writeTopics(t);
      if (pairings.get(telegramUserId) === entry) pairings.set(telegramUserId, { ...entry, status: "approved" });
      console.log("wc connected", telegramUserId);
    })
    .catch((e) => {
      if (pairings.get(telegramUserId) === entry) pairings.set(telegramUserId, { ...entry, status: "failed", error: e?.message });
      console.log("wc pairing ended", telegramUserId, e?.message);
    });
  return entry.link;
}

export const pairingStatus = (telegramUserId: number) => pairings.get(telegramUserId)?.status;

// Sends one transaction to the member's wallet.
// `link` opens Binance on this exact request. WalletConnect's own format (sign-client opens it itself when it
// runs in a browser): <wallet link>/wc?requestId=<id>&sessionTopic=<topic>. Opening the bare
// https://app.binance.com/cedefi instead makes Binance show "QR code expired" (Oct 10).
// `result` resolves with the tx hash or rejects with the wallet's error; it can take minutes.
export async function sendTransaction(telegramUserId: number, tx: Record<string, string>): Promise<{ link: string; result: Promise<string> }> {
  const s = await sessionOf(telegramUserId);
  if (!s) throw new Error("Wallet not connected");
  const c = await client();
  // sign-client tells us the request id right after it publishes the request.
  const sent = new Promise<number>((resolve, reject) => {
    const on = (e: { topic: string; id: number }) => { if (e.topic === s.topic) { c.events.off("session_request_sent", on); resolve(e.id); } };
    c.events.on("session_request_sent", on);
    setTimeout(() => { c.events.off("session_request_sent", on); reject(new Error("WalletConnect didn't send the request.")); }, 20_000);
  });
  const result = c.request<string>({
    topic: s.topic,
    chainId: CHAIN,
    request: { method: "eth_sendTransaction", params: [{ from: s.address, ...tx }] },
  });
  result.catch(() => {}); // the caller handles it; don't crash on an unhandled rejection meanwhile
  const id = await Promise.race([sent, result.then(() => { throw new Error("answered before sent"); })]);
  return { link: `${BINANCE_UNIVERSAL}/wc?requestId=${id}&sessionTopic=${s.topic}`, result };
}
