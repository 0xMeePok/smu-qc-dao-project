import { messageForProposalError } from "../lib/proposalValidation.js";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useAuth } from "../context/AuthContext.jsx";
import { findProposal, withdrawProposal } from "../lib/proposals.js";
import { anchorProposalAudit, anchorProposalWithdrawal, proposalAuditReceipt, readProposalAudit } from "../lib/proposalAudit.js";
import { auditErrorMessage } from "../lib/errors.js";
import { downloadAttachment, saveBlobAs } from "../lib/attachments.js";
import { formatInstant } from "../lib/datetime.js";
import { AuditReceipt } from "../components/AuditReceipt.jsx";
import { ConnectWalletModal } from "../components/ConnectWalletModal.jsx";
import { Modal } from "../components/Modal.jsx";
import { Field } from "../components/Field.jsx";
import { ProposalRevisionTrail } from "../components/ProposalRevisionTrail.jsx";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS, PROPOSAL_CATEGORIES } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";

// `justSubmitted` only shows the confirmation banner. Anchoring is done before
// the record is written now, so this page never starts one on its own; the retry
// control below is for a receipt that was left in flight.
export default function ProposalDetailPage({ proposalId, onNavigate, autoAnchor = false, justSubmitted = false }) {
  const { user } = useAuth();
  const { address, isConnected } = useAccount();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [auditBusy, setAuditBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [walletPromptOpen, setWalletPromptOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  // Survives a Firestore write that failed after the chain already accepted the
  // withdrawal, so retrying finishes the record instead of sending a second
  // withdrawProposal that would revert — and so the anchored reason cannot be
  // edited into something the receipt no longer describes.
  const [anchoredWithdrawal, setAnchoredWithdrawal] = useState(null);
  const started = useRef(false);
  const anchorInFlight = useRef(new Set());
  const activeProposalId = useRef(proposalId);
  activeProposalId.current = proposalId;
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setProposal(null); setError(""); setConfirm(false);
    setReason(""); setReasonError(""); setAnchoredWithdrawal(null);
    setAuditBusy(anchorInFlight.current.has(proposalId)); started.current = false;
    findProposal(proposalId).then((record) => { if (!cancelled) setProposal(record); })
      .catch((err) => { if (!cancelled) setError(messageForProposalError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [proposalId]);
  const owns = Boolean(proposal && user?.id?.toLowerCase() === proposal.researcherId);
  const anchor = async (record = proposal, promptForWallet = true) => {
    if (!record || anchorInFlight.current.has(record.id)) return;
    if (!record.audit?.transactionHash && (!isConnected || address?.toLowerCase() !== record.researcherId)) {
      setError("Your proposal is saved. Connect the wallet that submitted it to start verification.");
      if (promptForWallet) setWalletPromptOpen(true);
      return;
    }
    anchorInFlight.current.add(record.id);
    setAuditBusy(true); setError("");
    try { await anchorProposalAudit(record, { account: address, onChange: (audit) => setProposal((old) => old?.id === record.id ? { ...old, audit } : old) }); }
    catch (err) { if (activeProposalId.current === record.id) setError(`Your proposal is saved. ${auditErrorMessage(err)}`); }
    finally { anchorInFlight.current.delete(record.id); if (activeProposalId.current === record.id) setAuditBusy(false); }
  };
  useEffect(() => {
    if (autoAnchor && proposal && owns && !started.current) { started.current = true; void anchor(proposal, false); }
  }, [autoAnchor, proposal, owns]);
  useEffect(() => {
    if (!proposal || auditBusy || proposal.audit?.status === "confirmed") return;
    let active = true;
    const timer = setInterval(() => {
      findProposal(proposalId, { fromServer: true }).then((current) => {
        if (active && current) setProposal(current);
      }).catch(() => { /* Keep the saved record visible while offline. */ });
    }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [proposalId, Boolean(proposal), auditBusy, proposal?.audit?.status]);
  const withdraw = async () => {
    const withdrawalReason = (anchoredWithdrawal?.reason ?? reason).trim();
    if (!anchoredWithdrawal) {
      if (withdrawalReason.length < 2) { setReasonError("Give a reason for withdrawing this proposal."); return; }
      if (withdrawalReason.length > 1000) { setReasonError("Use 1,000 characters or fewer."); return; }
      // Both sides lowercased: comparing against a stored value that is not
      // already lowercase told the author to connect the wallet they were on.
      if (!isConnected || address?.toLowerCase() !== proposal.researcherId?.toLowerCase()) {
        setReasonError("Connect the wallet that submitted this proposal to sign the withdrawal.");
        return;
      }
    }
    setWithdrawing(true); setError(""); setReasonError("");
    let anchored = anchoredWithdrawal;
    try {
      if (!anchored) {
        await anchorProposalWithdrawal(proposal, { account: address, reason: withdrawalReason });
        anchored = { reason: withdrawalReason };
        setAnchoredWithdrawal(anchored);
        setReason(withdrawalReason);
      }
      await withdrawProposal(proposalId, anchored.reason);
      setProposal((old) => ({ ...old, status: "withdrawn", withdrawalReason: anchored.reason }));
      setConfirm(false);
      setAnchoredWithdrawal(null);
    }
    catch (err) {
      setError(anchored
        ? `The withdrawal was recorded on Arbitrum Sepolia, but saving it failed. ${messageForProposalError(err)} Finish saving it with the same reason — you will not be asked to sign again.`
        : auditErrorMessage(err));
      if (!anchored) setConfirm(false);
    }
    finally { setWithdrawing(false); }
  };
  const download = async (attachment) => {
    try { saveBlobAs(await downloadAttachment({ attachment, ownerId: proposal.researcherId, problemId: proposal.id, scope: "proposals" }), attachment.name); }
    catch (err) { setError(messageForProposalError(err)); }
  };
  if (loading) return <section className="page empty" role="status">Loading proposal…</section>;
  if (!proposal) return <section className="page empty"><h1>Proposal unavailable</h1><p role="alert">{error || "This proposal could not be found or you do not have access."}</p><button className="secondary" onClick={() => onNavigate("proposals")}>My proposals</button></section>;
  const isOpenFunding = proposal.opportunityType === OPEN_FUNDING_TYPE;
  const sponsors = Boolean(user?.id && proposal.postingOwnerId === user.id.toLowerCase());
  return <section className="page detail-page">
    <button className="back" onClick={() => onNavigate(owns ? "proposals" : "funding")}>{owns ? "Back to my proposals" : "Back to funding portfolio"}</button>
    {(justSubmitted || autoAnchor) && <p className="proposal-success" role="status">Proposal submitted successfully. Check the on-chain verification below for its current integrity status.</p>}
    {error && !confirm && <p className="error-banner" role="alert">{error}</p>}
    <div className="detail-layout"><article className="detail-main"><span className="eyebrow">{isOpenFunding ? "Problem + solution proposal" : "Solution proposal"}</span><h1>{proposal.title}</h1><p className="lead">{proposal.summary}</p>
      {isOpenFunding && <p>The funder acts as the problem owner for selection. This proposal follows the same evaluation, selection and approval process as proposals for funded problems.</p>}
      {[...PROPOSAL_FIELDS.slice(2), ...(isOpenFunding ? PROBLEM_FRAMING_FIELDS : [])].map(([key, label]) => proposal[key] && <div className="detail-section" key={key}><h2>{label}</h2><p className="proposal-text">{proposal[key]}</p></div>)}
      {proposal.attachments?.length > 0 && <div className="detail-section"><h2>Supporting attachments</h2>{proposal.attachments.map((item) => <p key={item.id}><button className="text-button" onClick={() => download(item)}>Download {item.name}</button></p>)}</div>}
      {proposal.status === "withdrawn" && proposal.withdrawalReason && <div className="detail-section"><h2>Withdrawal reason</h2><p className="proposal-text">{proposal.withdrawalReason}</p></div>}
      {(owns || sponsors) && <ProposalRevisionTrail proposalId={proposal.id} field={owns ? "researcherId" : "postingOwnerId"} uid={user.id} />}
      <AuditReceipt entityLabel="Proposal" audit={proposalAuditReceipt(proposal)} eventLabel="Proposal submitted" actorRole="Researcher / solution developer" firebaseReference={`proposals/${proposal.id}`} onVerify={() => readProposalAudit(proposal)} onRetry={owns && !auditBusy ? () => anchor() : undefined} />
      {auditBusy && <p role="status">Verifying your saved proposal… You can continue using the app.</p>}
    </article><aside className="context-panel"><span className="status-dot">{proposal.status}</span><strong>{proposal.currency} {Number(proposal.amount).toLocaleString()}</strong><p>{PROPOSAL_CATEGORIES.find((item) => item.value === proposal.category)?.label}</p><dl><dt>Submitted</dt><dd>{formatInstant(proposal.createdAt)}</dd></dl><button className="secondary" onClick={() => onNavigate(`posting/${proposal.problemId}`)}>View opportunity</button>
      {/* Editable only while `submitted`. `under_review` means an evaluator has
          the proposal open, and firestore.rules refuses a content write from
          that point on. */}
      {owns && proposal.status === "submitted" && <button className="secondary" onClick={() => onNavigate(`edit-proposal/${proposal.id}`)}>Edit proposal</button>}
      {owns && ["submitted", "under_review"].includes(proposal.status) && <button className="secondary" disabled={withdrawing} onClick={() => setConfirm(true)}>Withdraw proposal</button>}
      {owns && proposal.status === "withdrawn" && <button className="primary" onClick={() => onNavigate(`submit-proposal/${proposal.problemId}`)}>Submit a replacement</button>}
    </aside></div>
    {walletPromptOpen && <ConnectWalletModal onClose={() => setWalletPromptOpen(false)} />}
    {confirm && <Modal labelledBy="withdraw-proposal-title" describedBy="withdraw-proposal-desc" onDismiss={() => { if (!withdrawing) setConfirm(false); }}>
      <div className="modal-head">
        <div>
          <h2 id="withdraw-proposal-title">Withdraw this proposal?</h2>
          <p id="withdraw-proposal-desc">It leaves evaluation and selection immediately. You can submit a new proposal while the opportunity remains open.</p>
        </div>
      </div>
      <div className="modal-body">
        <Field htmlFor="withdrawal-reason" label="Why are you withdrawing?" error={reasonError} hint="A hash of this exact text is anchored on Arbitrum Sepolia, and the text is shown to the sponsor. It cannot be changed afterwards.">
          {({ id, describedBy, invalid }) => <textarea id={id} rows={3} value={anchoredWithdrawal?.reason ?? reason} maxLength={1000} disabled={withdrawing || Boolean(anchoredWithdrawal)} aria-describedby={describedBy} aria-invalid={invalid} onChange={(event) => { if (anchoredWithdrawal) return; setReason(event.target.value); setReasonError(""); }} />}
        </Field>
        {error && anchoredWithdrawal ? <p className="error-banner" role="alert">{error}</p> : null}
        <p className="field-hint">{anchoredWithdrawal
          ? "The withdrawal is already signed on Arbitrum Sepolia. Saving it does not need another signature."
          : "Your wallet signs the withdrawal before it takes effect. If you decline, the proposal stays in evaluation exactly as it is."}</p>
      </div>
      <div className="modal-actions"><button className="secondary" disabled={withdrawing || Boolean(anchoredWithdrawal)} onClick={() => setConfirm(false)}>Keep proposal</button><button className="danger-btn" disabled={withdrawing} onClick={withdraw}>{withdrawing ? (anchoredWithdrawal ? "Saving…" : "Waiting for your wallet…") : (anchoredWithdrawal ? "Finish saving withdrawal" : "Sign and withdraw")}</button></div>
    </Modal>}
  </section>;
}
