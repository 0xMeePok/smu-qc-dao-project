import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { canReadContent } from "./moderation.js";
import { eventLabel, eventWorkflowStatus, workflowStatusLabel } from "./workflowStatus.js";
import {
  ACTOR_ROLE_IDS,
  AUDIT_EVENT_IDS,
  RECOMMENDATION_VALUES,
  VERIFICATION_IDS,
  actorRoleLabel,
  verificationLabel,
} from "./auditTrailCatalog.js";

const SOURCE_CAP = 100;
const PAGE_SIZE = 25;
const ENTITY_TYPES = new Set(["problem", "proposal"]);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_ID = /^[\w.:-]{1,200}$/;
const BLOCKED = new Set(["hidden", "removed"]);
const FUNDING_ACTORS = new Set(["funding_contributed", "funding_target_reached"]);
const RECOMMENDATIONS = new Set(RECOMMENDATION_VALUES);

const MATCH_TYPES = Object.freeze({
  owner_selected: ["selection", "owner_approval"],
  owner_confirmed: ["owner_approval"],
  creator_confirmed: ["solution_owner_approval"],
  creator_declined: ["solution_owner_decline"],
  owner_declined: ["owner_decline"],
  match_confirmed: ["decision_recorded"],
  posting_invalidated: ["invalidation"],
  confirmation_expired: ["invalidation"],
  admin_force_expired: ["invalidation"],
  posting_expired: ["expiry"],
  funding_contributed: ["funding_status"],
  funding_target_reached: ["funding_status"],
  moderation_refunded: ["funding_status"],
  posting_reopened: ["funding_status"],
});

const ROLE_ALIASES = Object.freeze({
  problem_owner: "problem_owner",
  owner: "problem_owner",
  proposal_creator: "proposal_creator",
  researcher: "proposal_creator",
  solution_owner: "proposal_creator",
  evaluator: "evaluator",
  funder: "funder",
  admin: "admin",
  administrator: "admin",
  member: "member",
  user: "member",
  system: "system",
});

const EXPIRY_LABELS = Object.freeze({
  funding_requirement_not_met: "Funding requirement was not met",
  evaluation_not_completed: "Evaluation was not completed",
  no_solution_selected: "No solution was selected",
});

const fail = (code, message) => { throw new HttpsError(code, message); };
const iso = (value) => value?.toDate?.().toISOString?.()
  ?? (value instanceof Date ? value.toISOString() : (typeof value === "string" ? value : null));
const millis = (value) => Date.parse(value || "") || 0;

function roleOf(value) {
  return ROLE_ALIASES[String(value || "").trim().toLowerCase()] || "member";
}

function shortActor(actorId, role) {
  if (!actorId || actorId === "system") return "System";
  if (/^0x[0-9a-f]{40}$/i.test(actorId)) return `${actorId.slice(0, 6)}…${actorId.slice(-4)}`;
  return actorRoleLabel(role);
}

function dayBound(value, end) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !DAY.test(value)) fail("invalid-argument", "Use a YYYY-MM-DD date.");
  const [year, month, day] = value.split("-").map(Number);
  const utc = Date.UTC(year, month - 1, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
  const parsed = new Date(utc);
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    fail("invalid-argument", "Use a real calendar date.");
  }
  return Timestamp.fromMillis(utc);
}

function parseFilters(input) {
  const data = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const entityType = data.entityType == null || data.entityType === "" ? "" : String(data.entityType);
  const entityId = data.entityId == null || data.entityId === "" ? "" : String(data.entityId);
  if ((entityType === "") !== (entityId === "")) fail("invalid-argument", "Choose a record to view its audit trail.");
  if (entityType && !ENTITY_TYPES.has(entityType)) fail("invalid-argument", "Choose a problem or a proposal.");
  if (entityId && !/^[\w-]{1,128}$/.test(entityId)) fail("invalid-argument", "That record reference is not valid.");
  const eventTypes = Array.isArray(data.eventTypes) ? data.eventTypes : [];
  if (eventTypes.length > AUDIT_EVENT_IDS.size || eventTypes.some((type) => !AUDIT_EVENT_IDS.has(type))) {
    fail("invalid-argument", "Choose a known event type.");
  }
  const actorRole = data.actorRole == null || data.actorRole === "" ? "" : String(data.actorRole);
  if (actorRole && !ACTOR_ROLE_IDS.has(actorRole)) fail("invalid-argument", "Choose a known actor role.");
  const verification = data.verification == null || data.verification === "" ? "" : String(data.verification);
  if (verification && !VERIFICATION_IDS.has(verification)) fail("invalid-argument", "Choose a known verification status.");
  const start = dayBound(data.startDate, false);
  const end = dayBound(data.endDate, true);
  if (start && end && start.toMillis() > end.toMillis()) fail("invalid-argument", "The start date is after the end date.");
  const related = typeof data.related === "string" ? data.related.trim().slice(0, 160) : "";
  if (data.related != null && data.related !== "" && typeof data.related !== "string") {
    fail("invalid-argument", "Related record must be text.");
  }
  let cursor = null;
  if (data.cursor != null && data.cursor !== "") {
    const at = data.cursor.at;
    const id = data.cursor.id;
    if (typeof at !== "string" || Number.isNaN(Date.parse(at)) || typeof id !== "string" || !CURSOR_ID.test(id)) {
      fail("invalid-argument", "Invalid page cursor.");
    }
    cursor = { at: new Date(at).toISOString(), id };
  }
  return {
    entityType, entityId, eventTypes: [...new Set(eventTypes)], actorRole, verification, start, end, related,
    cursor,
  };
}

