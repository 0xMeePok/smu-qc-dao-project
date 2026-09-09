import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OPEN_FUNDING_TYPE } from "../../src/config/fundingOpportunity.js";
import { ROLES } from "../../src/config/roles.js";
import { evaluateRouteAccess } from "../../src/config/routes.js";
import { opportunityStatusLabel } from "../../src/config/workflowStatus.js";
import { shortenAddress } from "../../src/lib/chain.js";
import { postingActions } from "../../src/lib/postingActions.js";
import { normaliseOpportunityMetrics } from "../../src/lib/postings.js";
import { ROLE_ADMIN, ROLE_USER, isAdmin } from "../../src/lib/roles.js";

/** QCDAO-54 - view a posting detail page with full metadata and countdown. */

const OWNER = `0x${"a".repeat(40)}`;
const MEMBER = `0x${"b".repeat(40)}`;
const NOW = new Date("2026-09-08T00:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date("2099-01-01T00:00:00Z");

const OPEN_POSTING = {
  id: "posting123",
  ownerId: OWNER,
  organisation: "Meridian Logistics",
  status: "submitted",
  amount: 80000,
  currency: "USDC",
  expiresAt: FUTURE,
  proposalCount: 3,
  fundedAmount: 12000,
  fundingProgressPercent: 15,
};

/**
 * Mirrors AuthContext.jsx: a signed-in participant is multi-role; admin is isolated.
 */
function deriveAuthState(session) {
  if (!session?.isSignedIn || !session?.profile) {
    return { user: null, isAuthenticated: false };
  }
  const admin = isAdmin(session.profile.role);
  const user = {
    id: session.address,
    roles: admin
      ? [ROLES.ADMIN]
      : [ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER],
  };
  return { user, isAuthenticated: true };
}

/** Mirrors PosterIdentity on PostingDetailPage. */
function posterByline({ ownerId, organisation, poster }) {
  if (!ownerId) return null;
  const name = String(poster?.fullName ?? "").trim();
  const org = String(poster?.organisation ?? organisation ?? "").trim();
  return {
    primary: name || org || shortenAddress(ownerId),
    secondary: name ? org : org ? shortenAddress(ownerId) : "",
    profileRoute: `profile/${ownerId}`,
  };
}

/** Mirrors listProposalsForPosting ACL filters without touching Firestore. */
function proposalReadsForPosting({ problemId, viewerId, postingOwnerId }) {
  const uid = String(viewerId ?? "").toLowerCase();
  const owner = String(postingOwnerId ?? "").toLowerCase();
  if (!problemId || !uid) return [];
  const reads = [{ problemId, field: "researcherId", value: uid }];
  if (uid === owner) reads.push({ problemId, field: "postingOwnerId", value: uid });
  return reads;
}

function viewPosting(posting, session, { publicProfile, now = NOW } = {}) {
  const auth = deriveAuthState(session);
  const metrics = normaliseOpportunityMetrics(posting);
  return {
    route: evaluateRouteAccess("posting", auth.user),
    statusLabel: opportunityStatusLabel(posting.status, { expiresAt: posting.expiresAt, now }),
    actions: postingActions(posting, auth.user, { isAuthenticated: auth.isAuthenticated }),
    poster: posterByline({
      ownerId: posting.ownerId,
      organisation: posting.organisation,
      poster: publicProfile,
    }),
    funding: {
      requested: `${posting.currency} ${Number(posting.amount).toLocaleString()}`,
      committed: `${posting.currency} ${metrics.fundedAmount.toLocaleString()}`,
      percent: metrics.fundingProgressPercent,
    },
    proposalReads: proposalReadsForPosting({
      problemId: posting.id,
      viewerId: auth.user?.id,
      postingOwnerId: posting.ownerId,
    }),
  };
}

const participant = {
  isSignedIn: true,
  address: MEMBER,
  profile: { fullName: "Ada Researcher", organisation: "SMU", role: ROLE_USER },
};

const ownerSession = {
  isSignedIn: true,
  address: OWNER,
  profile: { fullName: "Meridian Owner", organisation: "Meridian Logistics", role: ROLE_USER },
};

const adminSession = {
  isSignedIn: true,
  address: `0x${"c".repeat(40)}`,
  profile: { fullName: "Admin", organisation: "QC DAO", role: ROLE_ADMIN },
};

function actionIds(view) {
  return view.actions.map((action) => action.id);
}

describe("[QCDAO-54] view posting detail page", () => {
  it("[FIT-OPD-030] should let a member open a live posting, see funding progress, and submit or fund", () => {
    const view = viewPosting(OPEN_POSTING, participant);
    assert.equal(view.route.action, "RENDER");
    assert.equal(view.statusLabel, "Submitted");
    assert.equal(view.funding.requested, `USDC ${Number(80000).toLocaleString()}`);
    assert.equal(view.funding.committed, `USDC ${Number(12000).toLocaleString()}`);
    assert.equal(view.funding.percent, 15);
    assert.deepEqual(actionIds(view), ["submit", "fund"]);
  });

  it("[FIT-OPD-031] should ask a visitor to sign in before submitting on an open posting", () => {
    const view = viewPosting(OPEN_POSTING, { isSignedIn: false, profile: null });
    assert.equal(view.route.action, "RENDER");
    assert.deepEqual(actionIds(view), ["submit-signin"]);
    assert.match(view.actions[0].route, /submit-proposal%2Fposting123/);
  });

  it("[FIT-OPD-032] should attribute the posting to a public profile, falling back when it is missing", () => {
    const named = viewPosting(OPEN_POSTING, participant, {
      publicProfile: { fullName: "Ada Lovelace", organisation: "Singapore Management University" },
    });
    assert.equal(named.poster.primary, "Ada Lovelace");
    assert.equal(named.poster.secondary, "Singapore Management University");
    assert.equal(named.poster.profileRoute, `profile/${OWNER}`);

    const missing = viewPosting(OPEN_POSTING, participant, { publicProfile: null });
    assert.equal(missing.poster.primary, "Meridian Logistics");
    assert.equal(missing.poster.secondary, shortenAddress(OWNER));
  });

  it("[FIT-OPD-033] should show Expired and hide Submit when an open posting's deadline has passed", () => {
    const view = viewPosting({ ...OPEN_POSTING, expiresAt: PAST }, participant);
    assert.equal(view.statusLabel, "Expired");
    assert.ok(!actionIds(view).includes("submit"));
  });

  it("[FIT-OPD-034] should let the owner resume a draft and never fund their own posting", () => {
    const draft = viewPosting({ ...OPEN_POSTING, status: "draft" }, ownerSession);
    assert.equal(draft.actions.find((action) => action.id === "edit").route, "create/posting123");
    const fundingDraft = viewPosting({
      ...OPEN_POSTING,
      status: "draft",
      opportunityType: OPEN_FUNDING_TYPE,
    }, ownerSession);
    assert.equal(fundingDraft.actions.find((action) => action.id === "edit").route, "create-funding/posting123");
    assert.ok(!actionIds(viewPosting(OPEN_POSTING, ownerSession)).includes("fund"));
  });

  it("[FIT-OPD-035] should show Evaluate in review and Moderate only to an administrator", () => {
    const review = viewPosting({ ...OPEN_POSTING, status: "in_review" }, participant);
    assert.ok(actionIds(review).includes("evaluate"));
    assert.equal(review.actions.find((action) => action.id === "evaluate").route, "evaluations");

    const admin = viewPosting(OPEN_POSTING, adminSession);
    assert.deepEqual(actionIds(admin), ["moderate"]);
    assert.equal(admin.actions[0].route, "admin");
  });

  it("[FIT-OPD-036] should let an author read their own proposals and the poster read the inbox", () => {
    const member = viewPosting(OPEN_POSTING, participant);
    assert.deepEqual(member.proposalReads, [
      { problemId: "posting123", field: "researcherId", value: MEMBER },
    ]);
    const poster = viewPosting(OPEN_POSTING, ownerSession);
    assert.deepEqual(poster.proposalReads, [
      { problemId: "posting123", field: "researcherId", value: OWNER },
      { problemId: "posting123", field: "postingOwnerId", value: OWNER },
    ]);
    const guest = viewPosting(OPEN_POSTING, { isSignedIn: false, profile: null });
    assert.deepEqual(guest.proposalReads, []);
  });
});
