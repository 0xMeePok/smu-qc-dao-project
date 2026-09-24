import { proposalBlockReason } from "../lib/proposalValidation.js";
import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useAuth } from "../context/AuthContext.jsx";
import { findPosting, withdrawPosting } from "../lib/postings.js";
import {
  downloadAttachment,
  formatBytes,
  messageForStorageError,
  saveBlobAs,
} from "../lib/attachments.js";
import { auditErrorMessage, messageForFirebaseError } from "../lib/errors.js";
import { categoryLabel } from "../config/postingCategories.js";
import { ExpiryCountdown } from "../components/ExpiryCountdown.jsx";
import { AuditReceipt } from "../components/AuditReceipt.jsx";
import { ConnectWalletModal } from "../components/ConnectWalletModal.jsx";
import { PostingProposals } from "../components/PostingProposals.jsx";
import { MatchingPanel } from "../components/MatchingPanel.jsx";
import { ProposalComparison } from "../components/ProposalComparison.jsx";
import { getMockMatching, problemMatchingLocked } from "../lib/matching.js";
import { isModerated } from "../lib/moderation.js";
import { ContentModerationNotice, ReportContentButton } from "../components/ReportContentButton.jsx";
import { ReportableComments } from "../components/ReportableComments.jsx";
import { Modal } from "../components/Modal.jsx";
import { Field } from "../components/Field.jsx";
import { formatInstant } from "../lib/datetime.js";
import {
  anchorOpportunityWithdrawal,
  anchorPostingAudit,
  postingAuditReceipt,
  readPostingAudit,
} from "../lib/postingAudit.js";
import {
  anchorFundingOpportunityAudit,
  fundingOpportunityAuditReceipt,
  readFundingOpportunityAudit,
} from "../lib/fundingOpportunityAudit.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import {
  expiryReasonLabel,
  isExpiredOpenOpportunity,
  isResponseWindowClosed,
  opportunityStatusLabel,
} from "../config/workflowStatus.js";
import { postingActions } from "../lib/postingActions.js";
import { findPublicProfileByAddress } from "../lib/profile.js";
import { VerifiedBadge } from "../components/VerifiedBadge.jsx";
import { shortenAddress } from "../lib/chain.js";
import { canEditOpportunity } from "../lib/opportunityEdit.js";
import { OpportunityRevisionTrail } from "../components/OpportunityRevisionTrail.jsx";

/**
 * QCDAO-48 - the posting the confirmation screen links to, and the place QCDAO-58
 * attachments are downloaded from.
 *
 * Reads are governed by firebase/firestore.rules: a submitted or open posting is
 * readable by any active member, and so are its PDFs (firebase/storage.rules).
 * A draft stays private to its owner.
 */

function Detail({ heading, children }) {
  const text = String(children ?? "").trim();
  if (!text) return null;
  return (
    <div className="detail-section">
      <h2>{heading}</h2>
      <p>{text}</p>
    </div>
  );
}

