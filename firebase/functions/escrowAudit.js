import { encodeAbiParameters, keccak256 } from "viem";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const MAX_UINT256 = (1n << 256n) - 1n;
const same = (left, right) => String(left).toLowerCase() === String(right).toLowerCase();
const field = (value, name, index) => value?.[name] ?? value?.[index];
const mismatchError = message => Object.assign(new Error(`Mismatch detected: ${message}`), { code: "ESCROW_MISMATCH" });

export const FUNDING_TERMS_ABI = [{ type: "tuple", components: [
  { name: "token", type: "address" }, { name: "target", type: "uint256" },
  { name: "funderVoting", type: "bool" }, { name: "trancheBps", type: "uint16[]" },
  { name: "reviewWindows", type: "uint64[]" }, { name: "milestoneHashes", type: "bytes32[]" },
] }];

export function isEscrowRegistry(config) { return config?.contractName === "EscrowAuditRegistry"; }

export function requireAddress(value, label) {
  if (!ADDRESS.test(value ?? "") || same(value, ZERO_ADDRESS)) throw new Error(`${label} is missing or invalid.`);
  return value.toLowerCase();
}

/** Exact on-chain units; JavaScript floating-point amounts are never accepted. */
export function normalizeFundingTerms(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Escrow funding terms are required.");
  const keys = ["token", "target", "funderVoting", "trancheBps", "reviewWindows", "milestoneHashes"];
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key))) {
    throw new TypeError("Escrow funding terms must contain exactly the six contract fields.");
  }
  const token = requireAddress(input.token, "Funding token");
  if (!["string", "bigint"].includes(typeof input.target) || String(input.target).length > 78 || !/^[1-9][0-9]*$/.test(String(input.target))) {
    throw new TypeError("Funding target must be a positive integer string in token base units.");
  }
  const target = BigInt(input.target);
  if (target > MAX_UINT256) throw new TypeError("Funding target exceeds uint256.");
  if (typeof input.funderVoting !== "boolean") throw new TypeError("Funder voting must be true or false.");
  const { trancheBps, reviewWindows, milestoneHashes } = input;
  if (!Array.isArray(trancheBps) || trancheBps.length < 1 || trancheBps.length > 5
      || !Array.isArray(reviewWindows) || reviewWindows.length !== trancheBps.length
      || !Array.isArray(milestoneHashes) || milestoneHashes.length !== trancheBps.length) {
    throw new TypeError("A payment plan must contain one to five matching tranches, windows and milestone hashes.");
  }
  let bps = 0, allocated = 0n;
  for (let index = 0; index < trancheBps.length; index++) {
    const ratio = trancheBps[index], window = typeof reviewWindows[index] === "bigint" ? Number(reviewWindows[index]) : reviewWindows[index];
    if (!Number.isInteger(ratio) || ratio <= 0 || ratio > 10000
        || !Number.isInteger(window) || window <= 0 || window > 365 * 86400
        || !HASH.test(milestoneHashes[index] ?? "") || same(milestoneHashes[index], ZERO_HASH)) {
      throw new TypeError("Invalid tranche ratio, review window or milestone hash.");
    }
    bps += ratio;
    const cumulative = target * BigInt(bps) / 10000n;
    if (bps > 10000 || cumulative <= allocated) throw new TypeError("Each tranche must pay at least one token base unit.");
    allocated = cumulative;
  }
  if (bps !== 10000) throw new TypeError("Tranche ratios must total 10000 basis points.");
  return Object.freeze({ token, target, funderVoting: input.funderVoting,
    trancheBps: Object.freeze([...trancheBps]), reviewWindows: Object.freeze(reviewWindows.map(Number)),
    milestoneHashes: Object.freeze(milestoneHashes.map(hash => hash.toLowerCase())) });
}

export function fundingTermsHash(input) {
  return keccak256(encodeAbiParameters(FUNDING_TERMS_ABI, [normalizeFundingTerms(input)]));
}

