import { randomBytes } from "node:crypto";
import { HttpsError } from "firebase-functions/v2/https";
import { opportunityWorkflowStatus, proposalWorkflowStatus, workflowStatusLabel } from "./workflowStatus.js";
import { EXPORT_NOTICE, EXPORT_SCHEMA_VERSION, latestCurrentDate } from "./proposalExportNotice.js";

export { EXPORT_NOTICE, EXPORT_SCHEMA_VERSION };

/** One pass reads at most this many accepted postings or proposals. */
export const EXPORT_SCAN_CAP = 500;
/** Comments beyond this on one proposal are refused rather than silently dropped. */
export const EXPORT_COMMENT_CAP = 1000;

const RECOMMENDATIONS = new Set(["recommend", "recommend_with_revisions", "do_not_recommend"]);
const EXPORTABLE_STATUSES = ["submitted", "under_review", "accepted", "rejected", "withdrawn"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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

const fail = (code, message) => { throw new HttpsError(code, message); };

function millis(value) {
  if (value == null || value === "") return 0;
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function iso(value) {
  const ms = millis(value);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function amount(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dayBound(value, end) {
  if (typeof value !== "string" || !DAY.test(value)) fail("invalid-argument", "Use a YYYY-MM-DD date.");
  const [year, month, day] = value.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
  const parsed = new Date(utc);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    fail("invalid-argument", "Use a real calendar date.");
  }
  return utc;
}

/** One proposal, or an inclusive UTC date range. Not both. */
export function parseExportRequest(input, now = new Date()) {
  const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const key of ["proposalId", "startDate", "endDate"]) {
    if (data[key] != null && data[key] !== "" && typeof data[key] !== "string") {
      fail("invalid-argument", "Proposal and date fields must be text.");
    }
  }
  const proposalId = text(data.proposalId).trim();
  const startDate = text(data.startDate).trim();
  const endDate = text(data.endDate).trim();
  const hasProposal = proposalId !== "";
  const hasRange = startDate !== "" || endDate !== "";
  if (hasProposal === hasRange) {
    fail("invalid-argument", hasProposal
      ? "Export one proposal or a date range, not both."
      : "Choose a proposal or a start and end date.");
  }
  const acceptance = data.acceptance == null || data.acceptance === "" ? "all" : String(data.acceptance);
  if (acceptance !== "accepted" && acceptance !== "all") {
    fail("invalid-argument", "Choose accepted proposals only, or accepted and not accepted.");
  }
  if (hasProposal) {
    if (!ID.test(proposalId)) fail("invalid-argument", "That proposal reference is not valid.");
    return { mode: "proposal", acceptance, proposalId, startDate: null, endDate: null, start: null, end: null };
  }
  if (!startDate || !endDate) fail("invalid-argument", "Choose both a start date and an end date.");
  const start = dayBound(startDate, false);
  const end = dayBound(endDate, true);
  if (start > end) fail("invalid-argument", "The start date is after the end date.");
  const latest = latestCurrentDate(now);
  if (endDate > latest) {
    fail("invalid-argument", `The end date cannot be after ${latest}, the latest current date (UTC+14).`);
  }
  return { mode: "range", acceptance, proposalId: null, startDate, endDate, start, end };
}

export function isAcceptedProposal(problem, proposal) {
  if (!proposal || proposal.status === "draft") return false;
  if (proposal.status === "accepted" || proposal.matching?.status === "confirmed") return true;
  if (!problem) return false;
  if (text(problem.acceptedProposalId).trim() === proposal.id) return true;
  return problem.matching?.status === "confirmed" && problem.matching.proposalId === proposal.id;
}

function wantedIds(problem, proposals) {
  const ids = new Set();
  const acceptedId = text(problem.acceptedProposalId).trim();
  if (acceptedId) ids.add(acceptedId);
  if (problem.matching?.status === "confirmed") {
    const selected = text(problem.matching.proposalId).trim();
    if (selected) ids.add(selected);
  }
  for (const proposal of proposals) {
    if (proposal.problemId === problem.id && (proposal.status === "accepted" || proposal.matching?.status === "confirmed")) {
      ids.add(proposal.id);
    }
  }
  return ids;
}

function acceptanceMs(problem, proposal) {
  const matching = problem.matching || {};
  if (matching.status === "confirmed" && matching.proposalId === proposal.id) {
    const confirmed = millis(matching.confirmedAt);
    if (confirmed) return confirmed;
  }
  if (proposal.matching?.status === "confirmed") {
    const confirmed = millis(proposal.matching?.confirmedAt);
    if (confirmed) return confirmed;
  }
  if (proposal.status === "accepted" || proposal.matching?.status === "confirmed" || problem.acceptedProposalId === proposal.id) {
    return millis(proposal.updatedAt) || millis(proposal.createdAt) || millis(problem.updatedAt) || millis(problem.createdAt);
  }
  return 0;
}

async function readCapped(query, label) {
  const snap = await query.limit(EXPORT_SCAN_CAP + 1).get();
  if (snap.size > EXPORT_SCAN_CAP) {
    fail("resource-exhausted", `Too many ${label} to export in one pass. Export a single posting instead.`);
  }
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() ?? {}) }));
}