function publish(fields) {
  return {
    id: fields.id,
    eventType: fields.eventType,
    types: fields.types,
    label: fields.label,
    description: fields.description,
    at: fields.at,
    actorRole: fields.actorRole,
    actorLabel: fields.actorLabel,
    entityType: fields.entityType,
    entityId: fields.entityId,
    entityLabel: fields.entityLabel,
    problemId: fields.problemId || null,
    proposalId: fields.proposalId || null,
    verification: fields.verification,
    verificationLabel: verificationLabel(fields.verification),
    offChain: fields.verification === "off_chain",
    receiptKind: fields.receiptKind || null,
    commentId: fields.commentId || null,
    recommendation: fields.recommendation || null,
    recommendationLabel: fields.recommendationLabel || null,
    badge: fields.badge || null,
    workflowStatus: fields.workflowStatus || null,
  };
}

function proposalVerification(audit) {
  if (audit?.status === "failed") return "failed";
  if (audit?.status === "confirmed" && audit.transactionHash) return "anchored";
  return "pending";
}

function within(at, start, end) {
  const atMs = millis(at);
  if (!atMs) return false;
  if (start && atMs < start.toMillis()) return false;
  if (end && atMs > end.toMillis()) return false;
  return true;
}

async function rows(query) {
  const snap = await query.get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

function recent(db, name, timeField, { equals = [], start, end } = {}) {
  let query = db.collection(name);
  for (const [field, value] of equals) query = query.where(field, "==", value);
  if (start) query = query.where(timeField, ">=", start);
  if (end) query = query.where(timeField, "<=", end);
  return query.orderBy(timeField, "desc").limit(SOURCE_CAP);
}

function matchingEvent(row, { isAdmin, titles }) {
  const types = MATCH_TYPES[row.type];
  if (!types) return null;
  const at = iso(row.createdAt);
  if (!at) return null;
  const redact = !isAdmin && FUNDING_ACTORS.has(row.type);
  const role = roleOf(redact ? "member" : row.actorRole);
  const name = eventLabel(row.type);
  return publish({
    id: `match_${row.id}`,
    eventType: types[0],
    types,
    label: name,
    description: `${name}. Recorded off-chain by the server. No blockchain transaction is required for this step.`,
    at,
    actorRole: role,
    actorLabel: redact ? "Private contributor" : shortActor(row.actorId, role),
    entityType: row.proposalId ? "proposal" : "problem",
    entityId: row.proposalId || row.problemId,
    entityLabel: titles.proposal.get(row.proposalId) || titles.problem.get(row.problemId) || "Workflow record",
    problemId: row.problemId,
    proposalId: row.proposalId,
    verification: "off_chain",
    workflowStatus: eventWorkflowStatus(row.type),
  });
}

function recommendationEvent(row) {
  if (!RECOMMENDATIONS.has(row.recommendation) || row.parentId || row.deletedAt) return null;
  const at = iso(row.createdAt);
  if (!at) return null;
  const recommendationLabel = workflowStatusLabel(row.recommendation);
  return publish({
    id: `comment_${row.id}`,
    eventType: "evaluator_recommendation",
    types: ["evaluator_recommendation"],
    label: "Evaluator recommendation submitted",
    description: `Evaluator recommendation: ${recommendationLabel}. Stored as a Firestore comment. This is not verified on-chain.`,
    at,
    actorRole: "evaluator",
    actorLabel: "Evaluator",
    entityType: "proposal",
    entityId: row.proposalId,
    entityLabel: "Proposal",
    problemId: row.problemId,
    proposalId: row.proposalId,
    verification: "off_chain",
    commentId: row.id,
    recommendation: row.recommendation,
    recommendationLabel,
    badge: "evaluator",
  });
}

function submissionEvent(row) {
  if (!row?.id || row.status === "draft") return null;
  const at = iso(row.createdAt);
  if (!at) return null;
  const verification = proposalVerification(row.audit);
  const title = row.title || "Proposal";
  return publish({
    id: `proposal_${row.id}`,
    eventType: "proposal_submitted",
    types: ["proposal_submitted"],
    label: "Proposal submitted",
    description: verification === "anchored"
      ? `“${title}” was submitted. The anchored version can be checked against AuditRegistry.`
      : verification === "failed"
        ? `“${title}” was submitted. Anchoring failed, so this record is not verified on-chain.`
        : `“${title}” was submitted. On-chain verification is still pending.`,
    at,
    actorRole: "proposal_creator",
    actorLabel: shortActor(row.researcherId, "proposal_creator"),
    entityType: "proposal",
    entityId: row.id,
    entityLabel: title,
    problemId: row.problemId,
    proposalId: row.id,
    verification,
    receiptKind: "proposal",
    workflowStatus: "submitted",
  });
}

function moderationEvent(row, titles) {
  const at = iso(row.createdAt);
  if (!at || !row.contentId) return null;
  const action = row.action === "hide" ? "hidden" : row.action === "remove" ? "removed" : row.action === "restore" ? "restored" : "updated";
  const kind = row.contentType === "proposal" ? "proposal" : row.contentType === "comment" ? "comment" : "problem";
  const readiness = row.evaluationReadiness;
  const readinessText = readiness
    ? ` Evaluator-feedback readiness changed from ${readiness.before ? "ready" : "not ready"} to ${readiness.after ? "ready" : "not ready"}. The evaluator badge and recommendation were left unchanged.`
    : "";
  const voidHash = row.escrowVoid?.transactionHash || row.escrowVoids && Object.values(row.escrowVoids).find((item) => item?.transactionHash)?.transactionHash;
  const voidText = voidHash
    ? ` Escrow void ${voidHash} opened claimable refunds of the unpaid balance.`
    : "";
  return publish({
    id: `moderation_${row.id}`,
    eventType: "moderation",
    types: ["moderation"],
    label: "Moderation action",
    description: `A moderator ${action} this ${kind}. The decision is stored in Firestore and is eligible to anchor.${readinessText}${voidText}`,
    at,
    actorRole: "admin",
    actorLabel: "Administrator",
    entityType: kind === "comment" ? "proposal" : kind,
    entityId: row.contentId,
    entityLabel: titles.proposal.get(row.contentId) || titles.problem.get(row.contentId) || kind,
    problemId: kind === "problem" ? row.contentId : null,
    proposalId: kind === "proposal" ? row.contentId : null,
    verification: "off_chain",
  });
}

function auditEvent(row, { isAdmin }) {
  const at = iso(row.timestamp) || iso(row.createdAt);
  if (!at) return null;
  if (row.type === "opportunity_expired") {
    const reason = EXPIRY_LABELS[row.reason] || "Expiry requirements were not completed";
    return publish({
      id: `audit_${row.id}`,
      eventType: "expiry",
      types: ["expiry"],
      label: row.action === "OPPORTUNITY_FORCE_EXPIRED" ? "Opportunity force-expired" : "Opportunity expired",
      description: `${reason}. Recorded by the server, not as a blockchain transaction.`,
      at,
      actorRole: row.actor === "system" || row.source === "scheduled" ? "system" : "admin",
      actorLabel: row.actorName || (row.source === "scheduled" ? "System" : "Administrator"),
      entityType: "problem",
      entityId: row.targetId || row.problemId,
      entityLabel: row.targetName || "Opportunity",
      problemId: row.targetId || row.problemId,
      verification: "off_chain",
      workflowStatus: "expired",
    });
  }
  if (row.type === "escrow") {
    const anchored = Boolean(row.transactionHash);
    const redact = !isAdmin;
    return publish({
      id: `audit_${row.id}`,
      eventType: "funding_status",
      types: ["funding_status"],
      label: "Escrow funding update",
      description: anchored
        ? `Escrow activity for “${row.title || "a proposal"}” is anchored on Arbitrum Sepolia.`
        : `Escrow activity for “${row.title || "a proposal"}” is waiting for an on-chain receipt.`,
      at,
      actorRole: "funder",
      actorLabel: redact ? "Private contributor" : shortActor(row.actor, "funder"),
      entityType: "proposal",
      entityId: row.proposalId || row.targetId,
      entityLabel: row.title || "Proposal",
      problemId: row.problemId,
      proposalId: row.proposalId || row.targetId,
      verification: anchored ? "anchored" : "pending",
      receiptKind: anchored ? "proposal" : null,
    });
  }
  if (!isAdmin || !["role_change", "suspension_change"].includes(row.type)) return null;
  const label = row.type === "suspension_change"
    ? (row.newState ? "Account suspended" : "Account reinstated")
    : "Role changed";
  return publish({
    id: `audit_${row.id}`,
    eventType: "governance",
    types: ["governance"],
    label,
    description: `${label}. Stored in the administrator audit log. This is not an on-chain content anchor.`,
    at,
    actorRole: "admin",
    actorLabel: shortActor(row.actor, "admin"),
    entityType: "problem",
    entityId: row.targetAddress || row.target || row.id,
    entityLabel: row.targetName || "Account",
    verification: "off_chain",
  });
}

function visibleProposal(row, uid, isAdmin) {
  if (!row || row.status === "draft") return false;
  if (isAdmin || row.researcherId === uid || row.postingOwnerId === uid) return true;
  return !BLOCKED.has(row.moderationStatus);
}

async function loadScope(db, uid, profile, filters) {
  const isAdmin = profile.role === 1;
  if (!filters.entityType) {
    if (!isAdmin) fail("permission-denied", "This audit trail is not available.");
    return { isAdmin, problem: null, proposal: null };
  }
  const tx = { get: (ref) => ref.get() };
  if (filters.entityType === "problem") {
    const snap = await db.collection("problems").doc(filters.entityId).get();
    if (!snap.exists) {
      fail(isAdmin ? "not-found" : "permission-denied", isAdmin ? "That record was not found." : "This audit trail is not available.");
    }
    if (!await canReadContent(tx, db, "problem", snap.data(), uid, profile)) {
      fail("permission-denied", "This audit trail is not available.");
    }
    return { isAdmin, problem: { id: snap.id, ...snap.data() }, proposal: null };
  }
  const snap = await db.collection("proposals").doc(filters.entityId).get();
  if (!snap.exists) {
    fail(isAdmin ? "not-found" : "permission-denied", isAdmin ? "That record was not found." : "This audit trail is not available.");
  }
  if (!await canReadContent(tx, db, "proposal", snap.data(), uid, profile)) {
    fail("permission-denied", "This audit trail is not available.");
  }
  let problem = null;
  const problemId = snap.data().problemId;
  if (problemId) {
    const parent = await db.collection("problems").doc(problemId).get();
    if (parent.exists) problem = { id: parent.id, ...parent.data() };
  }
  return { isAdmin, problem, proposal: { id: snap.id, ...snap.data() } };
}

async function collect(db, scope, filters, uid) {
  const { start, end } = filters;
  const jobs = [];
  const track = { truncated: false };
  const run = (query) => jobs.push(rows(query).then((list) => {
    if (list.length >= SOURCE_CAP) track.truncated = true;
    return list;
  }));
  if (scope.proposal) {
    const id = scope.proposal.id;
    run(recent(db, "matchingEvents", "createdAt", { equals: [["proposalId", id]], start, end }));
    run(recent(db, "comments", "createdAt", { equals: [["proposalId", id]], start, end }));
    run(recent(db, "moderationEvents", "createdAt", { equals: [["contentId", id]], start, end }));
    run(recent(db, "audits", "timestamp", { equals: [["proposalId", id]], start, end }));
  } else if (scope.problem) {
    const id = scope.problem.id;
    run(recent(db, "matchingEvents", "createdAt", { equals: [["problemId", id]], start, end }));
    run(recent(db, "comments", "createdAt", { equals: [["problemId", id]], start, end }));
    run(recent(db, "proposals", "createdAt", { equals: [["problemId", id]], start, end }));
    run(recent(db, "moderationEvents", "createdAt", { equals: [["contentId", id]], start, end }));
    run(recent(db, "audits", "timestamp", { equals: [["problemId", id]], start, end }));
    run(recent(db, "audits", "timestamp", { equals: [["targetId", id]], start, end }));
  } else {
    run(recent(db, "matchingEvents", "createdAt", { start, end }));
    run(recent(db, "proposals", "createdAt", { start, end }));
    run(recent(db, "moderationEvents", "createdAt", { start, end }));
    run(recent(db, "audits", "timestamp", { start, end }));
    if (start || end) run(recent(db, "comments", "createdAt", { start, end }));
    else {
      let query = db.collection("comments").where("recommendation", "in", RECOMMENDATION_VALUES);
      query = query.orderBy("createdAt", "desc").limit(SOURCE_CAP);
      jobs.push(rows(query).then((list) => {
        if (list.length >= SOURCE_CAP) track.truncated = true;
        return list;
      }));
    }
  }
  const batches = await Promise.all(jobs);
  const titles = {
    problem: new Map(scope.problem ? [[scope.problem.id, scope.problem.title || "Opportunity"]] : []),
    proposal: new Map(scope.proposal ? [[scope.proposal.id, scope.proposal.title || "Proposal"]] : []),
  };
  const proposalIds = new Set();
  for (const row of batches.flat()) {
    if (row.proposalId) proposalIds.add(row.proposalId);
    if (row.title && row.researcherId && visibleProposal(row, uid, scope.isAdmin)) titles.proposal.set(row.id, row.title);
    if (row.title && row.ownerId && !row.researcherId) titles.problem.set(row.id, row.title);
  }
  const missingTitles = [...proposalIds].filter((id) => id && !titles.proposal.has(id)).slice(0, 40);
  const loadedTitles = await Promise.all(missingTitles.map(async (id) => {
    const snap = await db.collection("proposals").doc(id).get();
    if (!snap.exists) return null;
    const data = snap.data();
    if (!visibleProposal(data, uid, scope.isAdmin)) return null;
    return [id, data.title || "Proposal"];
  }));
  for (const entry of loadedTitles) if (entry) titles.proposal.set(entry[0], entry[1]);
  const events = [];
  const seen = new Set();
  const push = (event) => {
    if (!event || seen.has(event.id) || !within(event.at, start, end)) return;
    seen.add(event.id);
    if (event.entityType === "proposal" && titles.proposal.has(event.entityId)) {
      event.entityLabel = titles.proposal.get(event.entityId);
    }
    events.push(event);
  };
  for (const row of batches.flat()) {
    if (row.type && MATCH_TYPES[row.type]) push(matchingEvent(row, { isAdmin: scope.isAdmin, titles }));
    else if (row.recommendation) {
      const hidden = BLOCKED.has(row.moderationStatus);
      if (!row.deletedAt && (!hidden || scope.isAdmin || row.authorId === uid)) push(recommendationEvent(row));
    } else if (row.researcherId && row.status) {
      if (visibleProposal(row, uid, scope.isAdmin)) push(submissionEvent(row));
    } else if (row.contentType && row.action) push(moderationEvent(row, titles));
    else if (row.type) push(auditEvent(row, { isAdmin: scope.isAdmin }));
  }
  if (scope.proposal && visibleProposal(scope.proposal, uid, scope.isAdmin)) push(submissionEvent(scope.proposal));
  return { events, truncated: track.truncated };
}

function matches(event, filters) {
  if (filters.eventTypes.length && !event.types.some((type) => filters.eventTypes.includes(type))) return false;
  if (filters.actorRole && event.actorRole !== filters.actorRole) return false;
  if (filters.verification && event.verification !== filters.verification) return false;
  if (!filters.related) return true;
  const needle = filters.related.toLowerCase();
  return [event.entityId, event.entityLabel, event.problemId, event.proposalId, event.commentId]
    .some((value) => String(value || "").toLowerCase().includes(needle));
}

function paginate(events, cursor) {
  const sorted = [...events].sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id));
  let start = 0;
  if (cursor) {
    const index = sorted.findIndex((event) => event.at === cursor.at && event.id === cursor.id);
    start = index >= 0 ? index + 1 : 0;
  }
  const items = sorted.slice(start, start + PAGE_SIZE);
  const last = items.at(-1);
  return {
    items,
    count: sorted.length,
    nextCursor: start + PAGE_SIZE < sorted.length && last ? { at: last.at, id: last.id } : null,
  };
}

/** Chronological workflow trail for one readable record, or every record when the caller is an admin. */
export async function readAuditTrail({ db, uid, profile, input }) {
  if (!uid || !profile || profile.suspended) fail("permission-denied", "Complete your active member profile first.");
  const filters = parseFilters(input);
  const scope = await loadScope(db, uid, profile, filters);
  const { events, truncated } = await collect(db, scope, filters, uid);
  const page = paginate(events.filter((event) => matches(event, filters)), filters.cursor);
  return { ...page, truncated };
}
