import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { ROLES } from "../config/roles.js";
import { getEscrowAdminCancellation, startEscrowAdminCancellation } from "../lib/escrowAdmin.js";
import { escrowErrorMessage } from "../lib/escrow.js";
import { escrowExplorer } from "../lib/escrowFunding.js";
import { FundingProgress } from "./FundingProgress.jsx";
import { EscrowLifecycleBadge } from "./EscrowLifecycle.jsx";
import { EscrowCustodyNotice } from "./EscrowCustodyNotice.jsx";
import { Field } from "./Field.jsx";
import { Modal } from "./Modal.jsx";

/** Cancellation uses the authenticated administrator's server request, then
 * the existing allowlisted platform relay. A queued request is never a refund.
 * Depositors claim with their own Privy wallet after confirmed cancellation. */
export function AdminEscrowCancellation({ proposalId, onConfirmed }) {
  const { user, hasRole } = useAuth();
  const admin = Boolean(user?.id && hasRole?.(ROLES.ADMIN) && !user.isSuspended);
  if (!admin || !proposalId) return null;
  return <CancellationView key={`${user.id}:${proposalId}`} proposalId={proposalId} onConfirmed={onConfirmed} user={user} />;
}

function CancellationView({ proposalId, onConfirmed, user }) {
  const admin = true;
  const [data, setData] = useState(null), [reason, setReason] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
  const version = useRef(0), pending = useRef(null), writing = useRef(false);
  const confirmedRequest = useRef(null);
  const identity = `${user?.id}:${proposalId}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const notifyConfirmed = next => {
    const request = next?.cancellation ?? next?.request;
    const key = request?.id ?? request?.requestId ?? request?.transactionHash;
    if (request?.status === "complete" && key && confirmedRequest.current !== key) {
      confirmedRequest.current = key; onConfirmed?.();
    }
  };
  const refresh = async () => {
    if (!admin || !proposalId || writing.current) return;
    const token = ++version.current, account = identity;
    setBusy(true); setError("");
    try {
      const next = await getEscrowAdminCancellation({ proposalId });
      if (version.current === token && currentIdentity.current === account) { setData(next); notifyConfirmed(next); }
    } catch (err) { if (version.current === token && currentIdentity.current === account) setError(escrowErrorMessage(err)); }
    finally { if (version.current === token && currentIdentity.current === account) setBusy(false); }
  };
  useEffect(() => {
    setData(null); setReason(""); setConfirm(false); pending.current = null;
    if (admin && proposalId) void refresh();
    return () => { version.current++; };
  }, [identity, admin]);
  if (!admin || !proposalId) return null;
  const job = data?.cancellation ?? data?.request;
  const complete = job?.status === "complete";
  const reasonValid = Boolean(reason.trim() && reason.trim().length <= 2000);
  const canCancel = !busy && !error && data?.canCancel === true && !job;
  const submit = async () => {
    if (!canCancel || !reasonValid || writing.current) return;
    writing.current = true;
    const token = ++version.current, account = identity, text = reason.trim();
    pending.current = pending.current?.reason === text ? pending.current
      : { requestId: globalThis.crypto.randomUUID(), reason: text };
    setBusy(true); setError("");
    try {
      const next = await startEscrowAdminCancellation({ proposalId, ...pending.current });
      if (version.current !== token || currentIdentity.current !== account) return;
      setData(previous => ({ ...previous, ...next, summary: next.summary ?? null, canCancel: false })); setConfirm(false);
      notifyConfirmed(next);
    } catch (err) { if (version.current === token && currentIdentity.current === account) setError(escrowErrorMessage(err)); }
    finally { writing.current = false; if (version.current === token && currentIdentity.current === account) setBusy(false); }
  };
  return <section className="detail-section admin-escrow-cancellation" aria-label="Administrator escrow cancellation">
    <header className="escrow-admin-heading"><div><h3>Administrator escrow cancellation</h3><p className="field-hint">Cancel an unpaid escrow with a recorded reason. Contributors claim their exact deposits through the standard refund path.</p></div>
      <button type="button" className="secondary" disabled={busy} onClick={refresh}>Refresh cancellation</button></header>
    {busy && !data && <p role="status">Checking confirmed escrow custody…</p>}
    {error && <p role="alert" className="error-banner">{error} Refresh cancellation before retrying an uncertain request.</p>}
    {data?.summary && <div className="escrow-admin-summary">
      <div className="escrow-admin-summary-heading"><div><span className="escrow-admin-caption">Confirmed escrow</span>{data.title && <h4>{data.title}</h4>}</div><EscrowLifecycleBadge summary={data.summary} compact stale={Boolean(error)} /></div>
      <FundingProgress summary={data.summary} compact stale={Boolean(error)} />
      <EscrowCustodyNotice summary={data.summary} compact stale={Boolean(error)} />
    </div>}
    {job ? <div className="escrow-admin-status" role="status"><strong>{complete ? "Cancellation confirmed. Refunds are available to claim." : job.status === "blocked" ? "Cancellation is blocked." : "Cancellation is pending confirmation. Funds have not been refunded."}</strong>
      <p>Reason: {job.reason}</p>{job.message && <p>{job.message}</p>}
      {job.transactionHash && <a href={escrowExplorer("tx", job.transactionHash)} target="_blank" rel="noreferrer">{complete ? "Confirmed cancellation transaction" : "Pending cancellation transaction"}</a>}
      {complete && job.transactionHash && <p><a href={`${escrowExplorer("tx", job.transactionHash)}#eventlog`} target="_blank" rel="noreferrer">Anchored cancellation receipt</a></p>}
      {complete && <p className="field-hint">No tokens are sent to the administrator. Depositors claim with their QC DAO wallet; the dashboard updates after each confirmed claim.</p>}
    </div> : <div className="escrow-admin-cancel-form">
      {data?.blockReason && <p role="status" className="field-hint">{data.blockReason}</p>}
      <Field label="Cancellation reason" htmlFor={`escrow-cancel-reason-${proposalId}`} hint="Required. This reason is recorded and anchored on-chain.">
        {({ id, describedBy }) => <textarea id={id} aria-describedby={describedBy} rows={4} value={reason} maxLength={2000} required disabled={busy || data?.canCancel !== true} onChange={event => setReason(event.target.value)} />}
      </Field>
      <div className="escrow-admin-actions"><button type="button" className="danger-btn" disabled={!canCancel || !reasonValid} onClick={() => setConfirm(true)}>Cancel escrow</button></div>
    </div>}
    {confirm && <Modal className="escrow-cancel-modal" labelledBy="escrow-cancel-title" describedBy="escrow-cancel-description" onDismiss={() => { if (!busy) setConfirm(false); }}>
      <div className="modal-head"><h2 id="escrow-cancel-title">Cancel this unpaid escrow?</h2></div>
      <div className="modal-body"><p id="escrow-cancel-description">Approved cancellation ends this escrow and opens manual refunds for its depositors. It cannot redirect money or cancel an escrow after a payment has been released.</p>
        <div className="escrow-admin-recorded-reason"><strong>Cancellation reason</strong><p>{reason.trim()}</p></div></div>
      <div className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setConfirm(false)}>Keep escrow</button>
        <button type="button" className="danger-btn" disabled={busy || !canCancel || !reasonValid} onClick={submit}>{busy ? "Requesting cancellation…" : "Confirm cancellation"}</button></div>
    </Modal>}
  </section>;
}

export function EscrowAdministration({ onNavigate }) {
  const [value, setValue] = useState(""), [selected, setSelected] = useState("");
  return <section className="card-table escrow-administration"><div className="table-header"><div><h2>Escrow administration</h2><p>Open an unpaid main-workflow or accepted grant proposal escrow. Independent crowdfunding keeps its dedicated cancellation workflow.</p></div></div>
    <div className="escrow-administration-body">
    <form className="escrow-admin-lookup" onSubmit={event => { event.preventDefault(); setSelected(value.trim()); }}>
      <label>Proposal reference<input value={value} maxLength={128} onChange={event => setValue(event.target.value)} /></label>
      <button className="secondary" type="submit" disabled={!/^[A-Za-z0-9_-]{1,128}$/.test(value.trim())}>Inspect escrow</button>
    </form>
    {selected && <div className="escrow-admin-result"><div className="escrow-admin-result-bar"><p>Proposal <code>{selected}</code></p><button type="button" className="text-button" onClick={() => onNavigate?.(`proposal/${selected}?tab=funding`)}>Open proposal funding <span aria-hidden="true">↗</span></button></div><AdminEscrowCancellation key={selected} proposalId={selected} /></div>}
    </div>
  </section>;
}