async function loadProblem(db, id, cached) {
  if (cached.has(id)) return cached.get(id);
  const snap = await db.collection("problems").doc(id).get();
  if (!snap.exists) return null;
  const problem = { id: snap.id, ...(snap.data() ?? {}) };
  cached.set(id, problem);
  return problem;
}

async function hydrate(db, problem, known) {
  const byId = new Map();
  for (const proposal of known) {
    if (proposal.problemId === problem.id) byId.set(proposal.id, proposal);
  }
  const ids = wantedIds(problem, [...byId.values()]);
  for (const id of ids) {
    if (byId.has(id)) continue;
    if (!ID.test(id)) fail("failed-precondition", `Posting ${problem.id} points at a proposal reference that is not valid.`);
    const snap = await db.collection("proposals").doc(id).get();
    if (!snap.exists) fail("failed-precondition", `Accepted proposal ${id} on posting ${problem.id} is missing.`);
    const proposal = { id: snap.id, ...(snap.data() ?? {}) };
    if (proposal.problemId && proposal.problemId !== problem.id) {
      fail("failed-precondition", `Accepted proposal ${id} does not belong to posting ${problem.id}.`);
    }
    byId.set(id, proposal);
  }
  return [...byId.values()].filter((proposal) => ids.has(proposal.id));
}

async function loadComments(db, proposalId) {
  const snap = await db.collection("comments").where("proposalId", "==", proposalId).limit(EXPORT_COMMENT_CAP + 1).get();
  if (snap.size > EXPORT_COMMENT_CAP) {
    fail("resource-exhausted", `Proposal ${proposalId} has more comments than one export can include.`);
  }
  return snap.docs.map((doc) => commentView(doc.id, doc.data() ?? {}))
    .sort((left, right) => (left.createdAt || "").localeCompare(right.createdAt || "") || left.id.localeCompare(right.id));
}

function commentView(id, data) {
  const recommendation = RECOMMENDATIONS.has(data.recommendation) ? data.recommendation : null;
  const parentId = typeof data.parentId === "string" && data.parentId ? data.parentId : null;
  return {
    id,
    authorId: text(data.authorId),
    authorRole: text(data.authorRole) || "user",
    badge: data.badge === "evaluator" ? "evaluator" : null,
    recommendation,
    recommendationLabel: recommendation ? workflowStatusLabel(recommendation) || null : null,
    body: text(data.body),
    parentId,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    editedAt: iso(data.editedAt),
    deletedAt: iso(data.deletedAt),
    qualifying: data.qualifying === true,
    moderationStatus: text(data.moderationStatus) || "visible",
  };
}

