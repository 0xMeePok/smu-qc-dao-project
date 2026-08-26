export type TokenSymbol = "XSGD" | "USDT" | "USDC";

export type EthereumProvider = {
  request(args: {
    method: string;
    params?: unknown[] | Record<string, unknown>;
  }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
};

export const CHAIN_ID = 421614;
export const CHAIN_HEX = "0x66eee";

export function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function currentUnixTime() {
  return Math.floor(Date.now() / 1_000);
}

export function mintMessage(
  symbol: TokenSymbol,
  recipient: string,
  issuedAt: number,
) {
  return [
    "TAP Faucet Mint",
    `Token: ${symbol}`,
    `Recipient: ${recipient}`,
    `Chain ID: ${CHAIN_ID}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

export async function switchToArbitrumSepolia(ethereum: EthereumProvider) {
  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_HEX }],
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw error;
    await ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_HEX,
          chainName: "Arbitrum Sepolia",
          nativeCurrency: {
            name: "Arbitrum Sepolia Ether",
            symbol: "ETH",
            decimals: 18,
          },
          rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
          blockExplorerUrls: ["https://sepolia.arbiscan.io"],
        },
      ],
    });
  }
}
