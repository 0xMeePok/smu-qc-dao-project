import { useState } from "react";
import { useAccount } from "wagmi";
import { formatInstant } from "../lib/datetime.js";
import {
  APPROACH_TEXT_MAX, decideFundingApproach, fundingApproachError, fundingApproachStatusLabel,
  recordFundingApproachDecisionAnchors, submitFundingApproachDecisions, validateApproachDecision,
} from "../lib/fundingApproach.js";
import { claimRemovedProposalFunds, escrowErrorMessage } from "../lib/escrow.js";
import { AUDIT_REGISTRY_CHAIN_ID } from "../config/auditRegistry.js";
import { useAuth } from "../context/AuthContext.jsx";
import { ConnectWalletModal } from "./ConnectWalletModal.jsx";
import { Field } from "./Field.jsx";

const money = (item) => `${item.currency || ""} ${Number(item.amount ?? 0).toLocaleString()}`.trim();

/** Claim the unpaid escrow balance after an administrator removes the listing. */
export function ClaimRemovedFundsButton({ proposalId }) {
  const { user } = useAuth();
  const { address, isConnected, chainId } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [connect, setConnect] = useState(false);
  const ready = isConnected && address?.toLowerCase() === user?.id?.toLowerCase() && chainId === AUDIT_REGISTRY_CHAIN_ID;
  const claim = async () => {
    if (!ready) { setConnect(true); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      await claimRemovedProposalFunds({ proposalId, account: address });
      setNotice("Refund claimed. The tokens are in the wallet that deposited them. Amounts already paid stay paid.");
    } catch (err) {
      setError(escrowErrorMessage(err));
    } finally { setBusy(false); }
  };
  return (
    <>
      <button className="secondary" type="button" disabled={busy} onClick={claim}>{busy ? "Claiming…" : "Claim funds"}</button>
      {error && <p role="alert" className="field-hint">{error}</p>}
      {notice && <p role="status" className="field-hint">{notice}</p>}
      {connect && <ConnectWalletModal onClose={() => setConnect(false)} />}
    </>
  );
}

function walletReady(user, address, isConnected, chainId) {
  return isConnected && address?.toLowerCase() === user?.id?.toLowerCase() && chainId === AUDIT_REGISTRY_CHAIN_ID;
}

async function anchorDecisions(decisions, account) {
  try {
    const signed = await submitFundingApproachDecisions(decisions, { account });
    await recordFundingApproachDecisionAnchors(decisions.map((item) => item.approachId), signed.transactionHash);
  } catch (err) {
    if (!err?.transactionHash) throw err;
    await recordFundingApproachDecisionAnchors(decisions.map((item) => item.approachId), err.transactionHash);
  }
}

/** Accept or decline, then ask the researcher's wallet to anchor the decision. */
function ApproachResponseForm({ draft, setDraft, onUpdated, onAnchorError }) {
  const { user } = useAuth();
  const { address, isConnected, chainId } = useAccount();
  const [connect, setConnect] = useState(false);
  const declining = draft.decision === "decline";
  const submit = async (event) => {
    event.preventDefault();
    const fieldError = validateApproachDecision(draft.decision, draft.text);
    if (fieldError) {
      setDraft((current) => (current?.id === draft.id ? { ...current, error: fieldError } : current));
      return;
    }
    if (!walletReady(user, address, isConnected, chainId)) { setConnect(true); return; }
    setDraft((current) => (current?.id === draft.id ? { ...current, busy: true, error: "", phase: "saving" } : current));
    let decided;
    try {
      decided = await decideFundingApproach(draft.id, draft.decision, draft.text);
    } catch (err) {
      setDraft((current) => (current?.id === draft.id ? {
        ...current, busy: false, phase: "", error: fundingApproachError(err, "This approach could not be updated. Please try again."),
      } : current));
      return;
    }
    setDraft((current) => (current?.id === draft.id ? { ...current, phase: "signing" } : current));
    try {
      await anchorDecisions(decided.decisions, address);
    } catch (err) {
      setDraft(null);
      onAnchorError?.(err?.message || "The decision is saved. Sign the anchor so it can be verified on Arbitrum Sepolia.");
      try { await onUpdated?.(); } catch { /* The list query reports its own load error. */ }
      return;
    }
    setDraft(null);
    try { await onUpdated?.(); } catch { /* The list query reports its own load error. */ }
  };
  return (
    <form onSubmit={submit}>
      <Field
        htmlFor={`approach-response-${draft.id}`}
        label={declining ? "Reason for declining" : "Message to the funder"}
        hint={declining ? "Your wallet then anchors this reason. The text stays off-chain." : "Optional. Your wallet then anchors this decision. Any message stays off-chain."}
        error={draft.error}
      >
        {({ id, describedBy, invalid }) => (
          <textarea
            id={id}
            rows={3}
            maxLength={APPROACH_TEXT_MAX}
            required={declining}
            value={draft.text}
            disabled={draft.busy}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(event) => setDraft((current) => (
              current?.id === draft.id ? { ...current, text: event.target.value, error: "" } : current
            ))}
          />
        )}
      </Field>
      <div className="table-row-actions">
        <button className="secondary" type="button" disabled={draft.busy} onClick={() => setDraft(null)}>Cancel</button>
        <button className="primary" type="submit" disabled={draft.busy}>
          {draft.busy ? (draft.phase === "signing" ? "Waiting for your wallet…" : "Saving…") : declining ? "Decline approach" : "Accept approach"}
        </button>
      </div>
      {connect && <ConnectWalletModal onClose={() => setConnect(false)} />}
    </form>
  );
}

