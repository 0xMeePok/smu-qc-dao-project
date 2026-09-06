import { messageForProposalError } from "../lib/proposalValidation.js";
import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { useAuth } from "../context/AuthContext.jsx";
import { findProposal, withdrawProposal } from "../lib/proposals.js";
import { anchorProposalAudit, proposalAuditReceipt, readProposalAudit } from "../lib/proposalAudit.js";
import { auditErrorMessage } from "../lib/errors.js";
import { downloadAttachment, saveBlobAs } from "../lib/attachments.js";
import { formatInstant } from "../lib/datetime.js";
import { AuditReceipt } from "../components/AuditReceipt.jsx";
import { ConnectWalletModal } from "../components/ConnectWalletModal.jsx";
import { Modal } from "../components/Modal.jsx";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS, PROPOSAL_CATEGORIES } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";

export default function ProposalDetailPage({ proposalId, onNavigate, autoAnchor = false }) {
  const { user } = useAuth();
  const { address, isConnected } = useAccount();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [auditBusy, setAuditBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [walletPromptOpen, setWalletPromptOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const started = useRef(false);
  const anchorInFlight = useRef(new Set());
  const activeProposalId = useRef(proposalId);
  activeProposalId.current = proposalId;
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setProposal(null); setError(""); setConfirm(false);
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
    setWithdrawing(true); setError("");
    try { await withdrawProposal(proposalId); setProposal((old) => ({ ...old, status: "withdrawn" })); setConfirm(false); }
    catch (err) { setError(messageForProposalError(err)); }
    finally { setWithdrawing(false); }
  };
  const download = async (attachment) => {
    try { saveBlobAs(await downloadAttachment({ attachment, ownerId: proposal.researcherId, problemId: proposal.id, scope: "proposals" }), attachment.name); }
    catch (err) { setError(messageForProposalError(err)); }
  };
  if (loading) return <section className="page empty" role="status">Loading proposal…</section>;
  if (!proposal) return <section className="page empty"><h1>Proposal unavailable</h1><p role="alert">{error || "This proposal could not be found or you do not have access."}</p><button className="secondary" onClick={() => onNavigate("proposals")}>My proposals</button></section>;
  const isOpenFunding = proposal.opportunityType === OPEN_FUNDING_TYPE;
  return <section className="page detail-page">
    <button className="back" onClick={() => onNavigate(owns ? "proposals" : "funding")}>{owns ? "Back to my proposals" : "Back to funding portfolio"}</button>
    {autoAnchor && <p className="proposal-success" role="status">Proposal submitted successfully. Your submission is saved.</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="detail-layout"><article className="detail-main"><span className="eyebrow">{isOpenFunding ? "Problem + solution proposal" : "Solution proposal"}</span><h1>{proposal.title}</h1><p className="lead">{proposal.summary}</p>
      {isOpenFunding && <p>The funder acts as the problem owner for selection. This proposal follows the same evaluation, selection and approval process as proposals for funded problems.</p>}
      {[...PROPOSAL_FIELDS.slice(2), ...(isOpenFunding ? PROBLEM_FRAMING_FIELDS : [])].map(([key, label]) => proposal[key] && <div className="detail-section" key={key}><h2>{label}</h2><p className="proposal-text">{proposal[key]}</p></div>)}
      {proposal.attachments?.length > 0 && <div className="detail-section"><h2>Supporting attachments</h2>{proposal.attachments.map((item) => <p key={item.id}><button className="text-button" onClick={() => download(item)}>Download {item.name}</button></p>)}</div>}
      <AuditReceipt entityLabel="Proposal" audit={proposalAuditReceipt(proposal)} eventLabel="Proposal submitted" actorRole="Researcher / solution developer" firebaseReference={`proposals/${proposal.id}`} onVerify={() => readProposalAudit(proposal)} onRetry={owns && !auditBusy ? () => anchor() : undefined} />
      {auditBusy && <p role="status">Verifying your saved proposal… You can continue using the app.</p>}
    </article><aside className="context-panel"><span className="status-dot">{proposal.status}</span><strong>{proposal.currency} {Number(proposal.amount).toLocaleString()}</strong><p>{PROPOSAL_CATEGORIES.find((item) => item.value === proposal.category)?.label}</p><dl><dt>Submitted</dt><dd>{formatInstant(proposal.createdAt)}</dd></dl><button className="secondary" onClick={() => onNavigate(`posting/${proposal.problemId}`)}>View opportunity</button>
      {owns && ["submitted", "under_review"].includes(proposal.status) && <button className="secondary" disabled={withdrawing} onClick={() => setConfirm(true)}>Withdraw proposal</button>}
      {owns && proposal.status === "withdrawn" && <button className="primary" onClick={() => onNavigate(`submit-proposal/${proposal.problemId}`)}>Submit a replacement</button>}
    </aside></div>
    {walletPromptOpen && <ConnectWalletModal onClose={() => setWalletPromptOpen(false)} />}
    {confirm && <Modal labelledBy="withdraw-proposal-title" onDismiss={() => { if (!withdrawing) setConfirm(false); }}><h2 id="withdraw-proposal-title">Withdraw this proposal?</h2><p>It will leave consideration. You can submit a new proposal while the opportunity remains open.</p><div className="modal-actions"><button className="secondary" disabled={withdrawing} onClick={() => setConfirm(false)}>Keep proposal</button><button className="danger-btn" disabled={withdrawing} onClick={withdraw}>{withdrawing ? "Withdrawing…" : "Confirm withdrawal"}</button></div></Modal>}
  </section>;
}
