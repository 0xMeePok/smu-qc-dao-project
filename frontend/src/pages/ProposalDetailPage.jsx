import { messageForProposalError } from "../lib/proposalValidation.js";
import { EscrowPaymentPlanSummary } from "../components/EscrowPaymentPlanSummary.jsx";
import { EscrowFundingPanel } from "../components/EscrowFundingPanel.jsx";
import { readEscrow } from "../lib/escrow.js";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import { OwnerReviewPanel } from "../components/OwnerReviewPanel.jsx";
import { ProposalRevisionTrail } from "../components/ProposalRevisionTrail.jsx";
import { PROPOSAL_CATEGORIES, PROPOSAL_MATURITY_LEVELS, independentListingWindowOpen, isIndependentProposal } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { MatchingPanel } from "../components/MatchingPanel.jsx";
import { getMockMatching, mergeMatchingState, proposalFundingStatus, proposalMatchingLocked } from "../lib/matching.js";
import { recommendationCounts, recommendationEntries } from "../config/workflowStatus.js";
import { EvaluationBadges, StatusBadge } from "../components/StatusBadge.jsx";
import { ExpiryCountdown } from "../components/ExpiryCountdown.jsx";
import { isModerated } from "../lib/moderation.js";
import { ContentModerationNotice, ReportContentButton } from "../components/ReportContentButton.jsx";
import { ReportableComments } from "../components/ReportableComments.jsx";
import { VerifiedBadge } from "../components/VerifiedBadge.jsx";
import { DetailGroup, DetailItem } from "../components/DetailGroup.jsx";

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
  const [tab, setTab] = useState("overview");
  const [escrowState, setEscrowState] = useState(null);
  useEffect(() => {
    const fundingStarted = proposal?.fundingTerms ? escrowState?.totalDeposited > 0n : proposalMatchingLocked(proposal)
      || ["awaiting_confirmation", "confirmed", "invalidated"].includes(proposal?.problemMatching?.status);
    if (confirm && !anchoredWithdrawal && !withdrawing && fundingStarted) {
      setConfirm(false);
      setError("Funding or matching has started. This proposal can no longer be withdrawn.");
    }
  }, [confirm, proposal?.matching, proposal?.problemMatching, proposal?.fundingTerms, escrowState, anchoredWithdrawal, withdrawing]);
  const anchorInFlight = useRef(new Set());
  const activeProposalId = useRef(proposalId);
  activeProposalId.current = proposalId;
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setProposal(null); setEscrowState(null); setError(""); setConfirm(false);
    setReason(""); setReasonError(""); setAnchoredWithdrawal(null); setTab("overview");
    setAuditBusy(anchorInFlight.current.has(proposalId));
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
    if (!proposal || auditBusy || proposal.audit?.status === "confirmed") return;
    let active = true;
    const timer = setInterval(() => {
      findProposal(proposalId, { fromServer: true }).then((current) => {
        if (active && current) setProposal((previous) => ({ ...current,
          matching: mergeMatchingState(previous?.matching, current.matching),
          problemMatching: current.problemMatching || previous?.problemMatching,
        }));
      }).catch(() => { /* Keep the saved record visible while offline. */ });
    }, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [proposalId, Boolean(proposal), auditBusy, proposal?.audit?.status]);
  // Keeps the evaluation badges in step with a recommendation just filed below.
  const reloadProposal = () => findProposal(proposalId, { fromServer: true }).then((current) => {
    if (current) setProposal((previous) => ({ ...current,
      matching: mergeMatchingState(previous?.matching, current.matching),
      problemMatching: current.problemMatching || previous?.problemMatching,
    }));
  }).catch(() => { /* The badges catch up on the next load. */ });
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
        let fundingStarted;
        if (proposal.fundingTerms) fundingStarted = (await readEscrow({ proposal, account: address })).totalDeposited > 0n;
        else if (isIndependentProposal(proposal)) fundingStarted = proposalMatchingLocked(proposal);
        else {
          const current = await getMockMatching(proposal.problemId, { proposalId });
          const candidate = current.proposals.find((item) => item.id === proposalId);
          fundingStarted = !candidate || proposalMatchingLocked({ matching: { ...candidate.matching, fundedAmount: candidate.fundedAmount } })
            || ["awaiting_confirmation", "confirmed", "invalidated"].includes(current.matching.status);
        }
        if (fundingStarted) {
          setConfirm(false);
          setError("Funding or matching has started. This proposal can no longer be withdrawn.");
          return;
        }
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
  const independent = isIndependentProposal(proposal);
  const listingOpen = !independent || independentListingWindowOpen(proposal);
  const sponsors = Boolean(user?.id && proposal.postingOwnerId === user.id.toLowerCase());
  const backRoute = owns ? "proposals" : independent ? "solutions" : sponsors ? "my-problems" : `posting/${proposal.problemId}`;
  const backLabel = owns ? "Back to my proposals" : independent ? "Back to independent listings" : sponsors ? "Back to my problems" : "Back to opportunity";
  const showCollaboration = !independent && proposal.status !== "draft" && !isModerated(proposal);
  const showDiscussion = proposal.status !== "draft" && !isModerated(proposal);
  const showEscrow = proposal.status !== "draft" && Boolean(proposal.fundingTerms);
  const showFunding = showEscrow || showCollaboration;
  const reviewers = owns || (!independent && sponsors);
  const canReview = !independent && sponsors && !owns;
  const tabs = [
    ["overview", "Overview"],
    ...(showFunding ? [["funding", showEscrow ? "Escrow & funding" : "Match & funding"]] : []),
    // Only the sponsor always has something here (the review form); everyone
    // else sees feedback and comments under the proposal, when there are any.
    ...(canReview ? [["feedback", "Feedback"]] : []),
    ["record", "Record"],
  ];
  const activeTab = tabs.some(([value]) => value === tab) ? tab : "overview";
  const panel = (value) => `posting-tab${activeTab === value ? " is-active" : ""}`;
  const openRecord = () => {
    flushSync(() => setTab("record"));
    document.getElementById("proposal-panel-record")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const locked = !listingOpen || (proposal.fundingTerms ? !escrowState || escrowState.totalDeposited > 0n
    : proposalMatchingLocked(proposal) || ["awaiting_confirmation", "confirmed", "invalidated"].includes(proposal.problemMatching?.status));
  const funding = proposalFundingStatus(proposal);
  return <section className="page detail-page blotter-posting">
    <button className="back" onClick={() => onNavigate(backRoute)}>{backLabel}</button>
    {(justSubmitted || autoAnchor) && <p className="proposal-success" role="status">{independent ? "Independent listing published successfully." : "Proposal submitted successfully."} <button type="button" className="text-button" onClick={openRecord}>Check its on-chain verification</button> under Record.</p>}
    {error && !confirm && <p className="error-banner" role="alert">{error}</p>}
    <div className="detail-layout"><article className="detail-main">
      <div className="blotter-title">
        <div>
          <span className="eyebrow">{independent ? "Independent listing" : isOpenFunding ? "Problem + solution proposal" : "Solution proposal"}</span>
          <h1>{proposal.title}</h1>
        </div>
        <div className="trust-status-row">
          {proposal.fundingTerms ? <span className="draft-badge">{funding.label}</span> : <StatusBadge status={funding.status} />}
          {funding.detail && <span className="funding-note">{funding.detail}</span>}
          {proposal.status !== "draft" && !independent && <EvaluationBadges counts={recommendationCounts(proposal)} />}
          <VerifiedBadge audit={proposal.audit} recordStatus={proposal.status} hidePending />
        </div>
      </div>
      <p className="lead">{proposal.summary}</p>
      <ContentModerationNotice record={proposal} />

      {/* One job per tab, as on the posting page. Every panel stays mounted so
          the match state MatchingPanel reports keeps the sidebar current. */}
      <div className="posting-tabs">
        <div className="desk-tabs" role="tablist" aria-label="Proposal sections">
          {tabs.map(([value, label]) => (
            <button key={value} type="button" role="tab" id={`proposal-tab-${value}`}
              aria-selected={activeTab === value} aria-controls={`proposal-panel-${value}`}
              className={activeTab === value ? "selected" : ""} onClick={() => setTab(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={panel("overview")} role="tabpanel" id="proposal-panel-overview" aria-labelledby="proposal-tab-overview">
        {proposal.status === "withdrawn" && <DetailGroup title="Withdrawal">
          <DetailItem heading="Withdrawal reason">{proposal.withdrawalReason}</DetailItem>
        </DetailGroup>}
        {independent ? <>
          <DetailGroup title="The solution">
            <DetailItem heading="Technical approach">{proposal.methodology}</DetailItem>
            <DetailItem heading="Problems this could address">{proposal.addressedProblems}</DetailItem>
            <DetailItem heading="Team and relevant experience">{proposal.team}</DetailItem>
          </DetailGroup>
        </> : <>
        {isOpenFunding && <>
          <p className="field-hint posting-tab-note">The funder acts as the problem owner for selection. This proposal follows the same funding, selection and approval process as other solution proposals.</p>
          <DetailGroup title="The problem">
            <DetailItem heading="Proposed problem statement">{proposal.proposedProblem}</DetailItem>
            <DetailItem heading="Business or scientific relevance">{proposal.relevance}</DetailItem>
            <DetailItem heading="Why this fits the funder's thesis">{proposal.thesisFit}</DetailItem>
          </DetailGroup>
        </>}
        <DetailGroup title="The approach">
          <DetailItem heading="Technical methodology">{proposal.methodology}</DetailItem>
          <DetailItem heading="Why this approach suits the problem">{proposal.suitability}</DetailItem>
        </DetailGroup>
        <DetailGroup title="What success looks like">
          <DetailItem heading="Expected outcomes">{proposal.expectedOutcomes}</DetailItem>
          <DetailItem heading="Measurable success criteria">{proposal.successCriteria}</DetailItem>
        </DetailGroup>
        <DetailGroup title="Delivery">
          <DetailItem heading="Delivery timeline">{proposal.timeline}</DetailItem>
          <DetailItem heading="Milestones and deliverables">{proposal.milestones}</DetailItem>
          <DetailItem heading="Team and relevant experience">{proposal.team}</DetailItem>
        </DetailGroup>
        </>}
        {proposal.fundingTerms && <DetailGroup title="Escrow payment plan">
          <DetailItem heading="Payment percentages">{proposal.fundingTerms.trancheBps.map(bps => `${bps / 100}%`).join(" / ")}</DetailItem>
          <DetailItem heading="Approval windows">{proposal.fundingTerms.reviewWindows.map(seconds => `${seconds / 86400} days`).join(" / ")}</DetailItem>
          <EscrowPaymentPlanSummary trancheBps={proposal.fundingTerms.trancheBps} funderVoting={proposal.fundingTerms.funderVoting} />
        </DetailGroup>}
        {proposal.attachments?.length > 0 && <section className="detail-section detail-group"><h2>Supporting attachments</h2>{proposal.attachments.map((item) => <p key={item.id}><button className="text-button" onClick={() => download(item)}>Download {item.name}</button></p>)}</section>}
        {/* The sponsor's feedback (for the author) and comments render nothing
            when there are none, so they follow the proposal instead of an
            usually empty tab. */}
        {owns && !independent && <OwnerReviewPanel proposalId={proposal.id} revisionPathOpen={proposal.status === "submitted" && !locked} />}
        {showDiscussion && <>
          <ReportableComments
            problemId={independent ? undefined : proposal.problemId}
            proposalId={proposal.id}
            authorId={proposal.researcherId}
            recommenders={independent ? [] : Object.keys(recommendationEntries(proposal))}
            onRecommendationChange={reloadProposal}
            discussionOpen={independent ? listingOpen : true}
            allowRecommendations={!independent}
          />
          <div className="detail-report"><ReportContentButton contentType="proposal" contentId={proposal.id} /></div>
        </>}
      </div>

      {showFunding && <div className={panel("funding")} role="tabpanel" id="proposal-panel-funding" aria-labelledby="proposal-tab-funding">
        {proposal.fundingTerms ? <EscrowFundingPanel key={proposal.id} proposal={proposal} onStateChange={setEscrowState} /> : <MatchingPanel problemId={proposal.problemId} proposalId={proposal.id} onNavigate={onNavigate} onChange={(next) => {
          const updated = next.proposals.find((item) => item.id === proposal.id);
          if (updated) setProposal((current) => current?.id === updated.id ? { ...current, matching: { ...current.matching, ...updated.matching, fundedAmount: updated.fundedAmount }, problemMatching: next.matching } : current);
        }} />}
      </div>}

      {canReview && <div className={panel("feedback")} role="tabpanel" id="proposal-panel-feedback" aria-labelledby="proposal-tab-feedback">
        <OwnerReviewPanel proposalId={proposal.id} canRecord revisionPathOpen={proposal.status === "submitted" && !locked} />
      </div>}

      <div className={panel("record")} role="tabpanel" id="proposal-panel-record" aria-labelledby="proposal-tab-record">
        <AuditReceipt entityLabel="Proposal" audit={proposalAuditReceipt(proposal)} eventLabel="Proposal submitted" actorRole="Researcher / solution developer" firebaseReference={`proposals/${proposal.id}`} recordTimestamp={proposal.updatedAt ?? proposal.createdAt} onVerify={() => readProposalAudit(proposal)} onRetry={owns && !auditBusy ? () => anchor() : undefined} />
        {auditBusy && <p role="status">Verifying your saved proposal… You can continue using the app.</p>}
        {reviewers && <ProposalRevisionTrail proposalId={proposal.id} field={owns ? "researcherId" : "postingOwnerId"} uid={user.id} />}
      </div>
    </article><aside className="context-panel"><span className="eyebrow">{independent ? "Indicative funding" : "Requested"}</span><strong>{proposal.currency} {Number(proposal.amount).toLocaleString()}</strong><dl><dt>Category</dt><dd>{PROPOSAL_CATEGORIES.find((item) => item.value === proposal.category)?.label || "—"}</dd>{independent && <><dt>Maturity</dt><dd>{PROPOSAL_MATURITY_LEVELS.find((item) => item.value === proposal.maturity)?.label || "—"}</dd></>}<dt>Submitted</dt><dd>{formatInstant(proposal.createdAt)}</dd></dl>
      {independent && proposal.status !== "withdrawn" && <ExpiryCountdown expiresAt={proposal.expiresAt} status={proposal.status} />}
      {!independent && <button className="secondary" onClick={() => onNavigate(`posting/${proposal.problemId}`)}>View opportunity</button>}
      {showEscrow && <button className="primary" onClick={() => setTab("funding")}>Open escrow</button>}
      {/* Editable only while `submitted`. `under_review` means an evaluator has
          the proposal open, and firestore.rules refuses a content write from
          that point on. Independent listings have no parent posting. */}
      {owns && !locked && proposal.status === "submitted" && <button className="secondary" onClick={() => onNavigate(independent ? `create-proposal/${proposal.id}` : `edit-proposal/${proposal.id}`)}>Edit proposal</button>}
      {owns && !locked && ["submitted", "under_review"].includes(proposal.status) && <button className="secondary" disabled={withdrawing} onClick={() => setConfirm(true)}>Withdraw proposal</button>}
      {owns && proposal.status === "withdrawn" && <button className="primary" onClick={() => onNavigate(independent ? "create-proposal" : `submit-proposal/${proposal.problemId}`)}>{independent ? "Publish a replacement" : "Submit a replacement"}</button>}
    </aside></div>
    {walletPromptOpen && <ConnectWalletModal onClose={() => setWalletPromptOpen(false)} />}
    {confirm && <Modal labelledBy="withdraw-proposal-title" describedBy="withdraw-proposal-desc" onDismiss={() => { if (!withdrawing) setConfirm(false); }}>
      <div className="modal-head">
        <div>
          <h2 id="withdraw-proposal-title">Withdraw this proposal?</h2>
          <p id="withdraw-proposal-desc">{independent
            ? "It leaves the catalog immediately. You can publish a new independent listing afterwards."
            : "It leaves evaluation and selection immediately. You can submit a new proposal while the opportunity remains open."}</p>
        </div>
      </div>
      <div className="modal-body">
        <Field htmlFor="withdrawal-reason" label="Why are you withdrawing?" error={reasonError} hint={independent
          ? "A hash of this exact text is anchored on Arbitrum Sepolia, and the text is stored on the listing. It cannot be changed afterwards."
          : "A hash of this exact text is anchored on Arbitrum Sepolia, and the text is shown to the sponsor. It cannot be changed afterwards."}>
          {({ id, describedBy, invalid }) => <textarea id={id} rows={3} value={anchoredWithdrawal?.reason ?? reason} maxLength={1000} disabled={withdrawing || Boolean(anchoredWithdrawal)} aria-describedby={describedBy} aria-invalid={invalid} onChange={(event) => { if (anchoredWithdrawal) return; setReason(event.target.value); setReasonError(""); }} />}
        </Field>
        {error && anchoredWithdrawal ? <p className="error-banner" role="alert">{error}</p> : null}
        <p className="field-hint">{anchoredWithdrawal
          ? "The withdrawal is already signed on Arbitrum Sepolia. Saving it does not need another signature."
          : "Your wallet signs the withdrawal before it takes effect. If you decline, the proposal stays exactly as it is."}</p>
      </div>
      <div className="modal-actions"><button className="secondary" disabled={withdrawing || Boolean(anchoredWithdrawal)} onClick={() => setConfirm(false)}>Keep proposal</button><button className="danger-btn" disabled={withdrawing} onClick={withdraw}>{withdrawing ? (anchoredWithdrawal ? "Saving…" : "Waiting for your wallet…") : (anchoredWithdrawal ? "Finish saving withdrawal" : "Sign and withdraw")}</button></div>
    </Modal>}
  </section>;
}
