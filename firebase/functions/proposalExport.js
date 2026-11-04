import { createHash, randomBytes } from "node:crypto";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { opportunityWorkflowStatus, proposalWorkflowStatus, workflowStatusLabel } from "./workflowStatus.js";
import { EXPORT_NOTICE, EXPORT_SCHEMA_VERSION, latestCurrentDate } from "./proposalExportNotice.js";

export { EXPORT_NOTICE, EXPORT_SCHEMA_VERSION };
export { CSV_COLUMNS, exportToCsv } from "./proposalExportFormat.js";

/** One pass reads at most this many accepted postings or proposals. */
export const EXPORT_SCAN_CAP = 500;
/** Each call scans at most this many projected comment documents. */
export const EXPORT_COMMENT_PAGE_SIZE = 50;
export const EXPORT_PAGE_BYTES = 256 * 1024;
export const EXPORT_SESSION_BYTES = 800 * 1024;
export const EXPORT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const EXPORT_SESSION_COLLECTION = "proposalExportSessions";
const PROPOSAL_FIELDS = ["problemId", "title", "summary", "status", "matching.status", "matching.confirmedAt", "problemMatching.status", "fundingTerms", "researcherId", "amount", "currency", "category", "createdAt", "updatedAt", "proposalKind", "moderationStatus"];
const POSTING_FIELDS = ["title", "summary", "status", "matching.status", "matching.proposalId", "matching.confirmedAt", "hasAcceptedSolution", "acceptedProposalId", "opportunityType", "ownerId", "organisation", "categories", "amount", "currency", "createdAt", "updatedAt", "expiresAt", "moderationStatus"];
const COMMENT_FIELDS = ["authorId", "authorRole", "badge", "recommendation", "body", "parentId", "createdAt", "updatedAt", "editedAt", "deletedAt", "qualifying", "moderationStatus"];
const byteSize = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

const RECOMMENDATIONS = new Set(["recommend", "recommend_with_revisions", "do_not_recommend"]);
const EXPORTABLE_STATUSES = ["submitted", "under_review", "accepted", "rejected", "withdrawn"];
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

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
  const snap = await query.select(...PROPOSAL_FIELDS).limit(EXPORT_SCAN_CAP + 1).get();
  if (snap.size > EXPORT_SCAN_CAP) {
    fail("resource-exhausted", `Too many ${label} to export in one pass. Choose one proposal instead. A shorter date range cannot bypass this scan limit.`);
  }
  return snap.docs.map((doc) => ({ ...(doc.data() ?? {}), id: doc.id }));
}

async function loadProblem(db, id, cached) {
  if (cached.has(id)) return cached.get(id);
  const snap = await projectedDocument(db, "problems", id, POSTING_FIELDS);
  if (!snap.exists) return null;
  const problem = { ...(snap.data() ?? {}), id: snap.id };
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
    const proposal = { ...(snap.data() ?? {}), id: snap.id };
    if (proposal.problemId && proposal.problemId !== problem.id) {
      fail("failed-precondition", `Accepted proposal ${id} does not belong to posting ${problem.id}.`);
    }
    byId.set(id, proposal);
  }
  return [...byId.values()].filter((proposal) => ids.has(proposal.id));
}

