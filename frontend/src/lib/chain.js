import { arbitrumSepolia } from "wagmi/chains";

export const EXPECTED_CHAIN_ID = arbitrumSepolia.id; // 421614
export const EXPECTED_CHAIN_NAME = arbitrumSepolia.name;

export function shortenAddress(address) {
  if (!address || address.length < 10) return address ?? "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
