// Wallet connection for the Buy page, using Reown AppKit (WalletConnect's official modal).
// Reown says AppKit works in Telegram Mini Apps out of the box. Bundled with esbuild into public/wallet.js.
import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { bsc } from "@reown/appkit/networks";

// Binance Wallet's id in the WalletConnect wallet directory (explorer API, checked Oct 8).
const BINANCE_WALLET_ID = "8a0ee50d1f22f6651afcae7eb4253e52a3310b90af5daef78a8c4929a9bb99d4";

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<any> };

export function initWallet(projectId: string, onAccount: (address: string | undefined) => void, onEvent?: (name: string) => void) {
  const modal = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [bsc],
    defaultNetwork: bsc,
    projectId,
    metadata: { name: "Stock Club", description: "Buy tokenized stocks with your friends", url: location.origin, icons: [] },
    featuredWalletIds: [BINANCE_WALLET_ID],
    features: { email: false, socials: false, swaps: false, onramp: false, analytics: false },
  });
  modal.subscribeAccount((s) => onAccount(s.isConnected ? s.address : undefined));
  // AppKit's own events (CONNECT_SUCCESS, CONNECT_ERROR, ...), for our debug log.
  modal.subscribeEvents((e: any) => onEvent?.(`${e?.data?.event ?? "?"} ${JSON.stringify(e?.data?.properties ?? {}).slice(0, 150)}`));

  // Remember the last request, to build the same link WalletConnect opens for it:
  // bnc://app.binance.com/cedefi/wc?requestId=<id>&sessionTopic=<topic> (Binance's native link).
  // NOT https://app.binance.com/cedefi: that's Binance's "Link Mode" link and shows "QR code expired" (Oct 10).
  let lastRequest: { id: number; topic: string } | undefined;
  modal.getUniversalProvider().then((up: any) => {
    up?.client?.events?.on("session_request_sent", (e: { id: number; topic: string }) => { lastRequest = { id: e.id, topic: e.topic }; });
  }).catch(() => {});

  return {
    open: () => modal.open(),
    requestLink: () => lastRequest
      ? `bnc://app.binance.com/cedefi/wc?requestId=${lastRequest.id}&sessionTopic=${lastRequest.topic}`
      : "bnc://app.binance.com/cedefi/",
    disconnect: () => modal.disconnect(),
    async send(tx: Record<string, string>): Promise<string> {
      const provider = modal.getWalletProvider() as Eip1193 | undefined;
      if (!provider) throw new Error("Wallet not connected");
      return provider.request({ method: "eth_sendTransaction", params: [tx] });
    },
  };
}

(window as any).SCWallet = { initWallet };
