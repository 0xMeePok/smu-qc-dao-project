import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROLES } from "../../src/config/roles.js";
import { evaluateRouteAccess, getPermittedNavRoutes } from "../../src/config/routes.js";
import {
  VERIFIED_BADGE_COPY,
  VERIFIED_BADGE_HINT,
  VERIFIED_STATES,
  verifiedStateFromAudit,
} from "../../src/config/verifiedBadge.js";
import { opportunityStatusLabel } from "../../src/config/workflowStatus.js";
import { toOpportunityListItem } from "../../src/lib/opportunityPresentation.js";
import { ROLE_ADMIN, ROLE_USER, isAdmin } from "../../src/lib/roles.js";

/** QCDAO-80 - trust indicator treatment across lists, records, and help. */

const NOW = new Date("2026-09-15T00:00:00Z");
const FUTURE = new Date("2099-01-01T00:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");

const LIVE = {
  id: "posting-trust",
  organisation: "Meridian Logistics",
  title: "Campus cooling",
  status: "submitted",
  amount: 80000,
  currency: "USDC",
  expiresAt: FUTURE,
  categories: ["quantum"],
  proposalCount: 2,
  fundingProgressPercent: 10,
  audit: { status: "confirmed" },
};

function listTrustView(record, { now = NOW } = {}) {
  const item = toOpportunityListItem(record);
  const state = verifiedStateFromAudit(item.audit, { recordStatus: item.status });
  return {
    item,
    workflow: opportunityStatusLabel(item.status, { expiresAt: item.expiresAt, now }),
    verification: state,
    chip: VERIFIED_BADGE_COPY[state],
    hint: VERIFIED_BADGE_HINT,
  };
}

function navKeys(roles) {
  return getPermittedNavRoutes(roles).map((route) => route.key);
}

/** Mirrors ArchitectureHelpPage: only an unsuspended administrator sees the audit-trail control. */
function architectureHelp(session) {
  const user = session?.isSignedIn && session?.profile
    ? {
      roles: isAdmin(session.profile.role) ? [ROLES.ADMIN] : [ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER],
    }
    : null;
  return {
    page: evaluateRouteAccess("architecture", user),
    auditTrail: evaluateRouteAccess("admin", user),
    showAuditTrail: isAdmin(session?.profile?.role) && !session?.profile?.suspended,
  };
}

describe("Integration Tests: Trust indicator treatment (QCDAO-80)", () => {
  it("[FIT-BAV-037] should show a verified chip beside workflow status on a published list record", () => {
    const view = listTrustView(LIVE);
    assert.equal(view.item.audit.status, "confirmed");
    assert.equal(view.workflow, "Submitted");
    assert.equal(view.verification, VERIFIED_STATES.VERIFIED);
    assert.equal(view.chip.label, "Verified");
    assert.match(view.chip.ariaLabel, /on-chain verification: verified/i);
    assert.notEqual(view.workflow, view.chip.label);
  });

  it("[FIT-BAV-038] should keep drafts and missing receipts not anchored without relabelling workflow", () => {
    const leftover = listTrustView({ ...LIVE, status: "draft", audit: { status: "confirmed" } });
    assert.equal(leftover.workflow, "Draft");
    assert.equal(leftover.verification, VERIFIED_STATES.NOT_ANCHORED);
    assert.equal(leftover.chip.label, "Not anchored");

    const unpublished = listTrustView({ ...LIVE, status: "open", audit: null });
    assert.equal(unpublished.workflow, "Open");
    assert.equal(unpublished.verification, VERIFIED_STATES.NOT_ANCHORED);
  });

  it("[FIT-BAV-039] should surface pending and failed receipts without changing workflow or expiry labels", () => {
    const pending = listTrustView({ ...LIVE, audit: { status: "pending" } });
    assert.equal(pending.workflow, "Submitted");
    assert.equal(pending.verification, VERIFIED_STATES.PENDING);

    const failed = listTrustView({ ...LIVE, audit: { status: "failed" } });
    assert.equal(failed.workflow, "Submitted");
    assert.equal(failed.verification, VERIFIED_STATES.FAILED);

    const expired = listTrustView({ ...LIVE, expiresAt: PAST, audit: { status: "confirmed" } });
    assert.equal(expired.workflow, "Expired");
    assert.equal(expired.verification, VERIFIED_STATES.VERIFIED);
  });

  it("[FIT-BAV-040] should keep architecture help public and out of header navigation", () => {
    const guest = architectureHelp({ isSignedIn: false, profile: null });
    assert.equal(guest.page.action, "RENDER");
    assert.equal(guest.page.allowed, true);
    assert.equal(guest.showAuditTrail, false);

    assert.ok(!navKeys([]).includes("architecture"));
    assert.ok(!navKeys([ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER]).includes("architecture"));
    assert.ok(!navKeys([ROLES.ADMIN]).includes("architecture"));
  });

  it("[FIT-BAV-041] should offer both legend entry points only to an unsuspended administrator", () => {
    const admin = architectureHelp({
      isSignedIn: true,
      profile: { role: ROLE_ADMIN, suspended: false },
    });
    assert.equal(admin.page.action, "RENDER");
    assert.equal(admin.auditTrail.action, "RENDER");
    assert.equal(admin.showAuditTrail, true);

    const member = architectureHelp({
      isSignedIn: true,
      profile: { role: ROLE_USER, suspended: false },
    });
    assert.equal(member.page.action, "RENDER");
    assert.equal(member.auditTrail.action, "DENY_403");
    assert.equal(member.showAuditTrail, false);

    const suspended = architectureHelp({
      isSignedIn: true,
      profile: { role: ROLE_ADMIN, suspended: true },
    });
    assert.equal(suspended.showAuditTrail, false);
    assert.match(VERIFIED_BADGE_HINT, /Arbitrum Sepolia/);
    assert.match(VERIFIED_BADGE_HINT, /Firestore/);
  });
});
