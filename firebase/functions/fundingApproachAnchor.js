import { concat, getAddress, keccak256, slice, stringToHex } from "viem";

/** Encodes and decodes anchorFundingApproach. Kept beside the digest so both sides hash the same record. */
export const FUNDING_APPROACH_ANCHOR_ABI = [
  {
    type: "function",
    name: "anchorFundingApproach",
    stateMutability: "nonpayable",
    inputs: [
      { name: "approachId", type: "bytes32", internalType: "bytes32" },
      { name: "recordHash", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "FundingApproachAnchored",
    inputs: [
      { name: "approachId", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "recordHash", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "anchoredBy", type: "address", indexed: true, internalType: "address" },
      { name: "anchoredAt", type: "uint64", indexed: false, internalType: "uint64" },
    ],
  },
];

/** Same field order on every digest. A different order would be a different hash. */
export function canonicalFundingApproachRecord(record) {
  return JSON.stringify({
    eventVersion: 1,
    funderId: String(record.funderId || "").toLowerCase(),
    proposalId: record.proposalId,
    researcherId: String(record.researcherId || "").toLowerCase(),
    amount: record.amount,
    currency: record.currency,
    scope: record.scope,
    message: record.message,
    expiresAt: record.expiresAt,
  });
}

export function fundingApproachRecordHash(record) {
  return keccak256(stringToHex(canonicalFundingApproachRecord(record)));
}

/** First 20 bytes are the funder, matching the registry's sender check. */
export function fundingApproachAnchorId(approachId, funderId) {
  const funder = getAddress(funderId);
  const tail = slice(keccak256(stringToHex(String(approachId))), 20);
  return concat([funder, tail]);
}