/** Confirm immutable terms through BOTH canonical mappings, never a client escrow address. */
export async function verifyProposalEscrow({ expected, config, readContract }) {
  const registryAddress = requireAddress(config.address, "AuditRegistry address");
  const factoryAddress = requireAddress(config.escrow?.factoryAddress, "Funding factory address");
  const factoryAbi = config.escrow?.factoryAbi, escrowAbi = config.escrow?.escrowAbi;
  if (!Array.isArray(factoryAbi) || !factoryAbi.length || !Array.isArray(escrowAbi) || !escrowAbi.length) {
    throw new Error("Escrow verification ABI configuration is missing.");
  }
  const terms = normalizeFundingTerms(expected.fundingTerms);
  const read = (address, abi, functionName, args = []) => readContract({ address, abi, functionName, args, chainId: config.chainId });
  const [configuredFactory, reverseRegistry, registryEscrow, factoryEscrow] = await Promise.all([
    read(registryAddress, config.abi, "fundingFactory"),
    read(factoryAddress, factoryAbi, "auditRegistry"),
    read(registryAddress, config.abi, "proposalEscrow", [expected.entityId]),
    read(factoryAddress, factoryAbi, "escrowForProposal", [expected.entityId]),
  ]);
  let escrowAddress;
  try { escrowAddress = requireAddress(registryEscrow, "Canonical proposal escrow"); }
  catch { throw mismatchError("the canonical proposal escrow is missing or invalid."); }
  if (!same(configuredFactory, factoryAddress) || !same(reverseRegistry, registryAddress) || !same(escrowAddress, factoryEscrow)) {
    throw mismatchError("the proposal escrow is not canonically linked to this registry and factory.");
  }
  const tokenMetadata = config.escrow?.tokens?.find(token => same(token.address, terms.token));
  if (!Number.isInteger(tokenMetadata?.decimals) || tokenMetadata.decimals < 0 || tokenMetadata.decimals > 77) {
    throw new Error("Escrow token precision configuration is missing or invalid.");
  }
  const names = ["postingId", "proposalId", "token", "fundingTarget", "funderVoting", "proposalOwner", "problemOwner",
    "tokenRegistry", "auditRegistry", "milestoneCount", "expiresAt", "tokenDecimals"];
  const values = await Promise.all(names.map(name => read(escrowAddress, escrowAbi, name)));
  const actual = Object.fromEntries(names.map((name, index) => [name, values[index]]));
  const posting = await read(registryAddress, config.abi, "getOpportunity", [expected.opportunityId]);
  const checks = [
    [actual.postingId, expected.opportunityId], [actual.proposalId, expected.entityId],
    [actual.token, terms.token], [actual.fundingTarget, terms.target], [actual.funderVoting, terms.funderVoting],
    [actual.proposalOwner, expected.expectedResearcher], [actual.problemOwner, field(posting, "owner", 0)],
    [actual.tokenRegistry, factoryAddress], [actual.auditRegistry, registryAddress],
    [actual.milestoneCount, terms.trancheBps.length], [actual.expiresAt, field(posting, "expiresAt", 5)],
    [actual.tokenDecimals, tokenMetadata.decimals],
  ];
  if (checks.some(([left, right]) => !same(left, right))) throw mismatchError("the escrow differs from the proposal funding terms.");
  let cumulativeBps = 0n, allocated = 0n;
  for (let index = 0; index < terms.trancheBps.length; index++) {
    const milestone = await read(escrowAddress, escrowAbi, "milestoneAt", [BigInt(index)]);
    cumulativeBps += BigInt(terms.trancheBps[index]);
    const cumulative = terms.target * cumulativeBps / 10000n;
    const matches = [[field(milestone, "bps", 0), terms.trancheBps[index]],
      [field(milestone, "reviewWindow", 1), terms.reviewWindows[index]],
      [field(milestone, "descriptionHash", 2), terms.milestoneHashes[index]],
      [field(milestone, "grossAmount", 3), cumulative - allocated]];
    if (matches.some(([left, right]) => !same(left, right))) throw mismatchError("the escrow milestone plan differs from the proposal.");
    allocated = cumulative;
  }
  return Object.freeze({ address: escrowAddress, factoryAddress, fundingTermsHash: fundingTermsHash(terms) });
}
