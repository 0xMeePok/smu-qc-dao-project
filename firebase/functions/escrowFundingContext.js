import { encodeAbiParameters, keccak256 } from "viem";

const at = (value, name, index) => value?.[name] ?? value?.[index];
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const fields = ["address", "uint256", "bytes32", "uint256", "bytes32", "bytes32", "bytes32", "uint32", "bytes32", "uint256", "bytes32", "bytes32"].map(type => ({ type }));

export function fundingContextDigest({ config, expected, proposal, revisionCount, parentCount, parentHash, currentDigest }) {
  return keccak256(encodeAbiParameters(fields, [config.address, BigInt(config.chainId), expected.entityId,
    BigInt(revisionCount), at(proposal, "proposalHash", 4), at(proposal, "solutionHash", 5), expected.opportunityId,
    Number(at(proposal, "opportunityRevisionIndex", 2)), at(proposal, "opportunityRevisionDigest", 3), BigInt(parentCount), parentHash, currentDigest]));
}

/** Read only at a verified display/preflight block; retain the resulting digest through signing. */
export async function readFundingContext({ config, expected, proposal, readContract }) {
  const read = (functionName, args) => readContract({ address: config.address, abi: config.abi, functionName, args });
  const [revisionCount, parentCount, parent] = await Promise.all([
    read("revisionCount", [expected.entityId]), read("opportunityRevisionCount", [expected.opportunityId]),
    read("getOpportunity", [expected.opportunityId]),
  ]);
  const parentHash = at(parent, "contentHash", 2);
  const parentIndex = at(proposal, "opportunityRevisionIndex", 2);
  const parentDigest = at(proposal, "opportunityRevisionDigest", 3);
  if (BigInt(revisionCount) < 1n || BigInt(parentCount) < 1n || BigInt(parentIndex) !== BigInt(parentCount) - 1n
      || !same(parentHash, parentDigest)) return null;
  const revision = await read("opportunityRevisionAt", [expected.opportunityId, BigInt(parentCount) - 1n]);
  const currentDigest = at(revision, "contentHash", 0);
  if (!same(currentDigest, parentDigest)) return null;
  return fundingContextDigest({ config, expected, proposal, revisionCount, parentCount, parentHash, currentDigest });
}

export const supportsReviewedFunding = config => config.abi.some(item => item.type === "function" && item.name === "fundingContextDigest")
  && config.escrow.escrowAbi.some(item => item.type === "function" && item.name === "depositReviewed");
