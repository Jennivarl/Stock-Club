<p align="center"><img src="public/assets/logo-telegram-1024.png" width="120" alt="Stock Club logo" /></p>

<h1 align="center">Stock Club</h1>
<p align="center"><b>Trade tokenized stocks with friends, right inside Telegram. Even when Wall Street sleeps.</b></p>
<p align="center">
  <a href="https://t.me/stockclubhqbot">Telegram bot</a> ·
  <a href="https://t.me/stockclubhqbot/app">Mini App</a> ·
  <a href="https://stockclubhq.xyz">Website</a>
</p>

Built for **BNB Hack: Tokenized Stocks Edition**, on **BNB Chain** with the **Binance Web3 API** (RWA Data + Trading) and the **Binance Agentic Wallet**.

---

## The idea

Every Friday at 4 PM, the US stock market closes until Monday. But tokenized stocks (real shares like Nvidia or Tesla, issued as tokens on BNB Chain by **bStocks** and **Ondo**) keep trading. While Wall Street sleeps, the token price drifts away from the last real price. We call that difference **the gap**.

Stock Club shows the gap for every stock, and lets a group of friends **decide together and buy together**, where each person always buys in **their own wallet**. Nobody holds anyone else's money.

## What it does

**In a Telegram group (the club)**
- **Propose → vote → buy.** Someone proposes "buy $10 of NVDA each" (or "sell NVDA"). The group votes in a Telegram poll.
- **Rules are checked twice**: when the vote starts and again right before anyone trades: max per trade, max per week, vote threshold, **max gap vs the real price**, and max price difference between issuers.
- **Everyone trades in their own wallet**, one of two ways:
  - **Tap to buy/sell:** the bot sends each yes-voter a button; they confirm in their own Binance Wallet (WalletConnect).
  - **Autopilot:** the bot buys or sells automatically from the member's own **Binance Agentic Wallet**, within the spending limit they set in the Binance app.
- **Alerts:** "tell us when NVDA's gap goes over 1%" or "when TSLA goes above $400". The bot posts in the group when it happens.

**In the Mini App (Telegram) and on the website**
- **Markets:** live on-chain prices for tracked stocks, % change, the **gap vs the real stock**, a Wall Street open/closed status with a countdown, and top movers.
- **Stock page:** on-chain **candlestick charts** (1H / 4H / since launch) with **MA 20 / MA 50 / RSI**; a **gap view** (on-chain vs real price, closed-market hours shaded); next **earnings date**; **news**; **depth** (what a $100 / $1,000 / $10,000 buy really costs); prices from each issuer.
- **All 448 tokenized stocks** on BNB Chain, searchable.
- **Trade with your club or solo** (solo = buy/sell right away, same safety checks).
- **Paper trading, free:** $1,000 of pretend USDT, no wallet or login needed. Paper trades fill at the live on-chain price after the same market checks as a real trade (issuer open, Ondo minimum, max gap, issuer spread), and the Portfolio tab shows your paper profit/loss. Nothing real is bought; the paper account is saved on your device.
- **Portfolio**, **club rules editor** (creator only), **Autopilot** connect/on/off.
- **Onboarding** for complete beginners: 3 short intro screens, a checklist that reads your real balances, a "New to Binance?" guide, and a guided first $1 trade.
- **Website login with Telegram** (stockclubhq.xyz), so it also works on a big screen.

## How Binance tools are used

| Tool | Where | What for |
|---|---|---|
| **RWA Data API** `/rwa/tokens`, `/rwa/price`, `/rwa/kline` | `src/rwa.ts`, `src/tools.ts`, `src/appapi.ts` | Token list for 448 stocks (bStocks + Ondo), live per-share prices, market status (open / closed / weekend), logos, and on-chain candles |
| **Trading API** `/aggregator/quote`, `/aggregator/swap` | `src/trading.ts`, `src/tools.ts` | Builds each buy/sell transaction for the member's own wallet (exact-amount approvals); price-impact "depth" quotes |
| **Agentic Wallet** (`baw` CLI) | `src/autopilot.ts` | Autopilot: per-member sign-in, balance, and automatic market-order buys/sells after a vote passes |
| **BNB Chain** (BSC RPC) | `src/trading.ts`, `src/web.ts` | Balances, allowances, gas estimates, and confirming every trade on-chain before reporting it |

Real stock prices come from **Finnhub** (free plan). Wallet connection uses **WalletConnect / Reown AppKit**.

## Proof: real trades on BNB Chain

