import { encodeAbiParameters, encodeEventTopics } from "viem";

export const AUDIT_REVISION_DIGEST = `0x${"6".repeat(64)}`;

/** Raw RPC-shaped contract log; tests exercise the production strict decoder. */
export function auditEvent({ config, functionName, args, actor, opportunityId, opportunityRevisionDigest = AUDIT_REVISION_DIGEST }) {
  let eventName, values;
  switch (functionName) {
    case "commitOpportunity":
      eventName = "OpportunityCommitted";
      values = { opportunityId: args[0], kind: args[1], owner: actor, contentHash: args[2], expiresAt: args[3] };
      break;
    case "updateOpportunity":
      eventName = "OpportunityUpdated";
      values = { opportunityId: args[0], owner: actor, contentHash: args[1], expiresAt: args[2] };
      break;
    case "withdrawOpportunity":
      eventName = "OpportunityWithdrawn";
      values = { opportunityId: args[0], owner: actor, evidenceHash: args[1] };
      break;
    case "withdrawProposal":
      eventName = "ProposalWithdrawn";
      values = { proposalId: args[0], researcher: actor, evidenceHash: args[1] };
      break;
    case "commitProposal":
    case "commitProposalWithEscrow":
      eventName = "ProposalCommitted";
      values = { proposalId: args[0], opportunityId: args[1], researcher: actor,
        proposalHash: args[2], solutionHash: args[3], opportunityRevisionIndex: args[4], opportunityRevisionDigest };
      break;
    case "updateHashes":
      eventName = "HashesUpdated";
      values = { proposalId: args[0], opportunityId, researcher: actor,
        proposalHash: args[1], solutionHash: args[2], opportunityRevisionIndex: args[3], opportunityRevisionDigest };
      break;
    default: throw new Error(`Unsupported fixture event: ${functionName}`);
  }
  const event = config.abi.find(item => item.type === "event" && item.name === eventName);
  const dataFields = event.inputs.filter(input => !input.indexed);
  return { address: config.address, topics: encodeEventTopics({ abi: config.abi, eventName, args: values }),
    data: encodeAbiParameters(dataFields, dataFields.map(input => values[input.name])) };
}
