// Shared browser read client. viem, not wagmi, so it remains after the wallet
// migration. Multicall wait is long enough for the Funding and Record panels
// to join one batch. The platform-status probe keeps its own uncached client.
export { browserPublicClient as chainPublicClient, BROWSER_READ_BATCH, createBrowserPublicClient, createBrowserRpcTransport } from "./rpc.js";
