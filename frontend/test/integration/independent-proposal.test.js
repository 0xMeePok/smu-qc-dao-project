import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { ROLES } from "../../src/config/roles.js";
import { evaluateRouteAccess } from "../../src/config/routes.js";
import {
  INDEPENDENT_PROPOSAL_HASH_SCHEME,
  INDEPENDENT_PROPOSAL_KIND,
  independentListingWindowOpen,
  isIndependentProposal,
} from "../../src/config/proposal.js";
import { OPPORTUNITY_KIND } from "../../src/config/auditRegistry.js";
import { validateIndependentProposal } from "../../src/lib/proposalValidation.js";
import {
  buildIndependentProposalDocument,
  proposalAuthorRoute,
  PROPOSAL_STATUS_DRAFT,
} from "../../src/lib/proposals.js";
import {
  filterProposalRows,
  isIndependentQueueRow,
  sortProposalRows,
} from "../../src/lib/proposalQueues.js";
import { proposalMatchingLocked } from "../../src/lib/matching.js";
import { ROLE_ADMIN, ROLE_EVALUATOR, ROLE_USER, capabilitiesForAccessLevel } from "../../src/lib/roles.js";
import { memoryDb } from "../../../firebase/functions/test/memoryDb.mjs";
import { createComment } from "../../../firebase/functions/comments.js";
import { canReadContent, listReportableComments } from "../../../firebase/functions/moderation.js";
import { isPublishableIndependentProposal } from "../../../firebase/functions/publicationValidation.js";
import { requireProposalPublicationFundingPolicy } from "../../../firebase/functions/proposalPublicationPolicy.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";

/** Independent listing publish, browse, amend, discuss, and mixed author queue. */

const require = createRequire(new URL("../../../firebase/functions/package.json", import.meta.url));
const { Timestamp } = require("firebase-admin/firestore");

const RESEARCHER = `0x${"a".repeat(40)}`;
const VISITOR = `0x${"b".repeat(40)}`;
const NOW = new Date("2026-09-30T09:00:00.000Z");
const FUTURE = new Date("2099-12-29T09:00:00.000Z");
const SOONER = new Date("2026-10-15T00:00:00.000Z");
const LATER = new Date("2026-12-01T00:00:00.000Z");
const CLOCK = Timestamp.fromDate(NOW);

function completeForm(overrides = {}) {
  return {
    title: "Hybrid annealer for last-mile routing",
    summary: "A quantum-adjacent routing approach for independent discovery.",
    methodology: "Hybrid annealing with a classical fallback path.",
    addressedProblems: "Last-mile logistics under demand spikes.",
    team: "Two researchers with prior escrow deliveries.",
    category: "quantum-adjacent",
    maturity: "pilot",
    amount: "990",
    currency: "USDT",
    expiryDays: 90,
    ...overrides,
  };
}

function signedIn(address, role = ROLE_USER) {
  return { isSignedIn: true, address, profile: { role, fullName: "Test member" } };
}

/** Mirrors AuthContext: capabilities come from the Firestore access level. */
function deriveAuthState(session) {
  if (!session?.isSignedIn || !session?.profile) return { user: null, isAuthenticated: false };
  return {
    user: { id: session.address, roles: capabilitiesForAccessLevel(session.profile.role) },
    isAuthenticated: true,
  };
}

/** Client timestamps are stripped before attestPublication marks an independent proof. */
function attestContent(record, recordId) {
  const next = { ...record, id: recordId };
  const { id, createdAt, updatedAt, audit, ...content } = next;
  return content;
}

/**
 * Mirrors CreateIndependentProposalPage submit for a first publish: RouteGuard,
 * form validation, document build, funding policy, attest content, audit prep,
 * then the post-submit author route.
 */
