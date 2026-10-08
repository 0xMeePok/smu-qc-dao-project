import { messageForProposalError } from "../lib/proposalValidation.js";
import { EscrowPaymentPlanSummary } from "../components/EscrowPaymentPlanSummary.jsx";
import { EscrowFundingPanel } from "../components/EscrowFundingPanel.jsx";
import { IndependentFundingPanel } from "../components/IndependentFundingPanel.jsx";
import { IndependentFundingTerms } from "../components/IndependentFundingTerms.jsx";
import { getIndependentFundingState, independentFundingLocked } from "../lib/independentEscrow.js";
import { OpenFundingPanel } from "../components/OpenFundingPanel.jsx";
import { readEscrow } from "../lib/escrow.js";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useAccount } from "wagmi";
import { useAuth } from "../context/AuthContext.jsx";
import { findProposal, withdrawProposal } from "../lib/proposals.js";
import { findPublicProfileByAddress } from "../lib/profile.js";
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
import { ConsolidatedAuditTrail } from "../components/ConsolidatedAuditTrail.jsx";
import { highlightWhenPresent } from "../lib/highlightTarget.js";
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
import { PosterIdentity } from "../components/PosterIdentity.jsx";

// `justSubmitted` only shows the confirmation banner. Anchoring is done before
// the record is written now, so this page never starts one on its own; the retry
// control below is for a receipt that was left in flight.
export default function ProposalDetailPage({ proposalId, onNavigate, autoAnchor = false, justSubmitted = false, initialTab = "overview",
  fundingActivationError = "", pendingFundingTransaction = null }) {
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
  const [tab, setTab] = useState(initialTab);
  const [escrowState, setEscrowState] = useState(null);
  const [fundingRefreshVersion, setFundingRefreshVersion] = useState(0);
  const [author, setAuthor] = useState(null);
  useEffect(() => {
    const fundingStarted = isIndependentProposal(proposal) ? independentFundingLocked(escrowState || proposal?.independentFunding)
      : proposal?.fundingTerms ? escrowState?.totalDeposited > 0n : proposalMatchingLocked(proposal)
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
    setReason(""); setReasonError(""); setAnchoredWithdrawal(null); setTab(initialTab);
    setAuditBusy(anchorInFlight.current.has(proposalId));
    findProposal(proposalId).then((record) => { if (!cancelled) setProposal(record); })
      .catch((err) => { if (!cancelled) setError(messageForProposalError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [proposalId, initialTab]);
  useEffect(() => {
    setAuthor(null);
    if (!isIndependentProposal(proposal) || !proposal?.researcherId) return undefined;
    let cancelled = false;
    findPublicProfileByAddress(proposal.researcherId)
      .then((found) => { if (!cancelled) setAuthor(found); })
      .catch(() => { if (!cancelled) setAuthor(null); });
    return () => { cancelled = true; };
  }, [proposal?.id, proposal?.researcherId, proposal?.proposalKind]);
  useEffect(() => {
    if (!proposal?.id) return undefined;
    const commentId = new URLSearchParams(window.location.hash.split("?")[1] || "").get("comment");
    if (!commentId) return undefined;
    setTab("overview");
    highlightWhenPresent(`comment-${commentId}`);
    return undefined;
  }, [proposal?.id]);
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
        if (isIndependentProposal(proposal)) fundingStarted = independentFundingLocked(await getIndependentFundingState({ proposalId }));
        else if (proposal.fundingTerms) fundingStarted = (await readEscrow({ proposal, account: address })).totalDeposited > 0n;
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
  const showEscrow = !independent && proposal.status !== "draft" && Boolean(proposal.fundingTerms);
  const showFunding = (independent && proposal.status !== "draft") || showEscrow || showCollaboration;
  const reviewers = owns || (!independent && sponsors);
  const canReview = !independent && sponsors && !owns;
  const tabs = [
    ["overview", "Overview"],
    ...(showFunding ? [["funding", independent ? "Crowdfunding" : showEscrow ? "Escrow & funding" : "Match & funding"]] : []),
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
  const showProposalReceipt = () => {
    flushSync(() => setTab("record"));
    highlightWhenPresent("entity-audit-receipt");
    return true;
  };
  // Independent listings stay editable until a deposit is known. Attached
  // escrow proposals stay locked while that state is still loading.
  const locked = !listingOpen || (independent
    ? !escrowState || independentFundingLocked(escrowState) || independentFundingLocked(proposal.independentFunding)
    : proposal.fundingTerms ? !escrowState || escrowState.totalDeposited > 0n
    : proposalMatchingLocked(proposal) || ["awaiting_confirmation", "confirmed", "invalidated"].includes(proposal.problemMatching?.status));
  const canEdit = owns && !locked && !escrowState?.grantOfferState && proposal.status === "submitted";
  const canWithdraw = owns && !locked && ["submitted", "under_review"].includes(proposal.status);
  const funding = proposalFundingStatus(independent ? { ...proposal, independentFunding: escrowState || proposal.independentFunding } : proposal);
  return <section className="page detail-page blotter-posting">
    <button className="back" onClick={() => onNavigate(backRoute)}>{backLabel}</button>
    {(justSubmitted || autoAnchor) && <p className="proposal-success" role="status">{independent ? "Independent listing published successfully." : "Proposal submitted successfully."} <button type="button" className="text-button" onClick={openRecord}>Check its on-chain verification</button> under Record.</p>}
    {error && !confirm && <p className="error-banner" role="alert">{error}</p>}
    {fundingActivationError && !escrowState?.exists && <p className="field-hint" role="status">{fundingActivationError}</p>}
    <div className="detail-layout"><article className="detail-main">
      <div className="blotter-title">
        <div>
          <span className="eyebrow">{independent ? "Independent listing" : isOpenFunding ? "Problem + solution proposal" : "Solution proposal"}</span>
          <h1>{proposal.title}</h1>
        </div>
        <div className="trust-status-row">
          {independent || proposal.fundingTerms ? <span className="draft-badge">{funding.label}</span> : <StatusBadge status={funding.status} />}
          {!independent && funding.detail && <span className="funding-note">{funding.detail}</span>}
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
          <p className="field-hint posting-tab-note">The grant owner can select multiple proposals from their deposited funds. You have seven days to accept a selected grant; acceptance funds this proposal’s escrow and starts its payment plan.</p>
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
        {independent && <IndependentFundingTerms reviewDays={String(proposal.fundingTerms?.reviewWindows?.at(-1) / 86400 || 30)} readOnly />}
        {!independent && proposal.fundingTerms && <DetailGroup title="Escrow payment plan">
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
        {isOpenFunding && <OpenFundingPanel problemId={proposal.problemId} proposalId={proposal.id} onNavigate={onNavigate}
          onChange={(change) => { if (activeProposalId.current === change.proposalId) setFundingRefreshVersion(previous => previous + 1); }} />}
        {independent ? <IndependentFundingPanel key={proposal.id} proposal={proposal} onStateChange={setEscrowState}
          initialTransaction={pendingFundingTransaction} refreshVersion={fundingRefreshVersion} />
          : proposal.fundingTerms ? <EscrowFundingPanel key={proposal.id} proposal={proposal} onStateChange={setEscrowState} refreshVersion={fundingRefreshVersion} /> : !isOpenFunding && <MatchingPanel problemId={proposal.problemId} proposalId={proposal.id} onNavigate={onNavigate} onOpenAuditReceipt={showProposalReceipt} onChange={(next) => {
          const updated = next.proposals.find((item) => item.id === proposal.id);
          if (updated) setProposal((current) => current?.id === updated.id ? { ...current, matching: { ...current.matching, ...updated.matching, fundedAmount: updated.fundedAmount }, problemMatching: next.matching } : current);
        }} />}
      </div>}

      {canReview && <div className={panel("feedback")} role="tabpanel" id="proposal-panel-feedback" aria-labelledby="proposal-tab-feedback">
        <OwnerReviewPanel proposalId={proposal.id} canRecord revisionPathOpen={proposal.status === "submitted" && !locked} />
      </div>}

      <div className={panel("record")} role="tabpanel" id="proposal-panel-record" aria-labelledby="proposal-tab-record">
        <AuditReceipt anchorId="entity-audit-receipt" entityLabel="Proposal" audit={proposalAuditReceipt(proposal)} eventLabel="Proposal submitted" actorRole="Researcher / solution developer" firebaseReference={`proposals/${proposal.id}`} recordTimestamp={proposal.updatedAt ?? proposal.createdAt} onVerify={() => readProposalAudit(proposal)} onRetry={owns && !auditBusy ? () => anchor() : undefined} />
        {auditBusy && <p role="status">Verifying your saved proposal… You can continue using the app.</p>}
        {reviewers && <ProposalRevisionTrail proposalId={proposal.id} field={owns ? "researcherId" : "postingOwnerId"} uid={user.id} />}
        {activeTab === "record" && <ConsolidatedAuditTrail scope="proposal" entityId={proposal.id} onNavigate={onNavigate} onOpenComment={(item) => { flushSync(() => setTab("overview")); highlightWhenPresent(`comment-${item.commentId}`); }} />}
      </div>
    </article><aside className="context-panel"><span className="eyebrow">{independent ? "Crowdfunding target" : "Requested"}</span><strong>{proposal.currency} {Number(proposal.amount).toLocaleString()}</strong><dl>
      {independent && <PosterIdentity ownerId={proposal.researcherId} poster={author} onNavigate={onNavigate} label="Proposed by" />}
      <div><dt>Category</dt><dd>{PROPOSAL_CATEGORIES.find((item) => item.value === proposal.category)?.label || "—"}</dd></div>
      {independent && <div><dt>Maturity</dt><dd>{PROPOSAL_MATURITY_LEVELS.find((item) => item.value === proposal.maturity)?.label || "—"}</dd></div>}
      <div><dt>Submitted</dt><dd>{formatInstant(proposal.createdAt)}</dd></div>
      {independent && proposal.status !== "withdrawn" && <div><dt>Time remaining</dt><dd>{isModerated(proposal) ? <span aria-label="No time remaining">—</span> : <ExpiryCountdown expiresAt={proposal.expiresAt} status={proposal.status} showInstant={false} />}</dd></div>}
    </dl>
      <div className="context-panel-actions">
      {!independent && <button type="button" className="secondary" onClick={() => onNavigate(`posting/${proposal.problemId}`)}>View opportunity</button>}
      {/* Editable only while `submitted`. `under_review` means an evaluator has
          the proposal open, and firestore.rules refuses a content write from
          that point on. Independent listings have no parent posting. */}
      {canEdit && <button type="button" className="secondary" onClick={() => onNavigate(independent ? `create-proposal/${proposal.id}` : `edit-proposal/${proposal.id}`)}>Edit proposal</button>}
      {canWithdraw && <button type="button" className="secondary" disabled={withdrawing} onClick={() => setConfirm(true)}>Withdraw proposal</button>}
      {independent
        ? showFunding && <button type="button" className="primary" onClick={() => setTab("funding")}>Open crowdfunding</button>
        : showEscrow && <button type="button" className="primary" onClick={() => setTab("funding")}>Open escrow</button>}
      {owns && proposal.status === "withdrawn" && <button type="button" className="primary" onClick={() => onNavigate(independent ? "create-proposal" : `submit-proposal/${proposal.problemId}`)}>{independent ? "Publish a replacement" : "Submit a replacement"}</button>}
      </div>
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
