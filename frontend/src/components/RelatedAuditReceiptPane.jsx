import { AuditDetailPane } from "./AuditDetailPane.jsx";
import { AuditReceipt } from "./AuditReceipt.jsx";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { toDate } from "../lib/datetime.js";
import {
  fundingOpportunityAuditReceipt,
  readFundingOpportunityAudit,
} from "../lib/fundingOpportunityAudit.js";
import { postingAuditReceipt, readPostingAudit } from "../lib/postingAudit.js";
import { proposalAuditReceipt, readProposalAudit } from "../lib/proposalAudit.js";

export const RELATED_AUDIT_KIND = Object.freeze({
  PROPOSAL: "proposal",
  LISTING: "listing",
  COMMENT: "comment",
});

function listingForAudit(record) {
  if (!record) return null;
  const expiresAt = toDate(record.expiresAt);
  return expiresAt ? { ...record, expiresAt } : record;
}

function listingAudit(record) {
  const prepared = listingForAudit(record);
  const read = prepared.opportunityType === OPEN_FUNDING_TYPE
    ? fundingOpportunityAuditReceipt
    : postingAuditReceipt;
  try {
    return read(prepared) || prepared.audit || null;
  } catch {
    return prepared.audit || null;
  }
}

/** AuditReceipt wiring shared with proposal and listing detail pages. */
export function RelatedAuditReceipt({ kind, record }) {
  if (!record || kind === RELATED_AUDIT_KIND.COMMENT) return null;

  if (kind === RELATED_AUDIT_KIND.PROPOSAL) {
    return (
      <AuditReceipt
        entityLabel="Proposal"
        audit={proposalAuditReceipt(record)}
        eventLabel="Proposal submitted"
        actorRole="Researcher / solution developer"
        firebaseReference={`proposals/${record.id}`}
        recordTimestamp={record.updatedAt ?? record.createdAt}
        onVerify={() => readProposalAudit(record)}
      />
    );
  }

  if (kind !== RELATED_AUDIT_KIND.LISTING) return null;

  const prepared = listingForAudit(record);
  const isOpenFunding = prepared.opportunityType === OPEN_FUNDING_TYPE;
  return (
    <AuditReceipt
      audit={listingAudit(record)}
      entityLabel={isOpenFunding ? "Funding opportunity" : "Posting"}
      eventLabel={isOpenFunding
        ? "Open funding opportunity submitted"
        : "Problem statement submitted"}
      actorRole={isOpenFunding ? "Funder" : "Problem owner"}
      firebaseReference={`problems/${prepared.id}`}
      recordTimestamp={prepared.updatedAt ?? prepared.createdAt}
      onVerify={() => (isOpenFunding
        ? readFundingOpportunityAudit(prepared)
        : readPostingAudit(prepared))}
    />
  );
}

/**
 * Opens the on-chain receipt for a loaded proposal or listing.
 * Comments are off-chain and never receive an AuditReceipt.
 */
export function RelatedAuditReceiptPane({
  kind,
  record,
  loading = false,
  error = "",
  onClose,
}) {
  const known = Object.values(RELATED_AUDIT_KIND).includes(kind);
  if (!onClose || (!loading && !error && !record && !known)) return null;

  const title = kind === RELATED_AUDIT_KIND.PROPOSAL
    ? (record?.title || "Proposal audit receipt")
    : kind === RELATED_AUDIT_KIND.LISTING
      ? (record?.title || "Listing audit receipt")
      : "Audit receipt";

  return (
    <AuditDetailPane title={title} onClose={onClose}>
      {loading && <p role="status">Loading audit receipt…</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {!loading && !error && kind === RELATED_AUDIT_KIND.COMMENT && (
        <p className="field-hint">
          Evaluator recommendation comments are recorded off-chain. They do not
          have an on-chain audit receipt.
        </p>
      )}
      {!loading && !error && !record && kind !== RELATED_AUDIT_KIND.COMMENT && known && (
        <p className="field-hint">
          This record is no longer available, so its verification receipt cannot
          be opened.
        </p>
      )}
      {!loading && !error && record && kind !== RELATED_AUDIT_KIND.COMMENT && (
        <RelatedAuditReceipt kind={kind} record={record} />
      )}
    </AuditDetailPane>
  );
}