function simulateIndependentPublish({ session, form, proposalId, expiresAt = FUTURE }) {
  const auth = deriveAuthState(session);
  const route = evaluateRouteAccess("create-proposal", auth.user);
  if (!route.allowed) return { blocked: "route", route };
  const errors = validateIndependentProposal(form);
  if (Object.keys(errors).length) return { blocked: "validation", errors, route };
  const built = buildIndependentProposalDocument({
    researcherId: session.address,
    form,
    expiresAt,
  });
  requireProposalPublicationFundingPolicy(built);
  const content = attestContent(built, proposalId);
  return {
    blocked: null,
    route,
    built,
    content,
    publishable: isPublishableIndependentProposal(content, { uid: session.address.toLowerCase() }),
    prepared: prepareStoredProposal({ ...built, id: proposalId }),
    nextRoute: proposalAuthorRoute({ ...built, id: proposalId, status: "submitted" }),
  };
}

const INDEPENDENT_CORRECTION_KEYS = [
  "title", "summary", "methodology", "addressedProblems", "team",
  "category", "maturity", "amount", "audit", "updatedAt",
];

/** Mirrors updateIndependentProposal's content-only write after an edit attest. */
function correctionWrite(built, audit) {
  return {
    title: built.title,
    summary: built.summary,
    methodology: built.methodology,
    addressedProblems: built.addressedProblems,
    team: built.team,
    category: built.category,
    maturity: built.maturity,
    amount: built.amount,
    audit: audit ? { ...audit } : undefined,
    updatedAt: "server",
  };
}

/**
 * Mirrors CreateIndependentProposalPage edit submit: window + matching gates,
 * frozen escrow copy, attest policy on the merged record, content-only patch.
 */
function simulateIndependentCorrection({ record, form, now = NOW, audit = { status: "pending" } }) {
  const errors = validateIndependentProposal(form, { requireFundingPlan: false });
  if (Object.keys(errors).length) return { blocked: "validation", errors };
  if (!independentListingWindowOpen(record, now) && record.status === "submitted") {
    return { blocked: "window" };
  }
  if (proposalMatchingLocked(record)) return { blocked: "funding" };
  const built = buildIndependentProposalDocument({
    researcherId: record.researcherId,
    form: {
      ...form,
      currency: record.currency,
      immutableFundingTerms: form.immutableFundingTerms || record.fundingTerms,
      freezeFundingTerms: true,
    },
    expiresAt: record.expiresAt,
  });
  const attestRecord = {
    ...record,
    ...built,
    fundingTerms: record.fundingTerms ?? built.fundingTerms,
  };
  requireProposalPublicationFundingPolicy(attestRecord);
  const write = correctionWrite(built, audit);
  return {
    blocked: null,
    built,
    attestRecord,
    write,
    writeKeys: Object.keys(write),
    prepared: prepareStoredProposal({ ...attestRecord, id: record.id }),
  };
}

/**
 * Mirrors ProposalDetailPage + RouteGuard for a published listing: catalog vs
 * publish routes, author amend, visitor back-link, discussion, escrow lock.
 */
function listingSurface(proposal, session, { escrowState, now = NOW } = {}) {
  const { user } = deriveAuthState(session);
  const independent = isIndependentProposal(proposal);
  const owns = Boolean(user?.id && proposal.researcherId === user.id.toLowerCase());
  const listingOpen = !independent || independentListingWindowOpen(proposal, now);
  const locked = !listingOpen || (proposal.fundingTerms
    ? (independent ? escrowState?.totalDeposited > 0n : !escrowState || escrowState.totalDeposited > 0n)
    : proposalMatchingLocked(proposal)
      || ["awaiting_confirmation", "confirmed", "invalidated"].includes(proposal.problemMatching?.status));
  const sponsors = Boolean(user?.id && proposal.postingOwnerId === user.id.toLowerCase());
  return {
    solutions: evaluateRouteAccess("solutions", user),
    createProposal: evaluateRouteAccess("create-proposal", user),
    listingOpen,
    locked,
    canEdit: owns && !locked && proposal.status === "submitted",
    canWithdraw: owns && !locked && ["submitted", "under_review"].includes(proposal.status),
    backRoute: owns ? "proposals" : independent ? "solutions" : sponsors ? "my-problems" : `posting/${proposal.problemId}`,
    editRoute: independent ? `create-proposal/${proposal.id}` : `edit-proposal/${proposal.id}`,
    discussionOpen: independent ? listingOpen : true,
    allowRecommendations: !independent,
  };
}