function ActionBar({ posting, user, isAuthenticated, onNavigate }) {
  const actions = postingActions(posting, user, { isAuthenticated });
  const blocked = proposalBlockReason(posting);
  const isOpenFunding = posting.opportunityType === OPEN_FUNDING_TYPE;
  if (!actions.length && !blocked) return null;
  return (
    <>
      {blocked ? <p className="field-hint">{blocked}</p> : null}
      {actions.length > 0 && (
        <div className="context-panel-actions">
          {actions.map((action) => (
            <button
              key={action.id}
              className={action.kind === "primary" ? "primary" : "secondary"}
              type="button"
              onClick={() => {
                const target = action.id === "review-proposals" ? "proposal-comparison" : action.id === "fund" ? "proposal-funding" : "";
                if (target) document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
                else onNavigate(action.route);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {isOpenFunding && !blocked ? (
        <p className="field-hint">Propose a problem and solution. The funder acts as the problem owner for selection.</p>
      ) : null}
    </>
  );
}

function PosterIdentity({ ownerId, organisation, poster, onNavigate }) {
  if (!ownerId) return null;
  const name = String(poster?.fullName ?? "").trim();
  const org = String(poster?.organisation ?? organisation ?? "").trim();
  const primary = name || org || shortenAddress(ownerId);
  const secondary = name ? org : org ? shortenAddress(ownerId) : "";
  return (
    <div>
      <dt>Posted by</dt>
      <dd>
        <button
          className="profile-link poster-identity"
          type="button"
          onClick={() => onNavigate(`profile/${ownerId}`)}
        >
          <span>{primary}</span>
          {secondary ? <small>{secondary}</small> : null}
        </button>
      </dd>
    </div>
  );
}

export default function PostingDetailPage({ postingId, onNavigate }) {
  const { isAuthenticated, user } = useAuth();
  const { address: connectedAddress, isConnected } = useAccount();
  const [posting, setPosting] = useState(null);
  const [matchingRefresh, setMatchingRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [walletPromptOpen, setWalletPromptOpen] = useState(false);
  const [poster, setPoster] = useState(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [anchoredWithdrawal, setAnchoredWithdrawal] = useState(null);

  useEffect(() => {
    if (confirm && problemMatchingLocked(posting) && !anchoredWithdrawal && !withdrawing) {
      setConfirm(false);
      setError("Funding or matching has started. This opportunity can no longer be withdrawn.");
    }
  }, [confirm, posting?.matching, anchoredWithdrawal, withdrawing]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setConfirm(false);
    setReason("");
    setReasonError("");
    setAnchoredWithdrawal(null);

    findPosting(postingId)
      .then((found) => { if (!cancelled) setPosting(found); })
      .catch((lookupError) => { if (!cancelled) setError(messageForFirebaseError(lookupError)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [postingId]);

  useEffect(() => {
    setPoster(null);
    if (!posting?.ownerId) return undefined;
    let cancelled = false;
    findPublicProfileByAddress(posting.ownerId)
      .then((found) => { if (!cancelled) setPoster(found); })
      .catch(() => { if (!cancelled) setPoster(null); });
    return () => { cancelled = true; };
  }, [posting?.ownerId]);

  const download = async (attachment) => {
    setError(null);
    try {
      saveBlobAs(await downloadAttachment({
        attachment, ownerId: posting.ownerId, problemId: posting.id,
      }), attachment.name);
    } catch (downloadError) {
      setError(messageForStorageError(downloadError));
    }
  };

  const retryAudit = () => {
    const ownsPosting = user?.id?.toLowerCase() === posting?.ownerId?.toLowerCase();
    if (!posting || auditBusy || !ownsPosting) return;
    const sameWallet = isConnected
      && connectedAddress?.toLowerCase() === user?.id?.toLowerCase();
    if (!sameWallet) {
      setWalletPromptOpen(true);
      return;
    }
    setAuditBusy(true);
    const anchorAudit = posting.opportunityType === OPEN_FUNDING_TYPE
      ? anchorFundingOpportunityAudit
      : anchorPostingAudit;
    void anchorAudit(posting, {
      account: user?.id,
      persistReceipt: false,
      onChange: (audit) => setPosting((current) => ({ ...current, audit })),
    }).catch(() => {
      // The receipt explains the independent verification failure; the posting
      // remains available and this retry never re-broadcasts a known tx hash.
    }).finally(() => setAuditBusy(false));
  };

  const verifyAudit = async () => {
    return posting.opportunityType === OPEN_FUNDING_TYPE
      ? readFundingOpportunityAudit(posting)
      : readPostingAudit(posting);
  };

  const ownsPosting = user?.id?.toLowerCase() === posting?.ownerId?.toLowerCase();
  // Matches the rules: submitted/open lapse after the deadline; in_review is
  // also owner-locked once expiresAt passes so it cannot skip that hand-off.
  const canWithdraw = ownsPosting
    && !problemMatchingLocked(posting)
    && ["submitted", "open", "in_review"].includes(posting?.status)
    && !isResponseWindowClosed(posting);

  const withdraw = async () => {
    const withdrawalReason = (anchoredWithdrawal?.reason ?? reason).trim();
    const entityLabel = posting.opportunityType === OPEN_FUNDING_TYPE
      ? "funding opportunity"
      : "problem statement";
    if (!anchoredWithdrawal) {
      if (withdrawalReason.length < 2) {
        setReasonError(`Give a reason for withdrawing this ${entityLabel}.`);
        return;
      }
      if (withdrawalReason.length > 1000) {
        setReasonError("Use 1,000 characters or fewer.");
        return;
      }
      if (!isConnected || connectedAddress?.toLowerCase() !== posting.ownerId?.toLowerCase()) {
        setReasonError("Connect the wallet that published this opportunity to sign the withdrawal.");
        return;
      }
      if (isResponseWindowClosed(posting)) {
        setReasonError(isExpiredOpenOpportunity(posting)
          ? `The response window has closed, so this ${entityLabel} will lapse automatically instead.`
          : `The response window has closed, so this ${entityLabel} can no longer be withdrawn.`);
        return;
      }
    }
    setWithdrawing(true);
    setError(null);
    setReasonError("");
    let anchored = anchoredWithdrawal;
    try {
      if (!anchored) {
        const current = await getMockMatching(posting.id);
        if (problemMatchingLocked({ matching: current.matching })) {
          setPosting((previous) => ({ ...previous, matching: current.matching }));
          setConfirm(false);
          setError("Funding or matching has started. This opportunity can no longer be withdrawn.");
          return;
        }
        await anchorOpportunityWithdrawal(posting, { account: connectedAddress, reason: withdrawalReason });
        anchored = { reason: withdrawalReason };
        setAnchoredWithdrawal(anchored);
        setReason(withdrawalReason);
      }
      await withdrawPosting(posting.id, anchored.reason);
      setPosting((current) => ({ ...current, status: "cancelled", withdrawalReason: anchored.reason }));
      setConfirm(false);
      setAnchoredWithdrawal(null);
    } catch (err) {
      setError(anchored
        ? `The withdrawal was recorded on Arbitrum Sepolia, but saving it failed. ${messageForFirebaseError(err)} Finish saving it with the same reason — you will not be asked to sign again.`
        : auditErrorMessage(err));
      if (!anchored) setConfirm(false);
    } finally {
      setWithdrawing(false);
    }
  };

  if (loading) {
    return (
      <section className="page empty">
        <p className="lead">Loading posting…</p>
      </section>
    );
  }

  if (!posting) {
    // A signed-out visitor following a shared link is not looking at a missing
    // posting - reading one needs a session. Saying "not available" would send
    // them away from something they can reach in one click.
    if (!isAuthenticated) {
      return (
        <section className="page empty">
          <span className="http-status">Sign in required</span>
          <h1>Sign in to view this posting.</h1>
          <p>Research opportunities are shared with platform members.</p>
          <button
            className="primary"
            type="button"
            onClick={() => onNavigate(`login?redirect=${encodeURIComponent(`posting/${postingId}`)}`)}
          >
            Sign in with wallet
          </button>
        </section>
      );
    }

    return (
      <section className="page empty">
        <span className="http-status">Not found</span>
        <h1>This posting is not available.</h1>
        <p>It may have been removed, or it may be a draft belonging to someone else.</p>
        <button className="primary" type="button" onClick={() => onNavigate("discover")}>
          Browse opportunities
        </button>
      </section>
    );
  }

  const expired = isResponseWindowClosed(posting);
  const isOpenFunding = posting.opportunityType === OPEN_FUNDING_TYPE;
  const entityLabel = isOpenFunding ? "funding opportunity" : "problem statement";
  const audit = isOpenFunding
    ? fundingOpportunityAuditReceipt(posting)
    : postingAuditReceipt(posting);
  const proposalCount = Number(posting.proposalCount ?? 0);
  const requestedAmount = Number(posting.amount);
  const requestedLabel = Number.isFinite(requestedAmount)
    ? `${posting.currency} ${requestedAmount.toLocaleString()}`
    : "—";

  return (
    <section className="page detail-page">
      <button className="back" type="button" onClick={() => onNavigate(ownsPosting ? "my-problems" : "discover")}>
        {ownsPosting ? "Back to my problems" : "Back to opportunities"}
      </button>

      {walletPromptOpen && (
        <ConnectWalletModal onClose={() => setWalletPromptOpen(false)} />
      )}

      <div className="detail-layout">
        <article className="detail-main">
          <div className="card-top">
            <span className="eyebrow">
              {isOpenFunding ? "Open funding opportunity" : "Problem statement"}
            </span>
            <div className="trust-status-row">
              <span className="status-dot">{opportunityStatusLabel(posting.status, { expiresAt: posting.expiresAt, matching: posting.matching })}</span>
              <VerifiedBadge audit={posting.audit} recordStatus={posting.status} />
            </div>
          </div>
          <h1>{posting.title}</h1>
          <ContentModerationNotice record={posting} />

          {isOpenFunding ? (
            <>
              <Detail heading="Funding thesis and areas of interest">{posting.fundingThesis}</Detail>
              <Detail heading="Eligibility notes">{posting.eligibilityNotes}</Detail>
            </>
          ) : (
            <>
              <Detail heading="Problem description">{posting.summary}</Detail>
              <Detail heading="Business context">{posting.businessContext}</Detail>
              <Detail heading="Current approach">{posting.currentApproach}</Detail>
              <Detail heading="Limitations of that approach">{posting.currentLimitations}</Detail>
              <Detail heading="Expected outcome">{posting.expectedOutcome}</Detail>
              <Detail heading="Success criteria">{posting.successCriteria}</Detail>
              <Detail heading="Relevant data availability">{posting.dataAvailability}</Detail>
            </>
          )}

          {posting.status === "cancelled" && posting.withdrawalReason && (
            <Detail heading="Withdrawal reason">{posting.withdrawalReason}</Detail>
          )}

          {posting.attachments.length > 0 && (
            <div className="detail-section">
              <h2>Supporting documents</h2>
              <ul className="attachment-list">
                {posting.attachments.map((attachment) => (
                  <li className="attachment-row" key={attachment.id}>
                    <span className="attachment-mark" aria-hidden="true">PDF</span>
                    <span className="attachment-meta">
                      <strong>{attachment.name}</strong>
                      <small>{formatBytes(attachment.size)}</small>
                    </span>
                    <span className="attachment-actions">
                      <button type="button" className="text-button" onClick={() => download(attachment)}>
                        Download
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <PostingProposals
            posting={posting}
            viewerId={user?.id}
            isPoster={ownsPosting}
            proposalCount={proposalCount}
            onNavigate={onNavigate}
          />

          {posting.status !== "draft" && !isModerated(posting) && <>
            <ProposalComparison
              problemId={posting.id}
              refreshKey={`${posting.matching?.status || ""}:${posting.matching?.totalFundedMinor || 0}`}
              onSelected={() => setMatchingRefresh((current) => current + 1)}
            />
            <MatchingPanel key={matchingRefresh} problemId={posting.id} onNavigate={onNavigate} onChange={(next) => setPosting((current) => ({ ...current, matching: { ...current.matching, ...next.matching } }))} />
            <ReportContentButton contentType="problem" contentId={posting.id} />
            <ReportableComments problemId={posting.id} />
          </>}

          <AuditReceipt
            audit={audit}
            eventLabel={isOpenFunding
              ? "Open funding opportunity submitted"
              : "Problem statement submitted"}
            actorRole={isOpenFunding ? "Funder" : "Problem owner"}
            firebaseReference={`problems/${posting.id}`}
            recordTimestamp={posting.updatedAt ?? posting.createdAt}
            onVerify={verifyAudit}
            onRetry={!auditBusy && ownsPosting ? retryAudit : undefined}
          />

          <OpportunityRevisionTrail postingId={posting.id} uid={user?.id} isOwner={ownsPosting} />

          {error && !confirm && <p className="attachment-error" role="alert">{error}</p>}
        </article>

        <aside className="context-panel">
          <span className="eyebrow">{isOpenFunding ? "Funding available" : "Indicative proposal budget"}</span>
          <strong>{requestedLabel}</strong>
          <p className="field-hint">Contributions fund individual proposals. Review each proposal below for its funding target and progress.</p>
          <dl>
            <PosterIdentity
              ownerId={posting.ownerId}
              organisation={posting.organisation}
              poster={poster}
              onNavigate={onNavigate}
            />
            <div>
              <dt>Proposals received</dt>
              <dd>{proposalCount} {proposalCount === 1 ? "proposal" : "proposals"}</dd>
            </div>
            <div><dt>Submitted</dt><dd>{formatInstant(posting.createdAt)}</dd></div>
            <div><dt>Reference</dt><dd><code>{posting.id}</code></dd></div>
          </dl>

          <ActionBar
            posting={posting}
            user={user}
            isAuthenticated={isAuthenticated}
            onNavigate={onNavigate}
          />
          {/* postingActions only offers Edit on a draft, routed to the create form.
              These two are the published-posting owner actions it has no route for. */}
          {canEditOpportunity(posting, user?.id) && (
            <button className="secondary" type="button" onClick={() => onNavigate(`edit-posting/${posting.id}`)}>
              Edit {entityLabel}
            </button>
          )}
          {canWithdraw && (
            <button className="secondary" type="button" disabled={withdrawing} onClick={() => setConfirm(true)}>
              Withdraw {entityLabel}
            </button>
          )}

          <div className="expiry-panel">
            <span className="eyebrow">{expired ? "Closed" : "Time remaining"}</span>
            <ExpiryCountdown expiresAt={posting.expiresAt} status={posting.status} />
            {posting.status === "expired" && (
              <p className="field-hint"><strong>Lapse reason:</strong> {expiryReasonLabel(posting.expiryReason)}.</p>
            )}
          </div>

          {posting.categories.length > 0 && (
            <>
              <span className="eyebrow">Technology areas</span>
              <div className="tag-list">
                {posting.categories.map((value) => (
                  <span className="tag-chip static" key={value}>{categoryLabel(value)}</span>
                ))}
              </div>
            </>
          )}

          {isOpenFunding && posting.tags.length > 0 && (
            <>
              <span className="eyebrow">Discovery tags</span>
              <div className="tag-list">
                {posting.tags.map((tag) => (
                  <span className="tag-chip static" key={tag}>{tag}</span>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
      {confirm && (
        <Modal
          labelledBy="withdraw-opportunity-title"
          describedBy="withdraw-opportunity-desc"
          onDismiss={() => { if (!withdrawing) setConfirm(false); }}
        >
          <div className="modal-head">
            <div>
              <h2 id="withdraw-opportunity-title">Withdraw this {entityLabel}?</h2>
              <p id="withdraw-opportunity-desc">
                It leaves the marketplace immediately. No new proposals can be submitted.
                Existing proposals stay on file.
              </p>
            </div>
          </div>
          <div className="modal-body">
            <Field
              htmlFor="opportunity-withdrawal-reason"
              label="Why are you withdrawing?"
              error={reasonError}
              hint="A hash of this exact text is anchored on Arbitrum Sepolia, and the text is shown to members who can still see the opportunity. It cannot be changed afterwards."
            >
              {({ id, describedBy, invalid }) => (
                <textarea
                  id={id}
                  rows={3}
                  value={anchoredWithdrawal?.reason ?? reason}
                  maxLength={1000}
                  disabled={withdrawing || Boolean(anchoredWithdrawal)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  onChange={(event) => {
                    if (anchoredWithdrawal) return;
                    setReason(event.target.value);
                    setReasonError("");
                  }}
                />
              )}
            </Field>
            {error && anchoredWithdrawal ? <p className="error-banner" role="alert">{error}</p> : null}
            <p className="field-hint">
              {anchoredWithdrawal
                ? "The withdrawal is already signed on Arbitrum Sepolia. Saving it does not need another signature."
                : "Your wallet signs the withdrawal before it takes effect. If you decline, the opportunity stays listed exactly as it is."}
            </p>
          </div>
          <div className="modal-actions">
            <button className="secondary" type="button" disabled={withdrawing || Boolean(anchoredWithdrawal)} onClick={() => setConfirm(false)}>
              Keep {entityLabel}
            </button>
            <button className="danger-btn" type="button" disabled={withdrawing} onClick={withdraw}>
              {withdrawing
                ? (anchoredWithdrawal ? "Saving…" : "Waiting for your wallet…")
                : (anchoredWithdrawal ? "Finish saving withdrawal" : "Sign and withdraw")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