/** Signs every still-pending decision digest for one listing. */
function SignDecisionAnchor({ items, proposalId, onUpdated, onError }) {
  const { user } = useAuth();
  const { address, isConnected, chainId } = useAccount();
  const [busy, setBusy] = useState(false);
  const [connect, setConnect] = useState(false);
  const sign = async () => {
    if (!walletReady(user, address, isConnected, chainId)) { setConnect(true); return; }
    const batch = items.filter((item) => item.proposalId === proposalId && item.decisionAnchorStatus === "pending" && item.decisionAnchorId && item.decisionRecordHash)
      .map((item) => ({ approachId: item.id, decisionAnchorId: item.decisionAnchorId, recordHash: item.decisionRecordHash }));
    setBusy(true);
    onError?.("");
    try {
      await anchorDecisions(batch, address);
      await onUpdated?.();
    } catch (err) {
      onError?.(err?.message || "The decision anchor could not be saved. Please try again.");
    } finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" className="primary" disabled={busy} onClick={sign}>{busy ? "Waiting for your wallet…" : "Sign decision anchor"}</button>
      {connect && <ConnectWalletModal onClose={() => setConnect(false)} />}
    </>
  );
}

/** Newest first. A listing's group appears where its newest approach does. */
function groupByProposal(items) {
  const groups = [];
  const byProposal = new Map();
  for (const item of items) {
    const key = item.proposalId || "";
    let group = byProposal.get(key);
    if (!group) {
      group = { key: key || "listing", title: item.proposalTitle || "Independent listing", items: [] };
      byProposal.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/**
 * One party's funding approaches. `showFunder` is the researcher's incoming list,
 * grouped under each listing. The funder's sent list stays one row per approach
 * and names the listing on that row. Accept and decline are only offered on a
 * pending incoming row.
 */
export function FundingApproachList({ title, hint, empty, items = [], truncated = false, loading = false, error = "", onNavigate, onUpdated, showFunder = false, heading = "h2" }) {
  const Heading = heading === "h3" ? "h3" : "h2";
  const [draft, setDraft] = useState(null);
  const [anchorError, setAnchorError] = useState("");
  const openDraft = draft && items.some((item) => item.id === draft.id && item.status === "pending") ? draft : null;
  const start = (item, decision) => setDraft({ id: item.id, decision, text: "", error: "", busy: false, phase: "" });
  const approachRow = (item) => {
    const responding = openDraft?.id === item.id;
    const signAnchor = showFunder && item.decisionAnchorStatus === "pending"
      && items.find((row) => row.proposalId === item.proposalId && row.decisionAnchorStatus === "pending")?.id === item.id;
    return (
      <div className="table-row" key={item.id}>
        <div>
          <strong>{showFunder ? (item.funderName || "A client or funder") : (item.proposalTitle || "Independent listing")}</strong>
          <small className="table-row-meta">
            {showFunder ? null : "Sent by you · "}
            {money(item)} indicative · {fundingApproachStatusLabel(item.status)}
          </small>
          <small className="table-row-meta">Expires {formatInstant(item.expiresAt)}</small>
          {item.scope && <p>{item.scope}</p>}
          {item.message && <p>{item.message}</p>}
          {item.status === "accepted" && item.acceptMessage && <p>Message with acceptance: {item.acceptMessage}</p>}
          {item.status === "declined" && item.declineReason && <p>Reason for declining: {item.declineReason}</p>}
          {signAnchor && <p className="field-hint">The decision is saved. Sign the anchor so it can be verified on Arbitrum Sepolia. The message and reason stay off-chain.</p>}
          {responding && <ApproachResponseForm draft={openDraft} setDraft={setDraft} onUpdated={onUpdated} onAnchorError={setAnchorError} />}
        </div>
        <div className="table-row-actions">
          {showFunder && item.status === "pending" && !responding && (
            <>
              <button type="button" className="primary" onClick={() => start(item, "accept")}>Accept</button>
              <button type="button" className="secondary" onClick={() => start(item, "decline")}>Decline</button>
            </>
          )}
          {signAnchor && <SignDecisionAnchor items={items} proposalId={item.proposalId} onUpdated={onUpdated} onError={setAnchorError} />}
          {item.claimFunds && !showFunder && <ClaimRemovedFundsButton proposalId={item.proposalId} />}
          <button type="button" className="text-button" onClick={() => onNavigate?.(`proposal/${item.proposalId}`)}>Open listing</button>
        </div>
      </div>
    );
  };
  const groups = showFunder ? groupByProposal(items) : [];
  return (
    <section className="card-table" aria-label={title}>
      <div className="table-header"><Heading>{title}</Heading></div>
      {hint && <p className="field-hint">{hint}</p>}
      {loading && <p role="status" className="table-empty">Loading funding approaches…</p>}
      {error && <p role="alert" className="error-banner">{error}</p>}
      {anchorError && <p role="alert" className="error-banner">{anchorError}</p>}
      {!loading && !error && items.length === 0 && <p className="table-empty">{empty}</p>}
      {!loading && !error && (showFunder
        ? groups.map((group) => (
          <div className="approach-group" key={group.key}>
            <h4 className="approach-group-title">{group.title}</h4>
            {group.items.map(approachRow)}
          </div>
        ))
        : items.map(approachRow))}
      {truncated && <p className="field-hint">Showing a limited set of approaches. Open a listing for the full record.</p>}
    </section>
  );
}
