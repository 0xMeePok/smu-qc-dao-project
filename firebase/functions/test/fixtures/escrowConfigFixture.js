import abis from "../../escrowRegistry.abis.json" with { type: "json" };

export const escrowConfig = { contractName: "EscrowAuditRegistry", chainId: 421614, entityIdScheme: 2,
  address: `0x${"7".repeat(40)}`, abi: abis.registry,
  escrow: { factoryAddress: `0x${"8".repeat(40)}`, factoryAbi: abis.factory, escrowAbi: abis.escrow,
    tokens: [{ address: `0x${"c".repeat(40)}`, symbol: "USDC", decimals: 6 }] } };
