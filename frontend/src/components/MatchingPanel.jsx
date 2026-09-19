import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { completeMockEvaluation, confirmMockProposal, declineMockProposal, forceExpireMockMatch, fundMockProposal, getMockMatching, MATCHING_LABELS, matchingError, proposalFundingLabel, selectMockProposal } from "../lib/matching.js";
import { findProposal } from "../lib/proposals.js";
import { formatInstant } from "../lib/datetime.js";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { Modal } from "./Modal.jsx";
import { RELATED_AUDIT_KIND, RelatedAuditReceiptPane } from "./RelatedAuditReceiptPane.jsx";

const money = (currency, amount) => `${currency} ${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function MatchingPanel({ problemId, proposalId, onChange, onNavigate }) {
  const { user } = useAuth();
  const [state, setState] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);
  const [amount, setAmount] = useState("");
  const [rationale, setRationale] = useState("");
  const [page, setPage] = useState(null);
  const [relatedAudit, setRelatedAudit] = useState(null);
  const cursor = page && page.problemId === problemId ? page.cursor : null;
  const actionInFlight = useRef(false);
  const relatedAuditRequest = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const generation = useRef(0);
  const readRevision = useRef(0);
  const matchingStatus = useRef(null);

  useEffect(() => {
    const version = ++generation.current;
    let reading = false;
    matchingStatus.current = null;
    relatedAuditRequest.current += 1;
    setRelatedAudit(null);
    setState(null); setPending(null); setError(""); setNotice(""); setLoading(true);
    if (!user?.id || !problemId) { setLoading(false); return undefined; }
    const refresh = async () => {
      if (reading || actionInFlight.current) return;
      reading = true;
      const read = ++readRevision.current;
      try {
        const next = await getMockMatching(problemId, { proposalId, cursor });
        if (version === generation.current && read === readRevision.current) {
          if (matchingStatus.current && matchingStatus.current !== next.matching?.status) setNotice("");
          matchingStatus.current = next.matching?.status;
          setState(next); setError(""); onChangeRef.current?.(next);
        }
      } catch (err) { if (version === generation.current && read === readRevision.current) setError(matchingError(err)); }
      finally { reading = false; if (version === generation.current) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { generation.current++; clearInterval(timer); };
  }, [problemId, proposalId, cursor, user?.id]);

  const refresh = async ({ preserveNotice = false } = {}) => {
    if (!preserveNotice) setNotice("");
    const version = generation.current;
    const read = ++readRevision.current;
    setLoading(true);
    try {
      const next = await getMockMatching(problemId, { proposalId, cursor });
      if (version === generation.current && read === readRevision.current) { matchingStatus.current = next.matching?.status; setState(next); setError(""); onChangeRef.current?.(next); }
    } catch (err) { if (version === generation.current && read === readRevision.current) setError(matchingError(err)); }
    finally { if (version === generation.current) setLoading(false); }
  };

  const act = async (event) => {
    event.preventDefault();
    if (!pending || actionInFlight.current) return;
    if (["select", "decline"].includes(pending.kind) && rationale.trim().length < 10) {
      setError("Enter a reason of at least 10 characters for the decision record.");
      return;
    }
    if (pending.kind === "fund" && (!/^\d+(\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 || Number(amount) > pending.remaining)) {
      setError(`Enter an amount above zero and up to ${money(pending.item.currency, pending.remaining)}, using at most two decimal places.`);
      return;
    }
    const version = generation.current;
    readRevision.current++;
    actionInFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const payload = { problemId, proposalId: pending.item.id };
      if (pending.kind === "fund") await fundMockProposal({ ...payload, amount: Number(amount), requestId: pending.requestId });
      else if (pending.kind === "select") await selectMockProposal({ ...payload, rationale: rationale.trim() });
      else if (pending.kind === "decline") await declineMockProposal({ ...payload, reason: rationale.trim() });
      else if (pending.kind === "evaluate") await completeMockEvaluation(payload);
      else if (pending.kind === "expire") await forceExpireMockMatch({ problemId });
      else await confirmMockProposal(payload);
      if (version !== generation.current) return;
      setNotice(pending.kind === "fund" ? "Mock contribution recorded." : pending.kind === "select"
        ? "Proposal selected and your acceptance recorded. The creator must accept before the displayed deadline. Either party can reject during this window; funding is paused for all proposals on this problem."
        : pending.kind === "decline" ? "Selection rejected. The selected proposal’s funders are refunded and the other proposals can be funded or selected again."
          : pending.kind === "evaluate" ? "Optional mock evaluation recorded. Selection depends on proposal funding, not evaluation."
            : pending.kind === "expire" ? "The confirmation window was expired for this demonstration. The problem is invalidated and all pledged mock funds are refunded."
              : "Your acceptance is recorded. Funds are locked only once both parties have accepted.");
      setPending(null);
      await refresh({ preserveNotice: true });
    } catch (err) { if (version === generation.current) setError(matchingError(err)); }
    finally { actionInFlight.current = false; setBusy(false); }
  };

  if (!user?.id || !problemId) return null;
  const waiting = state?.matching?.status === "awaiting_confirmation";
  const confirmed = state?.matching?.status === "confirmed";
  const invalidated = state?.matching?.status === "invalidated";
  const reopened = state?.matching?.status === "open" && state?.matching?.reopenedAt;
  const shorterWindow = state?.matching?.deadlineLimitedByPosting;
  const items = (state?.proposals ?? []).filter((item) => !proposalId || item.id === proposalId);
  const contributions = (state?.contributions ?? []).filter((item) => !proposalId || item.proposalId === proposalId);
  const receiptFor = (type, id) => state?.history?.find((entry) => entry.type === type && (!id || entry.proposalId === id));
  const ownerReceipt = receiptFor("owner_confirmed", state?.matching?.proposalId) || receiptFor("owner_selected", state?.matching?.proposalId);
  const showReceipt = (entry) => {
    const element = document.getElementById(`matching-event-${entry.id}`);
    if (element) { element.open = true; element.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); }
  };
  const selectedProposalId = state?.matching?.proposalId;
  const selectedAudit = receiptFor("owner_selected", selectedProposalId);
  const creatorAudit = receiptFor("creator_confirmed", selectedProposalId);
  const canOpenSelectedAudit = Boolean(selectedProposalId && (
    selectedAudit
    || (ownerReceipt && state?.matching?.ownerApprovedAt)
    || (creatorAudit && state?.matching?.creatorApprovedAt)
  ));
  const openProposalAudit = async (id) => {
    if (!id) return;
    const request = ++relatedAuditRequest.current;
    setRelatedAudit({ kind: RELATED_AUDIT_KIND.PROPOSAL, loading: true, record: null, error: "" });
    try {
      const record = await findProposal(id);
      if (request !== relatedAuditRequest.current) return;
      setRelatedAudit({
        kind: RELATED_AUDIT_KIND.PROPOSAL,
        loading: false,
        record,
        error: record ? "" : "This proposal is no longer available, so its verification receipt cannot be opened.",
      });
    } catch (err) {
      if (request !== relatedAuditRequest.current) return;
      setRelatedAudit({
        kind: RELATED_AUDIT_KIND.PROPOSAL,
        loading: false,
        record: null,
        error: err?.message || "The audit receipt could not be loaded. Try again.",
      });
    }
  };
  const openAction = (kind, item) => {
    setError(""); setRationale("");
    const remaining = Math.max(0, Math.round((item.amount - item.fundedAmount) * 100) / 100);
    setAmount(String(remaining));
    setPending({ kind, item, remaining, requestId: kind === "fund" ? crypto.randomUUID() : null });
  };

  return <section id="proposal-funding" className="detail-section matching-panel" aria-label="Proposal funding and matching">
    <div className="matching-heading"><h2>Proposal funding & selection</h2><span className="draft-badge">Mock funds</span></div>
    <p>Fund individual proposals for this problem. Each proposal has its own funding target. Contributions and refunds are simulated; no wallet funds are transferred.</p>
    <ol className="matching-steps"><li>Fund a proposal to its target. No evaluation is required for selection.</li><li>The problem owner selects one and records their reason. Selection counts as the owner’s acceptance and starts an acceptance window of up to seven days, ending sooner if the posting expires.</li><li>The creator accepts, or either party rejects before the deadline. All proposal funding is paused until the outcome.</li></ol>
    {(waiting || confirmed || (invalidated && state.matching.selectedAt)) && <dl className="matching-approval">
      <dt>Selected by</dt><dd>{state.matching.selectedBy || state.matching.ownerApprovedBy || "Problem owner"}{state.matching.selectedAt && ` · ${formatInstant(state.matching.selectedAt)}`}</dd>
      <dt>Selection reason</dt><dd>{state.matching.rationale || "Recorded in the selection event"}</dd>
      <dt>Problem owner acceptance</dt><dd>{state.matching.ownerApprovedAt ? `Accepted ${formatInstant(state.matching.ownerApprovedAt)}` : "Awaiting problem owner acceptance"}</dd>
      <dt>Proposal creator acceptance</dt><dd>{state.matching.creatorApprovedAt ? `Accepted ${formatInstant(state.matching.creatorApprovedAt)}` : invalidated ? "Not accepted before closure" : "Awaiting proposal creator acceptance"}</dd>
    </dl>}
    <div className="matching-actions matching-receipts">
    {selectedAudit && <button type="button" className="text-button" onClick={() => showReceipt(selectedAudit)}>View selection record</button>}
    {ownerReceipt && state?.matching?.ownerApprovedAt && <button type="button" className="text-button" onClick={() => showReceipt(ownerReceipt)}>View owner acceptance record</button>}
    {creatorAudit && state?.matching?.creatorApprovedAt && <button type="button" className="text-button" onClick={() => showReceipt(creatorAudit)}>View creator acceptance record</button>}
    {canOpenSelectedAudit && <button type="button" className="text-button" disabled={relatedAudit?.loading} onClick={() => openProposalAudit(selectedProposalId)}>{relatedAudit?.loading ? "Loading audit receipt…" : "View audit receipt"}</button>}
    {receiptFor("match_confirmed", state?.matching?.proposalId) && confirmed && <button type="button" className="text-button" onClick={() => showReceipt(receiptFor("match_confirmed", state.matching.proposalId))}>View funding settlement record</button>}
    {state?.history?.filter((entry) => ["owner_declined", "creator_declined", "posting_reopened", "posting_invalidated"].includes(entry.type) && (!proposalId || !entry.proposalId || entry.proposalId === proposalId)).map((entry) => <button key={entry.id} type="button" className="text-button" onClick={() => showReceipt(entry)}>{entry.type === "posting_reopened" ? "View reopening record" : entry.type === "posting_invalidated" ? "View invalidation record" : "View rejection record"} · {formatInstant(entry.createdAt)}</button>)}
    </div>
    {waiting && <div className="matching-notice" role="status"><strong>{shorterWindow ? "Acceptance window ends at posting expiry" : "Seven-day acceptance window"}</strong>
      <p>The problem owner accepted by selecting this proposal. The creator still needs to accept.</p>
      <p>Funding is paused for every proposal on this problem. Either party can reject this selection before the creator accepts. Rejection refunds all contributions to the selected proposal and reopens the other proposals for funding. If the creator misses the deadline, this problem is invalidated and all still-pledged contributions to every proposal are refunded.</p><ExpiryCountdown expiresAt={state.matching.deadlineAt} />{shorterWindow && <p>The remaining posting window is shorter than seven days, so the posting deadline governs acceptance.</p>}</div>}
    {confirmed && <p className="matching-notice" role="status">Both parties approved. The selected proposal’s funds are locked. All other proposals are cancelled and their funders refunded.</p>}
    {invalidated && <div className="matching-notice" role="status"><strong>Problem invalidated</strong><p>{state.matching.invalidationReason === "posting_expired" ? "The original posting deadline passed." : "The acceptance window closed without a confirmed agreement."} All still-pledged mock contributions have been refunded. Funding and selection are closed.</p></div>}
    {reopened && <div className="matching-notice" role="status"><strong>Selection rejected · problem reopened</strong><p>The rejected proposal’s contributions were refunded. Other proposals keep their contributions and can be funded or selected until the original posting deadline.</p>{state.matching.postingExpiresAt && <ExpiryCountdown expiresAt={state.matching.postingExpiresAt} />}</div>}
    {notice && <p className="proposal-success" role="status">{notice}</p>}
    {error && !pending && <p className="error-banner" role="alert">{error}</p>}
    {loading && !state ? <p role="status">Loading funding status…</p> : null}
    {state && items.length === 0 && <p>No proposals available for funding yet.</p>}
    <div className="matching-candidates">{items.map((item) => <article className="matching-candidate" key={item.id}>
      <h3>{item.title}</h3><span className="status-dot">{proposalFundingLabel(item, state.matching)}</span>
      <p><strong>{money(item.currency, item.fundedAmount)}</strong> of {money(item.currency, item.amount)}</p>
      <p className="field-hint">{["voided", "declined", "cancelled"].includes(item.matching?.status) || invalidated ? "Funding shown is historical. Contributions have been refunded; this proposal is closed." : <>Proposal funding target: {item.fundedAmount >= item.amount ? "Met" : "Not yet met"}. {waiting ? "Funding is paused during the shared acceptance window." : confirmed ? "Matching is complete for this problem." : item.canSelect ? "You can select this proposal now." : "The problem owner selects a fully funded proposal."}</>}</p>
      {item.matching?.evaluationComplete && <p className="field-hint">Optional expert evaluation: Complete</p>}
      {receiptFor("mock_evaluation_completed", item.id) && <button type="button" className="text-button" onClick={() => showReceipt(receiptFor("mock_evaluation_completed", item.id))}>View evaluation record</button>}
      <progress aria-label={`Funding for ${item.title}`} value={item.fundedAmount} max={item.amount || 1} />
      <div className="matching-actions">
        {!proposalId && onNavigate && <button type="button" className="text-button" onClick={() => onNavigate(`proposal/${item.id}`)}>View proposal</button>}
        {item.canFund && !waiting && !confirmed && !invalidated && <button type="button" className="secondary" disabled={busy || loading} onClick={() => openAction("fund", item)}>Fund proposal</button>}
        {item.canSelect && !waiting && !confirmed && !invalidated && <button type="button" className="primary" disabled={busy || loading} onClick={() => openAction("select", item)}>Select proposal</button>}
        {item.canConfirm && waiting && <button type="button" className="primary" disabled={busy || loading} onClick={() => openAction("confirm", item)}>Accept as proposal creator</button>}
        {item.canDecline && waiting && <button type="button" className="secondary" disabled={busy || loading} onClick={() => openAction("decline", item)}>Reject selection</button>}
        {item.canCompleteEvaluation && !invalidated && <button type="button" className="secondary" disabled={busy || loading} onClick={() => openAction("evaluate", item)}>Complete mock evaluation</button>}
      </div>
    </article>)}</div>
    {!proposalId && <div className="matching-actions">
      {cursor && <button type="button" className="secondary" disabled={loading || busy} onClick={() => setPage(null)}>First proposals</button>}
      {state?.nextCursor && <button type="button" className="secondary" disabled={loading || busy} onClick={() => setPage({ problemId, cursor: state.nextCursor })}>Next proposals</button>}
    </div>}
    {contributions.length > 0 && <div className="matching-contributions"><h3>Your mock contributions</h3>{contributions.map((item) => <p key={item.id}>{money(item.currency, item.amount)} · {MATCHING_LABELS[item.status] || item.status}{item.status === "refunded" ? " to you" : ""}</p>)}</div>}
    <button className="text-button" type="button" disabled={busy || loading} onClick={refresh}>{loading ? "Refreshing…" : "Refresh funding status"}</button>
    {state?.canForceExpire && waiting && <button className="text-button danger-text" type="button" disabled={busy || loading} onClick={() => openAction("expire", { id: state.matching.proposalId, title: "Expire the current confirmation window" })}>Expire window for demonstration</button>}
    {state?.history?.length > 0 && <div className="matching-history"><h3>Decision record</h3><p className="field-hint">Off-chain receipts recorded by the server. No blockchain transaction or wallet signature is required for selection or acceptance.</p>{state.history.map((entry) => <details key={entry.id} id={`matching-event-${entry.id}`}><summary>{entry.type.replaceAll("_", " ")} · {formatInstant(entry.createdAt)}</summary><dl><dt>Actor</dt><dd>{entry.actorId || (["funding_contributed", "funding_target_reached"].includes(entry.type) ? "Private contributor" : "Scheduled expiry")}</dd><dt>Role</dt><dd>{entry.actorRole || "Member"}</dd>{entry.actorWallet && <><dt>Connected wallet</dt><dd>{entry.actorWallet}</dd></>}<dt>Proposal</dt><dd>{entry.proposalId || "All proposals"}</dd>{entry.reason && <><dt>Reason</dt><dd>{entry.reason}</dd></>}<dt>Receipt</dt><dd>Recorded off-chain</dd><dt>Record reference</dt><dd>{entry.id}</dd>{entry.deadlineAt && <><dt>Acceptance deadline</dt><dd>{formatInstant(entry.deadlineAt)}</dd>{waiting && entry.proposalId === state.matching.proposalId && <><dt>Time remaining</dt><dd><ExpiryCountdown expiresAt={state.matching.deadlineAt} showInstant={false} /></dd></>}</>}</dl>{["owner_selected", "owner_confirmed", "creator_confirmed"].includes(entry.type) && entry.proposalId ? <button type="button" className="text-button" disabled={relatedAudit?.loading} onClick={() => openProposalAudit(entry.proposalId)}>View audit receipt</button> : null}</details>)}{state.historyTruncated && <p className="field-hint">Showing the latest 100 events.</p>}</div>}
    {pending && <Modal labelledBy="matching-action-title" onDismiss={() => { if (!busy) setPending(null); }}>
      <form onSubmit={act}><div className="modal-head"><h2 id="matching-action-title">{pending.kind === "fund" ? "Fund this proposal with mock funds" : pending.kind === "select" ? "Select this proposal?" : pending.kind === "decline" ? "Reject this selection?" : pending.kind === "evaluate" ? "Complete mock expert evaluation?" : pending.kind === "expire" ? "Expire this window now?" : "Accept this selection?"}</h2></div>
        <div className="modal-body"><strong>{pending.item.title}</strong>
          {pending.kind === "fund" ? <><p>This records a simulated contribution. No wallet payment is needed.</p><label htmlFor="mock-funding-amount">Amount ({pending.item.currency})</label><input id="mock-funding-amount" type="number" inputMode="decimal" min="0.01" max={pending.remaining} step="0.01" value={amount} disabled={busy} onChange={(event) => { setAmount(event.target.value); setPending((current) => ({ ...current, requestId: crypto.randomUUID() })); }} required /></>
            : pending.kind === "select" ? <p>Selecting this proposal records your acceptance as the problem owner and starts a window of up to seven days for the creator to accept, ending sooner if the original posting deadline arrives. Either party can reject during that window: its funders will be refunded and the other proposals will reopen for funding. All proposals on this problem stop accepting funding while the selection is pending.{state?.matching?.postingExpiresAt && <> Original posting deadline: <strong>{formatInstant(state.matching.postingExpiresAt)}</strong>.</>}</p>
              : pending.kind === "decline" ? <p>The selected proposal will be excluded from further selection and all its contributions refunded. The other proposals reopen for funding, keeping their existing contributions until the original posting deadline. This rejection is recorded with your reason.</p>
                : pending.kind === "evaluate" ? <p>Administrator demo control: records an optional expert evaluation for this proposal. Evaluation is not required for selection. This is a simulated evaluation, with your account recorded in the decision history.</p>
                  : pending.kind === "expire" ? <p>Administrator demo control: immediately invalidates this problem and refunds all still-pledged contributions to every proposal.</p>
              : <p>The problem owner already accepted by selecting your proposal. Your acceptance completes the agreement and locks this proposal’s funds. All other proposals on this problem will be cancelled and their funders refunded. Rejection and reopening are no longer available once the match is confirmed.</p>}
          {["select", "decline"].includes(pending.kind) && <><label htmlFor="matching-rationale">{pending.kind === "select" ? "Selection rationale" : "Reason for rejecting"}</label><textarea id="matching-rationale" value={rationale} minLength={10} maxLength={2000} required rows={4} disabled={busy} onChange={(event) => setRationale(event.target.value)} /><p className="field-hint">Required. Recorded with your selection or rejection.</p></>}
          {error && <p className="error-banner" role="alert">{error}</p>}
        </div><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : pending.kind === "fund" ? "Record mock contribution" : pending.kind === "select" ? "Select and accept" : pending.kind === "decline" ? "Reject and refund funders" : pending.kind === "evaluate" ? "Record mock evaluation" : pending.kind === "expire" ? "Expire and refund" : "Record my acceptance"}</button></div>
      </form>
    </Modal>}
    {relatedAudit && <RelatedAuditReceiptPane kind={relatedAudit.kind} record={relatedAudit.record} loading={relatedAudit.loading} error={relatedAudit.error} onClose={() => { relatedAuditRequest.current += 1; setRelatedAudit(null); }} />}
  </section>;
}
