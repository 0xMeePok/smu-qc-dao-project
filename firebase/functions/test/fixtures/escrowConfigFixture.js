import abis from "../../escrowRegistry.abis.json" with { type: "json" };

export const escrowConfig = { contractName: "EscrowAuditRegistry", chainId: 421614, entityIdScheme: 2,
  address: `0x${"7".repeat(40)}`, abi: [...abis.registry.filter(item => item.name !== "fundingContextDigest"),
    { type: "function", name: "fundingContextDigest", stateMutability: "view", inputs: [{ type: "bytes32", name: "proposalId" }], outputs: [{ type: "bytes32" }] }],
  escrow: { factoryAddress: `0x${"8".repeat(40)}`, factoryAbi: abis.factory, escrowAbi: [...abis.escrow.filter(item => item.name !== "depositReviewed"),
    { type: "function", name: "depositReviewed", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "amount" }, { type: "bytes32", name: "expectedContextDigest" }], outputs: [] }],
    tokens: [{ address: `0x${"c".repeat(40)}`, symbol: "USDC", decimals: 6 }] } };
