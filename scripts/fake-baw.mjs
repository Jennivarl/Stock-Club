// Fake `baw` for offline tests. Mimics what we saw on Oct 7: swap returns an orderId that
// `market-order list --orderId` can't find; the real order shows up in the plain list.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dir = process.env.BINANCE_BAW_DIR;
const state = path.join(dir, "fake.json");
const s = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, "utf8")) : { connected: dir.endsWith("111"), orders: [] };
const save = () => fs.writeFileSync(state, JSON.stringify(s));
const out = (o) => console.log(JSON.stringify(o));
const cmd = args.slice(0, 2).join(" ");
const opt = (k) => args[args.indexOf(k) + 1];

if (cmd === "wallet status") out({ success: true, data: { status: s.connected ? "CONNECTED" : "UNCONNECTED" } });
else if (cmd === "market-order swap") {
  const real = String(Date.now()) + "49";
  s.orders.unshift({ orderId: real, toToken: opt("--toToken"), status: "FINISHED", txHash: "0xfeed" + real, toTokenActualQty: "0.0421", bookTime: new Date().toISOString() });
  save();
  out({ success: true, data: { orderId: String(Date.now()) + "10" } }); // wrong id, like Binance did
} else if (cmd === "market-order list") {
  if (args.includes("--orderId")) out({ success: true, data: { total: 0, list: [] } });
  else out({ success: true, data: { total: s.orders.length, list: s.orders.filter((o) => !args.includes("--toToken") || o.toToken === opt("--toToken")) } });
} else out({ success: false, error: { message: "fake: unsupported " + cmd } });