/** Mirrors listIndependentListings without using memoryDb's broken `>` operator. */
function catalogListings(records, now = NOW) {
  return records
    .filter((row) => row.proposalKind === INDEPENDENT_PROPOSAL_KIND
      && row.status === "submitted"
      && !["hidden", "removed"].includes(row.moderationStatus)
      && independentListingWindowOpen(row, now))
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
    .map((row) => ({
      id: row.id,
      title: row.title ?? "",
      summary: String(row.summary ?? "").slice(0, 400),
      category: row.category ?? "",
      maturity: row.maturity ?? "",
      amount: row.amount ?? 0,
      currency: row.currency ?? "",
      expiresAt: row.expiresAt,
      researcherId: row.researcherId ?? "",
      status: row.status ?? "",
    }));
}

/** Mirrors ProposalTracker: drop drafts, offer Edit only on live independent rows. */
function trackerView(items, { status = "all", sort = "closing" } = {}) {
  const rows = (items ?? []).filter((item) => item.status !== PROPOSAL_STATUS_DRAFT);
  const visible = sortProposalRows(filterProposalRows(rows, status), sort);
  return visible.map((item) => {
    const independent = isIndependentQueueRow(item);
    return {
      id: item.id,
      independent,
      editRoute: independent && item.status === "submitted" ? `create-proposal/${item.id}` : null,
      viewRoute: `proposal/${item.id}`,
      resumeRoute: proposalAuthorRoute(item),
    };
  });
}

function discussionPolicy(proposal, { user, now = NOW } = {}) {
  const independent = isIndependentProposal(proposal);
  const listingOpen = !independent || independentListingWindowOpen(proposal, now);
  const showDiscussion = proposal.status !== "draft";
  return {
    showDiscussion,
    discussionOpen: independent ? listingOpen : true,
    allowRecommendations: !independent,
    canCompose: Boolean(user?.id) && showDiscussion && listingOpen,
  };
}

function listingFixture(extra = {}) {
  return memoryDb({
    [`users/${RESEARCHER}`]: { role: 0, fullName: "Author" },
    [`users/${VISITOR}`]: { role: 0, fullName: "Visitor" },
    "users/evaluator": { role: 2, fullName: "Assigned evaluator" },
    [`publicProfiles/${RESEARCHER}`]: { fullName: "Author" },
    [`publicProfiles/${VISITOR}`]: { fullName: "Visitor" },
    "publicProfiles/evaluator": { fullName: "Assigned evaluator" },
    "proposals/live": {
      researcherId: RESEARCHER,
      proposalKind: INDEPENDENT_PROPOSAL_KIND,
      title: "Live independent listing",
      summary: "A published listing with no parent posting.",
      status: "submitted",
      expiresAt: Timestamp.fromDate(FUTURE),
      createdAt: CLOCK,
    },
    "proposals/closed": {
      researcherId: RESEARCHER,
      proposalKind: INDEPENDENT_PROPOSAL_KIND,
      title: "Expired independent listing",
      summary: "Past its own listing window.",
      status: "submitted",
      expiresAt: Timestamp.fromMillis(CLOCK.toMillis() - 1),
      createdAt: CLOCK,
    },
    ...extra,
  });
}

