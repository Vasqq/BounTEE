// The wallet picker's list (D34, ADR-0022): only wallets that can sign everything a Protocol
// signs. Rabby and Brave Wallet are RainbowKit's own entries; MetaMask and Zerion are built here
// with RainbowKit's custom-wallet API, each from RainbowKit's stock entry's details (name, icon,
// download links, instructions) with its own connector:
// - MetaMask: the stock entry's MetaMask SDK calls the wallet when the config is created, and a
//   stock WalletConnect connector contacts WalletConnect then, where a signing page asks nothing
//   of a wallet before a click (D13) and contacts WalletConnect only once one is picked (D36).
// - Zerion: extension only. The stock entry falls back to WalletConnect for Zerion's phone app,
//   which ADR-0022 doesn't list.
import { getWalletConnectConnector, type Wallet, type WalletList } from "@rainbow-me/rainbowkit";
import { braveWallet, metaMaskWallet, rabbyWallet, zerionWallet } from "@rainbow-me/rainbowkit/wallets";
import { createConnector } from "wagmi";
import { injected } from "wagmi/connectors";

type CreateWallet = WalletList[number]["wallets"][number];
type EthereumProvider = Record<string, unknown> & { providers?: EthereumProvider[] };
type WithEthereum = { ethereum?: EthereumProvider; zerionWallet?: EthereumProvider };

const browserWindow = (): WithEthereum | undefined => (typeof window === "undefined" ? undefined : (window as unknown as WithEthereum));

/**
 * RainbowKit 2.2.11's own MetaMask check (wallets/walletConnectors/metaMaskWallet), copied
 * because RainbowKit doesn't export it: MetaMask's flag, and none of the ~40 flags of wallets
 * that also set it. Keep it in step with the pinned version (web/package.json): the entry's
 * "installed" test and its connector then reject the same impostors RainbowKit does.
 */
function isMetaMask(ethereum: EthereumProvider | undefined): boolean {
  if (!ethereum?.isMetaMask) return false;
  if (ethereum.isBraveWallet && !ethereum._events && !ethereum._state) return false;
  const impostors = [
    "isApexWallet", "isAvalanche", "isBackpack", "isBifrost", "isBitKeep", "isBitski", "isBinance", "isBlockWallet",
    "isCoinbaseWallet", "isDawn", "isEnkrypt", "isExodus", "isFrame", "isFrontier", "isGamestop", "isHyperPay",
    "isImToken", "isKuCoinWallet", "isMathWallet", "isNestWallet", "isOkxWallet", "isOKExWallet", "isOneInchIOSWallet",
    "isOneInchAndroidWallet", "isOpera", "isPhantom", "isZilPay", "isPortal", "isxPortal", "isRabby", "isRainbow",
    "isStatus", "isTalisman", "isTally", "isTokenPocket", "isTokenary", "isTrust", "isTrustWallet", "isCTRL", "isZeal",
    "isCoin98", "isMEWwallet", "isSafeheron", "isSafePal", "isWigwam", "isZerion", "__seif",
  ];
  return !impostors.some((flag) => ethereum[flag]);
}

/** wagmi's injected connector on exactly `provider` (never another injected one), with RainbowKit's details. */
const injectedOn =
  (id: string, name: string, provider: (w: WithEthereum | undefined) => EthereumProvider | undefined): Wallet["createConnector"] =>
  (walletDetails) =>
    createConnector((config) => ({
      ...injected({ target: () => ({ id, name, provider: provider(browserWindow()) as never }) })(config),
      ...walletDetails,
    }));

/** The MetaMask Mobile link for a WalletConnect URI: the QR code on a computer, the app's deep link on a phone. */
const metaMaskMobile = (uri: string) => `https://metamask.app.link/wc?uri=${encodeURIComponent(uri)}`;

/**
 * MetaMask. Injected (by RainbowKit's own check): wagmi's injected connector on that provider.
 * Not injected: MetaMask Mobile through RainbowKit's WalletConnect connector, whose `setup` is
 * made to do nothing, so WalletConnect starts only when MetaMask is picked (RainbowKit then
 * asks the connector for its provider and URI, as for any WalletConnect wallet).
 */
const metaMask: CreateWallet = (params) => {
  const stock = metaMaskWallet(params);
  const ethereum = browserWindow()?.ethereum;
  if (isMetaMask(ethereum)) {
    return { ...stock, installed: true, qrCode: undefined, mobile: undefined, createConnector: injectedOn(stock.id, stock.name, (w) => (isMetaMask(w?.ethereum) ? w!.ethereum : undefined)) };
  }
  const walletConnect = getWalletConnectConnector({ projectId: params.projectId, walletConnectParameters: params.walletConnectParameters });
  return {
    ...stock,
    installed: undefined,
    qrCode: { ...stock.qrCode!, getUri: metaMaskMobile },
    mobile: { getUri: metaMaskMobile },
    createConnector: (walletDetails) => {
      const connector = walletConnect(walletDetails);
      return createConnector((config) => ({ ...connector(config), setup: async () => {} }));
    },
  };
};

/** Zerion's extension: its own `zerionWallet` provider, else the injected one flagged `isZerion`. */
function zerionProvider(w: WithEthereum | undefined): EthereumProvider | undefined {
  if (w?.zerionWallet) return w.zerionWallet;
  const providers = w?.ethereum?.providers;
  return providers ? providers.find((p) => p.isZerion) : w?.ethereum?.isZerion ? w.ethereum : undefined;
}

/** Zerion, as an extension only: absent, it's shown with its extension's download link and never connects. */
const zerion: CreateWallet = (params) => {
  const stock = zerionWallet(params);
  return {
    ...stock,
    installed: zerionProvider(browserWindow()) !== undefined,
    qrCode: undefined,
    mobile: undefined,
    downloadUrls: { chrome: stock.downloadUrls?.chrome, browserExtension: stock.downloadUrls?.browserExtension },
    createConnector: injectedOn(stock.id, stock.name, zerionProvider),
  };
};

export const walletList: WalletList = [{ groupName: "Wallets", wallets: [metaMask, rabbyWallet, braveWallet, zerion] }];
