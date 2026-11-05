// Shared browser/server file format. No privileged reads or platform dependencies.
// Spreadsheet importers can discard leading control/format characters before
// interpreting a formula. Detect through them, but retain the original text.
const FORMULA_PREFIX = /^[\s\p{Cc}\p{Cf}]*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u;
export const CSV_COLUMNS = Object.freeze([
  "schemaVersion",
  "exportedAt",
  "postingId",
  "postingTitle",
  "postingSummary",
  "postingStatus",
  "postingWorkflowStatus",
  "opportunityType",
  "ownerId",
  "organisation",
  "postingAmount",
  "postingCurrency",
  "acceptedAt",
  "proposalId",
  "proposalTitle",
  "proposalSummary",
  "proposalStatus",
  "proposalWorkflowStatus",
  "accepted",
  "researcherId",
  "proposalAmount",
  "proposalCurrency",
  "proposalCategory",
  "commentId",
  "authorId",
  "authorRole",
  "badge",
  "recommendation",
  "recommendationLabel",
  "commentBody",
  "parentId",
  "commentCreatedAt",
  "commentUpdatedAt",
  "editedAt",
  "deletedAt",
  "qualifying",
  "moderationStatus",
]);


function csvCell(value) {
  if (value == null) return "";
  let textValue = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  // Prefix the original cell, not a trimmed/normalized copy. JSON stays exact.
  if (FORMULA_PREFIX.test(textValue)) textValue = `'${textValue}`;
  if (/[",\r\n]/.test(textValue)) return `"${textValue.replaceAll("\"", "\"\"")}"`;
  return textValue;
}

/** One row per comment. A selected proposal with no comments still occupies one row. */
export function exportToCsv(document) {
  const lines = [CSV_COLUMNS.join(",")];
  for (const posting of document.postings) {
    const proposals = posting.proposals.length ? posting.proposals : [null];
    for (const proposal of proposals) {
      const comments = proposal?.comments.length ? proposal.comments : [null];
      for (const comment of comments) {
        const row = {
          schemaVersion: document.schemaVersion,
          exportedAt: document.exportedAt,
          postingId: posting.id,
          postingTitle: posting.title,
          postingSummary: posting.summary,
          postingStatus: posting.status,
          postingWorkflowStatus: posting.workflowStatus,
          opportunityType: posting.opportunityType,
          ownerId: posting.ownerId,
          organisation: posting.organisation,
          postingAmount: posting.amount,
          postingCurrency: posting.currency,
          acceptedAt: posting.acceptedAt,
          proposalId: proposal?.id ?? null,
          proposalTitle: proposal?.title ?? null,
          proposalSummary: proposal?.summary ?? null,
          proposalStatus: proposal?.status ?? null,
          proposalWorkflowStatus: proposal?.workflowStatus ?? null,
          accepted: proposal ? proposal.accepted === true : null,
          researcherId: proposal?.researcherId ?? null,
          proposalAmount: proposal?.amount ?? null,
          proposalCurrency: proposal?.currency ?? null,
          proposalCategory: proposal?.category ?? null,
          commentId: comment?.id ?? null,
          authorId: comment?.authorId ?? null,
          authorRole: comment?.authorRole ?? null,
          badge: comment?.badge ?? null,
          recommendation: comment?.recommendation ?? null,
          recommendationLabel: comment?.recommendationLabel ?? null,
          commentBody: comment?.body ?? null,
          parentId: comment?.parentId ?? null,
          commentCreatedAt: comment?.createdAt ?? null,
          commentUpdatedAt: comment?.updatedAt ?? null,
          editedAt: comment?.editedAt ?? null,
          deletedAt: comment?.deletedAt ?? null,
          qualifying: comment ? comment.qualifying : null,
          moderationStatus: comment?.moderationStatus ?? null,
        };
        lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(","));
      }
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}

