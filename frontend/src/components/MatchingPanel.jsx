import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { completeMockEvaluation, confirmMockProposal, declineMockProposal, forceExpireMockMatch, fundMockProposal, getMockMatching, MATCHING_LABELS, matchingError, matchingStatusLabel, selectMockProposal } from "../lib/matching.js";
import { formatInstant } from "../lib/datetime.js";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { Modal } from "./Modal.jsx";

const money = (currency, amount) => `${currency} ${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function MatchingPanel({ problemId, proposalId, onChange }) {
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
  const cursor = page && page.problemId === problemId ? page.cursor : null;
  const actionInFlight = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const generation = useRef(0);
  const readRevision = useRef(0);

  useEffect(() => {
    const version = ++generation.current;
    let reading = false;
    setState(null); setPending(null); setError(""); setNotice(""); setLoading(true);
    if (!user?.id || !problemId) { setLoading(false); return undefined; }
    const refresh = async () => {
      if (reading || actionInFlight.current) return;
      reading = true;
      const read = ++readRevision.current;
      try {
        const next = await getMockMatching(problemId, { proposalId, cursor });
        if (version === generation.current && read === readRevision.current) {
          setState(next); setError(""); onChangeRef.current?.(next);
        }
      } catch (err) { if (version === generation.current && read === readRevision.current) setError(matchingError(err)); }
      finally { reading = false; if (version === generation.current) setLoading(false); }
    };
    void refresh();
    const timer = setInterval(refresh, 30_000);
    return () => { generation.current++; clearInterval(timer); };
  }, [problemId, proposalId, cursor, user?.id]);

  const refresh = async () => {
    const version = generation.current;
    const read = ++readRevision.current;
    setLoading(true);
    try {
      const next = await getMockMatching(problemId, { proposalId, cursor });
      if (version === generation.current && read === readRevision.current) { setState(next); setError(""); onChangeRef.current?.(next); }
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
        ? "Proposal selected. Its creator now has seven days to confirm."
        : pending.kind === "decline" ? "Selection declined. Your funders are refunded and the other proposals can be funded or selected again."
          : pending.kind === "evaluate" ? "Mock expert evaluation completed. The funding target must also be met before selection."
            : pending.kind === "expire" ? "The confirmation window was expired for this demonstration. The selected proposal is voided and its funders refunded."
              : "Match confirmed. Funding is locked and the other proposals are cancelled and refunded.");
      setPending(null);
      await refresh();
    } catch (err) { if (version === generation.current) setError(matchingError(err)); }
    finally { actionInFlight.current = false; setBusy(false); }
  };

  if (!user?.id || !problemId) return null;
  const waiting = state?.matching?.status === "awaiting_confirmation";
  const confirmed = state?.matching?.status === "confirmed";
  const items = (state?.proposals ?? []).filter((item) => !proposalId || item.id === proposalId);
  const contributions = (state?.contributions ?? []).filter((item) => !proposalId || item.proposalId === proposalId);
  const receiptFor = (type, id) => state?.history?.find((entry) => entry.type === type && (!id || entry.proposalId === id));
  const showReceipt = (entry) => {
    const element = document.getElementById(`matching-event-${entry.id}`);
    if (element) { element.open = true; element.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); }
  };
  const openAction = (kind, item) => {
    setError(""); setRationale("");
    const remaining = Math.max(0, Math.round((item.amount - item.fundedAmount) * 100) / 100);
    setAmount(String(remaining));
    setPending({ kind, item, remaining, requestId: kind === "fund" ? crypto.randomUUID() : null });
  };

  return <section id="proposal-funding" className="detail-section matching-panel" aria-label="Proposal funding and matching">
    <div className="matching-heading"><h2>Funding & matching</h2><span className="draft-badge">Mock funds</span></div>
    <p>Simulated contributions and refunds. No wallet funds are transferred.</p>
    <ol className="matching-steps"><li>Complete expert evaluation and fund a proposal to its target.</li><li>The problem owner selects and approves one, recording their reason.</li><li>Its creator accepts or declines within seven days.</li></ol>
    {state?.matching?.ownerApprovedBy && <dl className="matching-approval"><dt>Problem owner approved</dt><dd>{state.matching.ownerApprovedBy} · {formatInstant(state.matching.ownerApprovedAt)}</dd><dt>Selection reason</dt><dd>{state.matching.rationale}</dd><dt>Creator approval</dt><dd>{state.matching.creatorApprovedAt ? `Approved ${formatInstant(state.matching.creatorApprovedAt)}` : "Awaiting creator response"}</dd></dl>}
    {receiptFor("owner_selected", state?.matching?.proposalId) && state?.matching?.ownerApprovedBy && <button type="button" className="text-button" onClick={() => showReceipt(receiptFor("owner_selected", state.matching.proposalId))}>View owner approval record</button>}
    {receiptFor("creator_confirmed", state?.matching?.proposalId) && confirmed && <button type="button" className="text-button" onClick={() => showReceipt(receiptFor("creator_confirmed", state.matching.proposalId))}>View creator approval record</button>}
    {waiting && <div className="matching-notice" role="status"><strong>Waiting for the selected creator</strong><p>Funding is paused for every proposal on this problem. If the creator misses the deadline, their proposal is voided and all its funders are refunded. The other proposals can then receive funding again.</p><ExpiryCountdown expiresAt={state.matching.deadlineAt} /></div>}
    {confirmed && <p className="matching-notice" role="status">Both parties approved. The selected proposal’s funds are locked. All other proposals are cancelled and their funders refunded.</p>}
    {notice && <p className="proposal-success" role="status">{notice}</p>}
    {error && !pending && <p className="error-banner" role="alert">{error}</p>}
    {loading && !state ? <p role="status">Loading funding status…</p> : null}
    {state && items.length === 0 && <p>No proposals available for funding yet.</p>}
    <div className="matching-candidates">{items.map((item) => <article className="matching-candidate" key={item.id}>
      <h3>{item.title}</h3><span className="status-dot">{matchingStatusLabel(item.matching?.status)}</span>
      <p><strong>{money(item.currency, item.fundedAmount)}</strong> of {money(item.currency, item.amount)}</p>
      <p className="field-hint">Expert evaluation: {item.matching?.evaluationComplete ? "Complete" : "Pending"} · Funding target: {item.fundedAmount >= item.amount ? "Met" : "Not yet met"}</p>
      {receiptFor("mock_evaluation_completed", item.id) && <button type="button" className="text-button" onClick={() => showReceipt(receiptFor("mock_evaluation_completed", item.id))}>View evaluation record</button>}
      <progress aria-label={`Funding for ${item.title}`} value={item.fundedAmount} max={item.amount || 1} />
      <div className="matching-actions">
        {item.canFund && !waiting && !confirmed && <button type="button" className="secondary" disabled={busy || loading} onClick={() => openAction("fund", item)}>Fund proposal</button>}
        {item.canSelect && !waiting && !confirmed && <button type="button" className="primary" disabled={busy || loading} onClick={() => openAction("select", item)}>Select proposal</button>}
        {item.canConfirm && waiting && <button type="button" className="primary" disabled={busy || loading} onClick={() => openAction("confirm", item)}>Confirm I will work on this problem</button>}
        {item.canConfirm && waiting && <button type="button" className="secondary" disabled={busy || loading} onClick={() => openAction("decline", item)}>Decline selection</button>}
        {item.canCompleteEvaluation && <button type="button" className="secondary" disabled={busy || loading} onClick={() => openAction("evaluate", item)}>Complete mock evaluation</button>}
      </div>
    </article>)}</div>
    {!proposalId && <div className="matching-actions">
      {cursor && <button type="button" className="secondary" disabled={loading || busy} onClick={() => setPage(null)}>First proposals</button>}
      {state?.nextCursor && <button type="button" className="secondary" disabled={loading || busy} onClick={() => setPage({ problemId, cursor: state.nextCursor })}>Next proposals</button>}
    </div>}
    {contributions.length > 0 && <div className="matching-contributions"><h3>Your mock contributions</h3>{contributions.map((item) => <p key={item.id}>{money(item.currency, item.amount)} · {MATCHING_LABELS[item.status] || item.status}{item.status === "refunded" ? " to you" : ""}</p>)}</div>}
    <button className="text-button" type="button" disabled={busy || loading} onClick={refresh}>{loading ? "Refreshing…" : "Refresh funding status"}</button>
    {state?.canForceExpire && waiting && <button className="text-button danger-text" type="button" disabled={busy || loading} onClick={() => openAction("expire", { id: state.matching.proposalId, title: "Expire the current confirmation window" })}>Expire window for demonstration</button>}
    {state?.history?.length > 0 && <div className="matching-history"><h3>Decision record</h3><p className="field-hint">Server records for this mock workflow. On-chain recording will be connected when the contract is ready.</p>{state.history.map((entry) => <details key={entry.id} id={`matching-event-${entry.id}`}><summary>{entry.type.replaceAll("_", " ")} · {formatInstant(entry.createdAt)}</summary><dl><dt>Actor</dt><dd>{entry.actorId || (["funding_contributed", "funding_target_reached"].includes(entry.type) ? "Private contributor" : "Scheduled expiry")}</dd><dt>Proposal</dt><dd>{entry.proposalId}</dd>{entry.reason && <><dt>Reason</dt><dd>{entry.reason}</dd></>}<dt>Record reference</dt><dd>{entry.id}</dd></dl></details>)}{state.historyTruncated && <p className="field-hint">Showing the latest 100 events.</p>}</div>}
    {pending && <Modal labelledBy="matching-action-title" onDismiss={() => { if (!busy) setPending(null); }}>
      <form onSubmit={act}><div className="modal-head"><h2 id="matching-action-title">{pending.kind === "fund" ? "Fund this proposal with mock funds" : pending.kind === "select" ? "Select this proposal?" : pending.kind === "decline" ? "Decline this selection?" : pending.kind === "evaluate" ? "Complete mock expert evaluation?" : pending.kind === "expire" ? "Expire this window now?" : "Confirm this match?"}</h2></div>
        <div className="modal-body"><strong>{pending.item.title}</strong>
          {pending.kind === "fund" ? <><p>This records a simulated contribution. No wallet payment is needed.</p><label htmlFor="mock-funding-amount">Amount ({pending.item.currency})</label><input id="mock-funding-amount" type="number" inputMode="decimal" min="0.01" max={pending.remaining} step="0.01" value={amount} disabled={busy} onChange={(event) => { setAmount(event.target.value); setPending((current) => ({ ...current, requestId: crypto.randomUUID() })); }} required /></>
            : pending.kind === "select" ? <p>Your approval starts a seven-day confirmation window for the creator. All proposals on this problem stop accepting funding during that window.</p>
              : pending.kind === "decline" ? <p>Your proposal will be excluded from further selection and all its funders refunded. The problem reopens for the other proposals.</p>
                : pending.kind === "evaluate" ? <p>Administrator demo control: records the expert evaluation gate as complete for this proposal. This is a simulated evaluation, with your account recorded in the decision history.</p>
                  : pending.kind === "expire" ? <p>Administrator demo control: immediately voids the selected proposal, refunds its funders and reopens the other proposals.</p>
              : <p>You agree to work on this problem. Your proposal’s funding will be locked. All other proposals on this problem will be cancelled and their funders refunded.</p>}
          {["select", "decline"].includes(pending.kind) && <><label htmlFor="matching-rationale">{pending.kind === "select" ? "Selection rationale" : "Reason for declining"}</label><textarea id="matching-rationale" value={rationale} minLength={10} maxLength={2000} required rows={4} disabled={busy} onChange={(event) => setRationale(event.target.value)} /><p className="field-hint">Required. Recorded with your approval or decline.</p></>}
          {error && <p className="error-banner" role="alert">{error}</p>}
        </div><div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setPending(null)}>Cancel</button><button type="submit" className="primary" disabled={busy}>{busy ? "Saving…" : pending.kind === "fund" ? "Record mock contribution" : pending.kind === "select" ? "Select and start seven days" : pending.kind === "decline" ? "Decline and refund funders" : pending.kind === "evaluate" ? "Record mock evaluation" : pending.kind === "expire" ? "Expire and refund" : "Confirm and lock funding"}</button></div>
      </form>
    </Modal>}
  </section>;
}
