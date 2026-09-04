import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { useAuth } from "../context/AuthContext.jsx";
import { findPosting } from "../lib/postings.js";
import {
  downloadAttachment,
  formatBytes,
  messageForStorageError,
  saveBlobAs,
} from "../lib/attachments.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { categoryLabel } from "../config/postingCategories.js";
import { ExpiryCountdown } from "../components/ExpiryCountdown.jsx";
import { AuditReceipt } from "../components/AuditReceipt.jsx";
import { ConnectWalletModal } from "../components/ConnectWalletModal.jsx";
import { formatInstant, isExpired } from "../lib/datetime.js";
import {
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

/**
 * QCDAO-48 - the posting the confirmation screen links to, and the place QCDAO-58
 * attachments are downloaded from.
 *
 * Reads are governed by firebase/firestore.rules, which currently allows a posting
 * to be read only by its owner. A viewer who is not the owner therefore sees the
 * not-found state rather than the content - correct today, and the single place to
 * revisit when postings become discoverable by other organisations.
 */

function Detail({ heading, children }) {
  if (!children) return null;
  return (
    <div className="detail-section">
      <h2>{heading}</h2>
      <p>{children}</p>
    </div>
  );
}

export default function PostingDetailPage({ postingId, onNavigate }) {
  const { isAuthenticated, user } = useAuth();
  const { address: connectedAddress, isConnected } = useAccount();
  const [posting, setPosting] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const [walletPromptOpen, setWalletPromptOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    findPosting(postingId)
      .then((found) => { if (!cancelled) setPosting(found); })
      .catch((lookupError) => { if (!cancelled) setError(messageForFirebaseError(lookupError)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [postingId]);

  const download = async (attachment) => {
    setError(null);
    try {
      saveBlobAs(await downloadAttachment(attachment), attachment.name);
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

  const expired = isExpired(posting.expiresAt);
  const isOpenFunding = posting.opportunityType === OPEN_FUNDING_TYPE;
  const audit = isOpenFunding
    ? fundingOpportunityAuditReceipt(posting)
    : postingAuditReceipt(posting);

  return (
    <section className="page detail-page">
      <button className="back" type="button" onClick={() => onNavigate("discover")}>
        Back to opportunities
      </button>

      {walletPromptOpen && (
        <ConnectWalletModal onClose={() => setWalletPromptOpen(false)} />
      )}

      <div className="detail-layout">
        <article className="detail-main">
          <div className="card-top">
            <span className="eyebrow">
              {isOpenFunding ? "Open funding opportunity" : "Funded business problem"}
            </span>
            <span className="status-dot">{expired ? "expired" : posting.status}</span>
          </div>
          <h1>{posting.title}</h1>
          <p className="lead">{isOpenFunding ? posting.fundingThesis : posting.summary}</p>

          {isOpenFunding ? (
            <Detail heading="Eligibility">{posting.eligibilityNotes}</Detail>
          ) : (
            <>
              <Detail heading="Business context">{posting.businessContext}</Detail>
              <Detail heading="Current approach">{posting.currentApproach}</Detail>
              <Detail heading="Limitations of that approach">{posting.currentLimitations}</Detail>
              <Detail heading="Expected outcome">{posting.expectedOutcome}</Detail>
              <Detail heading="Success criteria">{posting.successCriteria}</Detail>
              <Detail heading="Data availability">{posting.dataAvailability}</Detail>
            </>
          )}

          {!isOpenFunding && posting.attachments.length > 0 && (
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

          <AuditReceipt
            audit={audit}
            eventLabel={isOpenFunding
              ? "Open funding opportunity submitted"
              : "Funded problem statement submitted"}
            actorRole={isOpenFunding ? "Funder" : "Problem owner"}
            firebaseReference={`problems/${posting.id}`}
            onVerify={verifyAudit}
            onRetry={!auditBusy && ownsPosting ? retryAudit : undefined}
          />

          {error && <p className="attachment-error" role="alert">{error}</p>}
        </article>

        <aside className="context-panel">
          <span className="eyebrow">{isOpenFunding ? "Indicative funding" : "Funding"}</span>
          <strong>{posting.currency} {Number(posting.amount).toLocaleString()}</strong>
          <dl>
            <div><dt>Posted by</dt><dd>{posting.organisation}</dd></div>
            <div><dt>Submitted</dt><dd>{formatInstant(posting.createdAt)}</dd></div>
            <div><dt>Reference</dt><dd><code>{posting.id}</code></dd></div>
          </dl>

          <div className="expiry-panel">
            <span className="eyebrow">{expired ? "Closed" : "Time remaining"}</span>
            <ExpiryCountdown expiresAt={posting.expiresAt} />
          </div>

          {posting.categories.length > 0 && (
            <>
              <span className="eyebrow">Approaches of interest</span>
              <div className="tag-list">
                {posting.categories.map((value) => (
                  <span className="tag-chip static" key={value}>{categoryLabel(value)}</span>
                ))}
              </div>
            </>
          )}

          {isOpenFunding && posting.tags.length > 0 && (
            <>
              <span className="eyebrow">Tags</span>
              <div className="tag-list">
                {posting.tags.map((tag) => (
                  <span className="tag-chip static" key={tag}>{tag}</span>
                ))}
              </div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