function postingView(problem, proposals) {
  const acceptedMs = proposals.map((proposal) => acceptanceMs(problem, proposal)).filter((value) => value > 0);
  const categories = Array.isArray(problem.categories) ? problem.categories.filter((item) => typeof item === "string") : [];
  return {
    id: problem.id,
    title: text(problem.title),
    summary: text(problem.summary),
    status: text(problem.status),
    workflowStatus: opportunityWorkflowStatus(problem),
    opportunityType: text(problem.opportunityType) || null,
    ownerId: text(problem.ownerId),
    organisation: text(problem.organisation),
    categories,
    amount: amount(problem.amount),
    currency: text(problem.currency) || null,
    createdAt: iso(problem.createdAt),
    updatedAt: iso(problem.updatedAt),
    expiresAt: iso(problem.expiresAt),
    acceptedAt: acceptedMs.length ? new Date(Math.min(...acceptedMs)).toISOString() : null,
    proposals: proposals.map(proposalView).sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function proposalView(proposal) {
  return {
    id: proposal.id,
    title: text(proposal.title),
    summary: text(proposal.summary),
    status: text(proposal.status),
    workflowStatus: proposalWorkflowStatus(proposal),
    accepted: proposal.accepted === true,
    researcherId: text(proposal.researcherId),
    amount: amount(proposal.amount),
    currency: text(proposal.currency) || null,
    category: text(proposal.category) || null,
    createdAt: iso(proposal.createdAt),
    updatedAt: iso(proposal.updatedAt),
    comments: proposal.comments || [],
  };
}

function inRange(ms, scope) {
  return ms > 0 && ms >= scope.start && ms <= scope.end;
}

async function withComments(db, problem, proposals) {
  const selected = [];
  for (const proposal of proposals) {
    selected.push({ ...proposal, comments: await loadComments(db, proposal.id) });
  }
  return postingView(problem, selected);
}

async function loadOne(db, scope) {
  const snap = await db.collection("proposals").doc(scope.proposalId).get();
  if (!snap.exists) fail("not-found", "That proposal was not found.");
  const proposal = { id: snap.id, ...(snap.data() ?? {}) };
  if (proposal.status === "draft" || !EXPORTABLE_STATUSES.includes(proposal.status)) {
    fail("failed-precondition", "Draft proposals are not exported.");
  }
  const problem = proposal.problemId ? await loadProblem(db, proposal.problemId, new Map()) : null;
  proposal.accepted = isAcceptedProposal(problem, proposal);
  if (scope.acceptance === "accepted" && !proposal.accepted) {
    fail("failed-precondition", "This proposal has not been accepted. Choose accepted and not accepted to include it.");
  }
  return [await withComments(db, problem || emptyPosting(), [proposal])];
}

function emptyPosting() {
  return {
    id: "", title: "", summary: "", status: "", ownerId: "", organisation: "",
    categories: [], amount: null, currency: null,
  };
}

function proposalMoment(proposal) {
  return millis(proposal.createdAt) || millis(proposal.updatedAt);
}

async function loadRange(db, scope) {
  const proposals = await readCapped(
    db.collection("proposals").where("status", "in", EXPORTABLE_STATUSES),
    "proposals",
  );
  const matched = proposals.filter((proposal) => proposal.status !== "draft" && inRange(proposalMoment(proposal), scope));
  const cached = new Map();
  const groups = new Map();
  for (const proposal of matched) {
    const key = proposal.problemId || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(proposal);
  }
  const postings = [];
  for (const [problemId, rows] of groups) {
    const problem = problemId ? await loadProblem(db, problemId, cached) : null;
    const marked = rows
      .map((proposal) => ({ ...proposal, accepted: isAcceptedProposal(problem, proposal) }))
      .filter((proposal) => scope.acceptance === "all" || proposal.accepted);
    if (!marked.length) continue;
    postings.push(await withComments(db, problem || emptyPosting(), marked));
  }
  postings.sort((left, right) => (left.acceptedAt || left.createdAt || "").localeCompare(right.acceptedAt || right.createdAt || "") || left.id.localeCompare(right.id));
  return postings;
}

function buildDocument(postings, scope, exportedAt) {
  const proposalCount = postings.reduce((total, posting) => total + posting.proposals.length, 0);
  const commentCount = postings.reduce((total, posting) => total
    + posting.proposals.reduce((sum, proposal) => sum + proposal.comments.length, 0), 0);
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt,
    scope: {
      mode: scope.mode,
      acceptance: scope.acceptance,
      proposalId: scope.proposalId,
      startDate: scope.startDate,
      endDate: scope.endDate,
    },
    notice: EXPORT_NOTICE,
    postingCount: postings.length,
    proposalCount,
    commentCount,
    postings,
  };
}

function csvCell(value) {
  if (value == null) return "";
  let textValue = typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  // Spreadsheets treat a leading =, +, - or @ as a formula. The JSON file keeps the exact text.
  if (/^[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
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

/**
 * QCDAO-107. Reads proposals through the Admin SDK, accepted or not, so the
 * browser gains no new access to comments. The caller must already be an administrator.
 */
export async function listExportableProposals({ db }) {
  const proposals = await readCapped(
    db.collection("proposals").where("status", "in", EXPORTABLE_STATUSES),
    "proposals",
  );
  const cached = new Map();
  const rows = [];
  for (const proposal of proposals) {
    if (proposal.status === "draft") continue;
    const problem = proposal.problemId ? await loadProblem(db, proposal.problemId, cached) : null;
    const workflowStatus = proposalWorkflowStatus(proposal);
    rows.push({
      id: proposal.id,
      title: text(proposal.title) || "Untitled proposal",
      status: text(proposal.status),
      workflowStatus,
      workflowLabel: workflowStatusLabel(workflowStatus) || text(proposal.status),
      accepted: isAcceptedProposal(problem, proposal),
      problemId: proposal.problemId || null,
      problemTitle: text(problem?.title) || null,
      createdAt: iso(proposal.createdAt),
    });
  }
  rows.sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  return { proposals: rows };
}

export async function exportSelectedProposals({ db, actorUid, actorName, input, now }) {
  if (typeof actorUid !== "string" || !actorUid) fail("unauthenticated", "Authentication required.");
  const scope = parseExportRequest(input, now);
  const postings = scope.mode === "proposal" ? await loadOne(db, scope) : await loadRange(db, scope);
  const document = buildDocument(postings, scope, iso(now) || new Date().toISOString());
  const csv = exportToCsv(document);
  const auditId = randomBytes(12).toString("hex");
  const parentId = document.postings.find((posting) => posting.id)?.id || null;
  const title = scope.mode === "proposal"
    ? (document.postings[0]?.proposals[0]?.title || scope.proposalId)
    : `Proposals ${scope.startDate} to ${scope.endDate}`;
  await db.collection("audits").doc(auditId).set({
    type: "proposal_comment_export",
    action: "PROPOSAL_COMMENT_EXPORT",
    actor: actorUid,
    actorName: actorName || actorUid,
    scope: scope.mode,
    acceptance: scope.acceptance,
    proposalId: scope.proposalId,
    postingId: scope.mode === "proposal" ? parentId : null,
    startDate: scope.startDate,
    endDate: scope.endDate,
    postingIds: document.postings.map((posting) => posting.id).filter(Boolean),
    postingCount: document.postingCount,
    proposalCount: document.proposalCount,
    commentCount: document.commentCount,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    problemId: scope.mode === "proposal" ? parentId : null,
    targetId: scope.mode === "proposal" ? parentId : null,
    title,
    timestamp: now,
    createdAt: now,
  });
  return {
    document,
    csv,
    auditId,
    postingCount: document.postingCount,
    proposalCount: document.proposalCount,
    commentCount: document.commentCount,
  };
}