| What | Transaction |
|---|---|
| Autopilot buy (Agentic Wallet), NVDA $1 | [0xe88bcef5…2060e](https://bscscan.com/tx/0xe88bcef50d8ad3ad2860a6267d1eb75d3029fd865bd678c6b2386d71abb2060e) |
| Tap to buy from Telegram on iPhone, NVDA $1 | [0x1c737de2…4ecce5](https://bscscan.com/tx/0x1c737de240f39040dae8a317d16199251c8600abfa2ed8abccda62f7ef4ecce5) |
| Tap to sell, NVDA → 1.00 USDT | [0x4181f731…db287e1](https://bscscan.com/tx/0x4181f731d25bdce9b12768071978471090a3bc916155c8785064debd9db287e1) |
| Autopilot sell, NVDA → 1.94 USDT | [0x9a01e109…a5ef8822](https://bscscan.com/tx/0x9a01e109365d888e76011056ff033c7efca15f90f6b94c1a36dfdcc3a5ef8822) |

## Try it

**Try it for free (no wallet, no money, no login):** open **[stockclubhq.xyz](https://stockclubhq.xyz)** or the bot's Mini App, tap **Start paper trading** on Markets (or pick **Paper** under *Trade* on any stock), and buy or sell with $1,000 of pretend USDT at live on-chain prices. Your paper portfolio is in the **Portfolio** tab → **Paper**.

**Real trades** need Telegram, the Binance app, and a little **USDT + BNB on BNB Smart Chain** (a few dollars is plenty; trades work from $1).

1. Open **[@stockclubhqbot](https://t.me/stockclubhqbot)** and press **Start**. Tap **Open Stock Club** to see the intro, the markets, the gap and the charts (no money needed for this part).
2. **Make a club:** tap **Add me to a group**, pick or create a group, then tap **Start a club here** in the group. Friends tap **Join the club**.
3. **Propose a trade:** in the group tap **Propose a buy**, open a stock (e.g. NVDA), pick $1, and tap **Propose: buy $1 each**. Vote **Yes** in the poll.
4. When the vote passes, the bot sends you a **Buy** button. Connect your **Binance Wallet** and confirm. The result is posted in the group with a BscScan link.
5. **Optional, Autopilot:** in the app's **Club** tab tap **Connect Agentic Wallet** and approve in the Binance app. Next time your club votes yes, the bot buys for you automatically.
6. **Solo:** on any stock page, switch **Trade** to **Solo** and tap **Buy $1 now**.
7. **Website:** open **[stockclubhq.xyz](https://stockclubhq.xyz)** and **Log in with Telegram**.

Useful group commands: `/propose NVDA 10`, `/propose sell NVDA`, `/alert NVDA gap 1`, `/alerts`, `/rules`, `/price NVDA`, `/stop` (pause the club).

## How it works

```
Telegram group ──► Bot (grammY, Node 22) ──► Binance Web3 API (RWA Data + Trading)
      │                    │                          │
      │                    ├──► Finnhub (real stock prices)
      │                    ├──► SQLite (clubs, rules, votes, orders, alerts)
      │                    └──► baw CLI ──► Binance Agentic Wallet (Autopilot)
      ▼
Mini App / website (stockclubhq.xyz) ──► WalletConnect ──► member's Binance Wallet
      │                                                         │
      └────────────── server watches BNB Chain and confirms every trade ◄──┘
```

- **Non-custodial by design.** Stock Club never holds keys or funds. Tap trades are signed in the member's wallet; Autopilot trades run in the member's own Agentic Wallet under their own Binance spending limit.
- **Exact-amount approvals** (never unlimited).
- **The chain is the source of truth.** Every trade is confirmed by reading the transaction receipt and token transfers on BNB Chain before it's reported.
- **Mobile-proof wallet flow.** iOS pauses the Telegram Mini App while you're in the Binance app; the page hangs up its WalletConnect connection when hidden and reconnects when visible, and the server independently watches the chain for the trade.
- **Price-gap logger** (`scripts/gap-logger.mjs`) records on-chain and real prices every 15 minutes; this powers the gap charts.

## Run it yourself

Requirements: Node.js 22+, a Telegram bot token, Binance Web3 API keys, a Finnhub key, a Reown (WalletConnect) project id, and a public HTTPS domain.

```bash
npm install
cp .env.example .env          # fill in the values
npm run build:web             # bundles the wallet connector into public/wallet.js
npm run build                 # TypeScript → dist/
npm start                     # bot + web server on 127.0.0.1:8080
```

Put a reverse proxy with HTTPS in front (see `deploy/Caddyfile`). In @BotFather: create the Mini App with `/newapp` (short name `app`, URL `https://<your-domain>/app`) and set the login domain with `/setdomain`. Add your domain to the Reown project allowlist.

Optional: run `node scripts/gap-logger.mjs` (e.g. as a service) to record the price history used by the gap charts. For Autopilot, install the Binance Agentic Wallet CLI (`baw`) and set `BINANCE_INSTANCE_ID`.

## Project structure

```
src/
  bot.ts         Telegram bot: clubs, proposals, polls, alerts, Autopilot, welcome
  proposals.ts   Rules, market checks, vote closing, buying/selling for each member
  trading.ts     Trading API quotes/swaps, approvals, gas, on-chain confirmation
  autopilot.ts   Binance Agentic Wallet (baw) sign-in, buy, sell
  rwa.ts         RWA Data API: tokens, prices, market status
  tools.ts       Candles, news + earnings, price impact, full stock list
  appapi.ts      Mini App / website API (Telegram login check, markets, portfolio, rules, solo, paper quotes)
  alerts.ts      Club alerts
  web.ts         HTTP server: Mini App, Buy/Sell page, chain watcher
  db.ts          SQLite schema and queries
  card.ts, stocks.ts, binance.ts   Price card, Finnhub, signed Binance requests
public/
  app.html       The Mini App / website
  buy.html       Buy/Sell page (WalletConnect)
  assets/        Logo, banner
web/wallet.ts    WalletConnect (Reown AppKit) connector, bundled to public/wallet.js
scripts/         gap-logger.mjs (price history), fake-baw.mjs (offline Autopilot test double)
deploy/          Caddyfile
```

## Known limits

- **Binance Wallet shows a "High-Risk" warning** on the USDT approval step because the Trading API's router contract is shown as unverified in the wallet. The approval is for the exact trade amount only.
- **Ondo tokens close on weekends** (Binance reports "Weekend or Holiday"); bStocks tokens trade 24/7. Stock Club shows the status and the next opening time.
- **Some networks block WalletConnect or Binance domains.** The Mini App routes its WalletConnect traffic through our server; the Binance app itself may still need a VPN on those networks.
- Real-price history (for the gap charts) covers the 15 stocks we record; on-chain candles cover every token.