async function projectedDocument(db, collection, id, fields, tx) {
  const query = db.collection(collection).where(FieldPath.documentId(), "==", id).select(...fields).limit(1);
  const rows = await (tx ? tx.get(query) : query.get());
  return rows.docs[0] || { exists: false };
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


async function loadOne(db, scope) {
  const snap = await projectedDocument(db, "proposals", scope.proposalId, PROPOSAL_FIELDS);
  if (!snap.exists) fail("not-found", "That proposal was not found.");
  const proposal = { ...(snap.data() ?? {}), id: snap.id };
  if (proposal.status === "draft" || !EXPORTABLE_STATUSES.includes(proposal.status)) {
    fail("failed-precondition", "Draft proposals are not exported.");
  }
  const problem = proposal.problemId ? await loadProblem(db, proposal.problemId, new Map()) : null;
  proposal.accepted = isAcceptedProposal(problem, proposal);
  if (scope.acceptance === "accepted" && !proposal.accepted) {
    fail("failed-precondition", "This proposal has not been accepted. Choose accepted and not accepted to include it.");
  }
  return [postingView(problem || emptyPosting(), [proposal])];
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
    postings.push(postingView(problem || emptyPosting(), marked));
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


function scopeView(scope) {
  const { mode, acceptance, proposalId, startDate, endDate } = scope;
  return { mode, acceptance, proposalId, startDate, endDate };
}

function sameScope(left, right) {
  const fields = ["mode", "acceptance", "proposalId", "startDate", "endDate"];
  return right != null && typeof right === "object" && !Array.isArray(right)
    && Object.keys(left).length === fields.length && Object.keys(right).length === fields.length
    && fields.every((field) => Object.hasOwn(right, field) && left[field] === right[field]);
}

async function initialSession({ db, actorUid, actorName, input, now, exportId }) {
  const scope = parseExportRequest(input, now);
  const postings = scope.mode === "proposal" ? await loadOne(db, scope) : await loadRange(db, scope);
  // IDs, acceptance and group order are fixed before paging. Metadata and comment
  // bodies are read when their proposal is reached; this is not a global snapshot.
  const manifest = postings.flatMap((posting, postingIndex) => posting.proposals.map((proposal) => ({
    postingIndex, proposalId: proposal.id, postingId: posting.id, accepted: proposal.accepted, acceptedAt: posting.acceptedAt,
  })));
  // An ascending, projected one-row query captures authoritative server time.
  // Descending document-key scans are unsupported. Membership is frozen by
  // system createTime, while the monotonic ID cursor bounds each later scan.
  const start = await db.collection("comments").select().limit(1).get();
  const startedAt = millis(start.readTime) || millis(now);
  const state = {
    actorUid, actorName: actorName || actorUid, exportId, scope: scopeView(scope),
    exportedAt: new Date(startedAt).toISOString(), startedAt,
    readTime: start.readTime || Timestamp.fromMillis(startedAt), expiresAt: Timestamp.fromMillis(startedAt + EXPORT_SESSION_TTL_MS),
    hasCommentsAtStart: start.size > 0,
    manifest, postingIds: postings.map((posting) => posting.id).filter(Boolean),
    postingCount: postings.length, proposalCount: manifest.length, commentCount: 0,
    title: scope.mode === "proposal" ? (postings[0]?.proposals[0]?.title || scope.proposalId)
      : `Proposals ${scope.startDate} to ${scope.endDate}`,
    index: 0, afterId: null, proposalCommentCount: 0, metadata: null, groupMetadata: null, lastPage: -1, lastResponse: null, done: false,
  };
  if (byteSize(state) > EXPORT_SESSION_BYTES - EXPORT_PAGE_BYTES * 2) {
    fail("resource-exhausted", "The proposal selection is too large. Choose one proposal instead.");
  }
  return state;
}

async function proposalMetadata(db, tx, entry, groupMetadata) {
  const snap = await projectedDocument(db, "proposals", entry.proposalId, PROPOSAL_FIELDS, tx);
  if (!snap.exists) fail("failed-precondition", "A proposal in this export was deleted. Start the export again.");
  const proposal = { ...(snap.data() ?? {}), id: snap.id, accepted: entry.accepted };
  if (groupMetadata) return { ...groupMetadata, proposals: [proposalView(proposal)] };
  const parent = entry.postingId ? await projectedDocument(db, "problems", entry.postingId, POSTING_FIELDS, tx) : null;
  if (entry.postingId && !parent?.exists) {
    fail("failed-precondition", "A posting in this export was deleted. Start the export again.");
  }
  const posting = postingView(parent ? { ...(parent.data() ?? {}), id: parent.id } : emptyPosting(), [proposal]);
  posting.acceptedAt = entry.acceptedAt;
  return posting;
}

function createdAfterCutoff(created, cutoff) {
  if (!created) return false; // Only the unit-test fake omits system timestamps.
  if (Number.isInteger(created.seconds) && Number.isInteger(cutoff.seconds)) {
    return created.seconds > cutoff.seconds || (created.seconds === cutoff.seconds && created.nanoseconds > cutoff.nanoseconds);
  }
  return millis(created) > millis(cutoff);
}

function responseFor(state, page, posting, comments, done, emptyProposal = false) {
  const postings = posting && (comments.length > 0 || emptyProposal) ? [{ ...posting, proposals: [{ ...posting.proposals[0], comments }] }] : [];
  return {
    protocolVersion: 1,
    exportId: state.exportId,
    page,
    postingIndex: state.manifest[state.index]?.postingIndex ?? null,
    document: buildDocument(postings, state.scope, state.exportedAt),
    done,
    nextCursor: done ? null : { exportId: state.exportId, page: page + 1 },
    auditId: done ? state.exportId : null,
    totals: { postingCount: state.postingCount, proposalCount: state.proposalCount, commentCount: state.commentCount + comments.length },
  };
}

function completedAudit(state, now) {
  const parentId = state.postingIds[0] || null;
  return {
    type: "proposal_comment_export", action: "PROPOSAL_COMMENT_EXPORT",
    actor: state.actorUid, actorName: state.actorName, scope: state.scope.mode,
    acceptance: state.scope.acceptance, proposalId: state.scope.proposalId,
    postingId: state.scope.mode === "proposal" ? parentId : null,
    startDate: state.scope.startDate, endDate: state.scope.endDate,
    postingIds: state.postingIds, postingCount: state.postingCount,
    proposalCount: state.proposalCount, commentCount: state.commentCount,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    problemId: state.scope.mode === "proposal" ? parentId : null,
    targetId: state.scope.mode === "proposal" ? parentId : null,
    title: state.title, timestamp: now, createdAt: now,
  };
}

/**
 * Server-owned, sequential export continuation. Only the last response is cached;
 * the caller must consume each page before requesting the next one. The callable
 * wrapper authenticates the administrator and enforces production App Check on
 * every call. No browser-provided cursor controls document selection or counts.
 */
export async function exportSelectedProposals({ db, actorUid, actorName, input, now = Timestamp.now() }) {
  if (typeof actorUid !== "string" || !actorUid) fail("unauthenticated", "Authentication required.");
  const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const continuation = data.exportId != null;
  let exportId, page, scope = null;
  if (continuation) {
    if (typeof data.exportId !== "string" || !/^[a-f0-9]{64}$/.test(data.exportId) || !Number.isSafeInteger(data.page) || data.page < 1) {
      fail("invalid-argument", "Invalid export continuation.");
    }
    if (["proposalId", "startDate", "endDate", "acceptance", "requestId"].some((key) => data[key] != null)) {
      fail("invalid-argument", "An export continuation cannot change the selected scope.");
    }
    exportId = data.exportId;
    page = data.page;
  } else {
    // Stale clients interpret `document` as a complete extract. Require an
    // explicit protocol opt-in before returning any partial document or audit.
    if (data.protocolVersion !== 1) fail("failed-precondition", "Refresh QC DAO before downloading proposal exports.");
    scope = scopeView(parseExportRequest(data, now));
    if (data.page != null || (data.requestId != null && (typeof data.requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(data.requestId)))) {
      fail("invalid-argument", "Invalid export request reference.");
    }
    const requestId = data.requestId || randomBytes(16).toString("hex");
    exportId = createHash("sha256").update(`${actorUid}\n${requestId}`).digest("hex");
    page = 0;
  }
  const ref = db.collection(EXPORT_SESSION_COLLECTION).doc(exportId);
  const prior = await ref.get();
  if (continuation && !prior.exists) fail("not-found", "This export is no longer available. Start it again.");
  const prepared = !prior.exists ? await initialSession({ db, actorUid, actorName, input: data, now, exportId }) : null;
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    const state = existing.exists ? { ...existing.data() } : prepared;
    if (!state || state.actorUid !== actorUid) fail("permission-denied", "This export belongs to another administrator.");
    if (millis(state.expiresAt) <= millis(now)) fail("failed-precondition", "This export expired. Start it again.");
    if (scope && !sameScope(scope, state.scope)) {
      fail("invalid-argument", "An export request reference cannot be reused for a different scope.");
    }
    if (page === state.lastPage) return JSON.parse(state.lastResponse);
    if (state.done || page !== state.lastPage + 1) {
      fail("failed-precondition", "Consume export pages in order. Start again if a page was lost.");
    }
    const entry = state.manifest[state.index];
    const posting = entry ? (state.metadata || await proposalMetadata(db, tx, entry, state.groupMetadata)) : null;
    const comments = [];
    let afterId = state.afterId;
    let exhausted = !entry || !state.hasCommentsAtStart;
    // Fixed read budget even if every scanned document was created after the export.
    if (!exhausted) {
      let query = db.collection("comments").where("proposalId", "==", entry.proposalId)
        .orderBy(FieldPath.documentId(), "asc").select(...COMMENT_FIELDS).limit(EXPORT_COMMENT_PAGE_SIZE);
      if (afterId) query = query.startAfter(afterId);
      const rows = await tx.get(query);
      let consumed = 0;
      for (const doc of rows.docs) {
        const raw = doc.data() ?? {};
        // Firestore system timestamps, rather than application createdAt, freeze
        // membership. Legacy future/missing/malformed application dates remain.
        // Snapshot system timestamps are absent only in the in-memory test fake.
        if (!createdAfterCutoff(doc.createTime, state.readTime)) {
          const comment = commentView(doc.id, raw);
          const candidate = responseFor(state, page, posting, [...comments, comment], false);
          if (byteSize(candidate) > EXPORT_PAGE_BYTES - 2048) {
            if (!comments.length) fail("resource-exhausted", "One export row is too large to download safely. Contact an administrator.");
            break;
          }
          comments.push(comment);
        }
        afterId = doc.id;
        consumed++;
      }
      exhausted = consumed === rows.size && rows.size < EXPORT_COMMENT_PAGE_SIZE;
    }
    const done = exhausted && (!entry || state.index + 1 === state.manifest.length);
    // Empty scans are transport progress, not zero-comment CSV rows. An empty
    // proposal is emitted once, only after its entire selected discussion ends.
    const emptyProposal = exhausted && state.proposalCommentCount === 0 && comments.length === 0;
    const response = responseFor(state, page, posting, comments, done, emptyProposal);
    // Reserve/check bytes again for terminal audit ID and counters.
    if (byteSize(response) > EXPORT_PAGE_BYTES) fail("resource-exhausted", "The export metadata is too large to download safely.");
    state.commentCount += comments.length;
    state.proposalCommentCount = exhausted ? 0 : state.proposalCommentCount + comments.length;
    state.lastPage = page;
    state.lastResponse = JSON.stringify(response);
    state.done = done;
    state.index += exhausted && entry ? 1 : 0;
    state.afterId = exhausted ? null : afterId;
    state.metadata = exhausted ? null : posting;
    state.groupMetadata = exhausted && entry && state.manifest[state.index]?.postingIndex === entry.postingIndex
      ? { ...posting, proposals: [] } : null;
    if (byteSize(state) > EXPORT_SESSION_BYTES) fail("resource-exhausted", "The export state is too large. Choose one proposal instead.");
    // A completed audit and the exact final retry response commit together.
    if (done) tx.set(db.collection("audits").doc(exportId), completedAudit(state, now));
    tx.set(ref, state);
    return response;
  });
}
