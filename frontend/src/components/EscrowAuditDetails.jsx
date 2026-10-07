import { formatUnits } from "viem";
import { ARBITRUM_SEPOLIA_CHAIN_ID } from "../../../firebase/functions/rpcPolicy.js";

const STATE_EVENTS = new Set(["EscrowCreated", "SelectionLocked", "Approval", "SelectionInvalidated",
  "Cancelled", "Expired", "MilestoneSubmitted", "Voided", "FunderVote"]);
const absentTransferLabel = eventType => STATE_EVENTS.has(eventType) ? "Not applicable" : "Not recorded";

function amountLabel(funding) {
  if (funding.amountBaseUnits == null) {
    return absentTransferLabel(funding.eventType);
  }
  try {
    const amount = BigInt(funding.amountBaseUnits);
    if (amount < 0n) return "Not recorded";
    if (!Number.isInteger(funding.tokenDecimals) || funding.tokenDecimals < 0 || funding.tokenDecimals > 255) {
      return String(amount) + " base units";
    }
    return (formatUnits(amount, funding.tokenDecimals) + " " + (funding.tokenSymbol || "")).trim();
  } catch { return "Not recorded"; }
}

/** Indexed escrow details; rendering performs no RPC reads. */
export function EscrowAuditDetails({ funding }) {
  if (!funding) return null;
  const transactionHash = /^0x[0-9a-f]{64}$/i.test(funding.transactionHash || "") ? funding.transactionHash : null;
  const hasExplorer = funding.chainId == null || funding.chainId === ARBITRUM_SEPOLIA_CHAIN_ID;
  const counterparty = funding.counterpartyAddress
    || (funding.counterpartyLabel && funding.counterpartyLabel !== "Unavailable" ? funding.counterpartyLabel : null)
    || absentTransferLabel(funding.eventType);

  return <dl className="audit-receipt-grid" aria-label="Escrow event details">
    <div><dt>Amount</dt><dd>{amountLabel(funding)}</dd></div>
    <div><dt>Token</dt><dd>
      {funding.tokenSymbol && <span>{funding.tokenSymbol}</span>}
      {funding.tokenSymbol && funding.tokenAddress && <br />}
      {funding.tokenAddress && <code>{funding.tokenAddress}</code>}
      {!funding.tokenSymbol && !funding.tokenAddress && "Not recorded"}
    </dd></div>
    <div><dt>Actor</dt><dd>{funding.actorAddress
      ? <code>{funding.actorAddress}</code> : funding.actorLabel || "Not recorded"}</dd></div>
    <div><dt>Counterparty</dt><dd>{funding.counterpartyAddress
      ? <>{funding.counterpartyLabel && <><span>{funding.counterpartyLabel}</span><br /></>}<code>{funding.counterpartyAddress}</code></>
      : counterparty}</dd></div>
    <div><dt>Transaction</dt><dd>
      {transactionHash ? <>
        <code>{transactionHash}</code>
        {hasExplorer && <><br /><a href={"https://sepolia.arbiscan.io/tx/" + transactionHash} target="_blank" rel="noreferrer">View escrow transaction</a></>}
      </> : "Not recorded"}
    </dd></div>
    {Number.isSafeInteger(funding.blockNumber) && funding.blockNumber >= 0 && <div><dt>Block</dt><dd>{funding.blockNumber}</dd></div>}
  </dl>;
}