describe("independent listing integration", () => {
  it("[FIT-RPF-065] should publish an independent listing through route, attest, and audit", () => {
    const guest = simulateIndependentPublish({
      session: { isSignedIn: false },
      form: completeForm(),
      proposalId: "listing-new",
    });
    assert.equal(guest.blocked, "route");
    assert.equal(guest.route.action, "REDIRECT_LOGIN");

    const admin = simulateIndependentPublish({
      session: signedIn(RESEARCHER, ROLE_ADMIN),
      form: completeForm(),
      proposalId: "listing-new",
    });
    assert.equal(admin.blocked, "route");
    assert.equal(admin.route.action, "DENY_403");

    const incomplete = simulateIndependentPublish({
      session: signedIn(RESEARCHER),
      form: completeForm({ title: "", methodology: "" }),
      proposalId: "listing-new",
    });
    assert.equal(incomplete.blocked, "validation");
    assert.ok(incomplete.errors.title);
    assert.ok(incomplete.errors.methodology);

    const published = simulateIndependentPublish({
      session: signedIn(RESEARCHER),
      form: completeForm(),
      proposalId: "listing-new",
    });
    assert.equal(published.blocked, null);
    assert.equal(published.route.action, "RENDER");
    assert.equal(isIndependentProposal(published.built), true);
    assert.ok(!("problemId" in published.built));
    assert.ok(!("postingOwnerId" in published.built));
    assert.ok(published.built.fundingTerms);
    assert.equal(
      isPublishableIndependentProposal(published.built, { uid: RESEARCHER }),
      false,
    );
    assert.equal(published.publishable, true);
    assert.equal(published.prepared.hashScheme, INDEPENDENT_PROPOSAL_HASH_SCHEME);
    assert.equal(published.prepared.args[1], OPPORTUNITY_KIND.FUNDING_REQUEST);
    assert.equal(published.nextRoute, "proposal/listing-new");
  });

  it("[FIT-RPF-066] should split catalog, publish, and author amend rights by actor", () => {
    const listing = {
      id: "listing-1",
      researcherId: RESEARCHER,
      proposalKind: INDEPENDENT_PROPOSAL_KIND,
      status: "submitted",
      expiresAt: FUTURE,
      fundingTerms: { trancheBps: [5000, 5000] },
    };
    const guest = listingSurface(listing, { isSignedIn: false });
    assert.equal(guest.solutions.action, "REDIRECT_LOGIN");
    assert.equal(guest.createProposal.action, "REDIRECT_LOGIN");
    assert.equal(guest.canEdit, false);

    const admin = listingSurface(listing, signedIn(VISITOR, ROLE_ADMIN));
    assert.equal(admin.solutions.action, "DENY_403");
    assert.equal(admin.createProposal.action, "DENY_403");

    const visitor = listingSurface(listing, signedIn(VISITOR));
    assert.equal(visitor.solutions.action, "RENDER");
    assert.equal(visitor.createProposal.action, "RENDER");
    assert.equal(visitor.canEdit, false);
    assert.equal(visitor.canWithdraw, false);
    assert.equal(visitor.backRoute, "solutions");
    assert.equal(visitor.discussionOpen, true);
    assert.equal(visitor.allowRecommendations, false);

    const author = listingSurface(listing, signedIn(RESEARCHER));
    assert.equal(author.canEdit, true);
    assert.equal(author.canWithdraw, true);
    assert.equal(author.backRoute, "proposals");
    assert.equal(author.editRoute, "create-proposal/listing-1");
    assert.equal(author.locked, false);

    const deposited = listingSurface(listing, signedIn(RESEARCHER), { escrowState: { totalDeposited: 1n } });
    assert.equal(deposited.canEdit, false);
    assert.equal(deposited.canWithdraw, false);

    const expired = listingSurface({ ...listing, expiresAt: new Date("2020-01-01T00:00:00.000Z") }, signedIn(RESEARCHER));
    assert.equal(expired.listingOpen, false);
    assert.equal(expired.canEdit, false);
    assert.equal(expired.discussionOpen, false);

    const matched = listingSurface(
      { ...listing, fundingTerms: undefined, matching: { evaluationComplete: true } },
      signedIn(RESEARCHER),
    );
    assert.equal(matched.canEdit, false);
  });

  it("[FIT-RPF-067] should correct listing content while freezing escrow and parent-less attest", () => {
    const storedTerms = { trancheBps: [5000, 5000], note: "not a canonical six-field map" };
    const record = {
      id: "listing-1",
      researcherId: RESEARCHER,
      proposalKind: INDEPENDENT_PROPOSAL_KIND,
      status: "submitted",
      currency: "USDT",
      expiresAt: FUTURE,
      fundingTerms: storedTerms,
      title: "Original listing title",
    };
    const form = completeForm({ title: "Revised independent listing title", amount: "1250" });

    const closed = simulateIndependentCorrection({
      record: { ...record, expiresAt: new Date("2020-01-01T00:00:00.000Z") },
      form,
    });
    assert.equal(closed.blocked, "window");

    const funded = simulateIndependentCorrection({
      record: { ...record, matching: { fundedAmount: 10 } },
      form,
    });
    assert.equal(funded.blocked, "funding");

    const saved = simulateIndependentCorrection({ record, form });
    assert.equal(saved.blocked, null);
    assert.equal(saved.built.title, "Revised independent listing title");
    assert.equal(saved.built.amount, 1250);
    assert.equal(saved.built.fundingTerms, storedTerms);
    assert.equal(saved.attestRecord.fundingTerms, storedTerms);
    assert.equal(saved.attestRecord.currency, "USDT");
    assert.deepEqual(saved.writeKeys, INDEPENDENT_CORRECTION_KEYS);
    assert.ok(!saved.writeKeys.includes("currency"));
    assert.ok(!saved.writeKeys.includes("expiresAt"));
    assert.ok(!saved.writeKeys.includes("fundingTerms"));
    assert.ok(!saved.writeKeys.includes("proposalKind"));
    assert.equal(saved.write.currency, undefined);
    assert.equal(saved.prepared.args[1], OPPORTUNITY_KIND.FUNDING_REQUEST);
    assert.doesNotThrow(() => requireProposalPublicationFundingPolicy(saved.attestRecord));
    assert.throws(
      () => requireProposalPublicationFundingPolicy({ status: "submitted", fundingTerms: storedTerms }),
      /six contract fields/,
    );
    assert.throws(
      () => requireProposalPublicationFundingPolicy({ status: "submitted" }),
      /Escrow funding terms are required/,
    );
  });

  it("[FIT-RPF-068] should discuss an independent listing without a parent or recommendations", async () => {
    const db = listingFixture();
    const memberComment = await createComment({
      db,
      uid: VISITOR,
      proposalId: "live",
      body: "Could this annealer cover refrigerated last-mile routes?",
      now: CLOCK,
    });
    assert.equal(memberComment.proposalId, "live");
    assert.ok(memberComment.problemId == null);
    assert.equal(memberComment.recommendation, null);
    assert.equal(memberComment.qualifying, false);
    const stored = db.records.get(`comments/${memberComment.id}`);
    assert.ok(!("problemId" in stored));
    assert.notEqual(db.records.get("proposals/live").matching?.evaluationComplete, true);

    await assert.rejects(
      () => createComment({
        db,
        uid: "evaluator",
        proposalId: "live",
        body: "Recommend this listing.",
        recommendation: "recommend",
        now: CLOCK,
      }),
      { code: "invalid-argument", message: "Recommendations are not used on independent listings." },
    );

    await assert.rejects(
      () => createComment({
        db,
        uid: VISITOR,
        proposalId: "closed",
        body: "Too late to comment on an expired listing.",
        now: CLOCK,
      }),
      { code: "failed-precondition", message: "The listing window has closed. Comments can no longer be added." },
    );

    const listed = await listReportableComments({ db, uid: VISITOR, proposalId: "live" });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, memberComment.id);
    assert.equal(listed.items[0].problemId, null);

    const live = (await db.collection("proposals").doc("live").get()).data();
    const closed = (await db.collection("proposals").doc("closed").get()).data();
    assert.equal(await db.runTransaction((tx) => canReadContent(tx, db, "proposal", live, VISITOR, { role: 0 })), true);
    assert.equal(discussionPolicy(live, { user: { id: VISITOR }, now: NOW }).allowRecommendations, false);
    assert.equal(discussionPolicy(live, { user: { id: VISITOR }, now: NOW }).canCompose, true);
    assert.equal(discussionPolicy(closed, { user: { id: VISITOR }, now: NOW }).canCompose, false);
    assert.equal(discussionPolicy(closed, { user: { id: VISITOR }, now: NOW }).discussionOpen, false);
  });

  it("[FIT-RPF-069] should mix independent and attached queue rows without sharing parent expiry", () => {
    const items = [
      {
        id: "indie-draft",
        proposalKind: INDEPENDENT_PROPOSAL_KIND,
        status: "draft",
        title: "Draft listing",
        expiresAt: LATER.toISOString(),
      },
      {
        id: "attached-draft",
        problemId: "problem-1",
        status: "draft",
        title: "Draft attached proposal",
        posting: { title: "Parent opportunity", expiresAt: SOONER.toISOString() },
      },
      {
        id: "indie-live",
        proposalKind: INDEPENDENT_PROPOSAL_KIND,
        status: "submitted",
        workflowStatus: "submitted",
        title: "Live listing",
        summary: "Published independent listing",
        category: "hybrid",
        maturity: "pilot",
        amount: 990,
        currency: "USDT",
        researcherId: RESEARCHER,
        expiresAt: SOONER.toISOString(),
      },
      {
        id: "attached-live",
        problemId: "problem-1",
        status: "submitted",
        workflowStatus: "submitted",
        title: "Attached proposal",
        posting: { title: "Parent opportunity", status: "submitted", expiresAt: LATER.toISOString() },
      },
      {
        id: "indie-withdrawn",
        proposalKind: INDEPENDENT_PROPOSAL_KIND,
        status: "withdrawn",
        workflowStatus: "withdrawn",
        title: "Withdrawn listing",
        expiresAt: SOONER.toISOString(),
      },
      {
        id: "indie-expired",
        proposalKind: INDEPENDENT_PROPOSAL_KIND,
        status: "submitted",
        workflowStatus: "submitted",
        title: "Expired listing",
        expiresAt: new Date("2020-01-01T00:00:00.000Z").toISOString(),
      },
      {
        id: "indie-hidden",
        proposalKind: INDEPENDENT_PROPOSAL_KIND,
        status: "submitted",
        moderationStatus: "hidden",
        expiresAt: LATER.toISOString(),
      },
    ];

    const queue = trackerView(items);
    assert.deepEqual(queue.map((row) => row.id), [
      "indie-expired", "indie-live", "indie-withdrawn", "attached-live", "indie-hidden",
    ]);
    assert.equal(queue.find((row) => row.id === "indie-live").editRoute, "create-proposal/indie-live");
    assert.equal(queue.find((row) => row.id === "indie-withdrawn").editRoute, null);
    assert.equal(queue.find((row) => row.id === "attached-live").editRoute, null);
    assert.equal(queue.find((row) => row.id === "indie-live").independent, true);
    assert.equal(queue.find((row) => row.id === "attached-live").independent, false);
    assert.ok(!queue.some((row) => row.id === "indie-draft" || row.id === "attached-draft"));

    assert.equal(proposalAuthorRoute(items[0]), "create-proposal/indie-draft");
    assert.equal(proposalAuthorRoute(items[1]), "edit-proposal/attached-draft");
    assert.equal(proposalAuthorRoute(items[2]), "proposal/indie-live");

    const catalog = catalogListings(items, NOW);
    assert.deepEqual(catalog.map((row) => row.id), ["indie-live"]);
    assert.equal(catalog[0].status, "submitted");
    assert.ok(!catalog.some((row) => row.id === "attached-live"));
    assert.ok(!catalog.some((row) => row.id === "indie-expired" || row.id === "indie-withdrawn" || row.id === "indie-hidden"));
  });
});
