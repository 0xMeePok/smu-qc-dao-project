import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPEN_FUNDING_TYPE } from "../../src/config/fundingOpportunity.js";
import { ROLES } from "../../src/config/roles.js";
import {
  OPPORTUNITY_STATUSES,
  opportunityStatusLabel,
} from "../../src/config/workflowStatus.js";
import { postingActions } from "../../src/lib/postingActions.js";

/** QCDAO-54 - view a posting detail page with full metadata and countdown. */

const OWNER = `0x${"a".repeat(40)}`;
const MEMBER = `0x${"b".repeat(40)}`;
const NOW = new Date("2026-09-08T00:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");

const OPEN_POSTING = {
  id: "posting123",
  ownerId: OWNER,
  status: "submitted",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
};

const PARTICIPANT = {
  id: MEMBER,
  roles: [ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER],
};

function actionIds(posting, user, options) {
  return postingActions(posting, user, options).map((action) => action.id);
}

function source(relativeFromTest) {
  return readFileSync(new URL(relativeFromTest, import.meta.url), "utf8");
}

describe("[QCDAO-54] view posting detail page", () => {
  it("[FUT-OPD-120] labels workflow status and overlays Expired only while responses are still open", () => {
    assert.equal(opportunityStatusLabel("submitted"), "Submitted");
    assert.equal(opportunityStatusLabel("in_review"), "In review");
    assert.equal(opportunityStatusLabel("submitted", { expiresAt: PAST, now: NOW }), "Expired");
    assert.equal(opportunityStatusLabel("funded", { expiresAt: PAST, now: NOW }), "Funded");
    assert.equal(opportunityStatusLabel("cancelled", { expiresAt: PAST, now: NOW }), "Cancelled");
  });

  it("[FUT-OPD-121] uses the same opportunity statuses firestore.rules will accept", () => {
    const rules = source("../../../firebase/firestore.rules");
    const allowed = rules
      .split("function validProblemStatus(status)")[1]
      .split("}")[0];
    const stored = Object.values(OPPORTUNITY_STATUSES);
    assert.deepEqual(stored, [
      "draft", "submitted", "open", "in_review", "matched", "funded", "completed", "cancelled",
    ]);
    for (const status of stored) {
      assert.ok(allowed.includes(`'${status}'`), `${status} is missing from firestore.rules`);
    }
  });

  it("[FUT-OPD-122] loads the poster's public profile and links to their public profile route", () => {
    const page = source("../../src/pages/PostingDetailPage.jsx");
    assert.match(page, /findPublicProfileByAddress/);
    assert.match(page, /profile\/\$\{ownerId\}/);
    assert.match(page, /poster\?\.fullName/);
    assert.match(page, /shortenAddress\(ownerId\)/);
  });

  it("[FUT-OPD-123] lets a researcher submit an open posting and asks a visitor to sign in first", () => {
    const submit = postingActions(OPEN_POSTING, PARTICIPANT).find((action) => action.id === "submit");
    assert.equal(submit.route, "submit-proposal/posting123");
    const guest = postingActions(OPEN_POSTING, null, { isAuthenticated: false });
    assert.deepEqual(guest.map((action) => action.id), ["submit-signin"]);
    assert.match(guest[0].route, /submit-proposal%2Fposting123/);
  });

  it("[FUT-OPD-124] hides submit once the posting is closed to new proposals", () => {
    assert.ok(!actionIds({ ...OPEN_POSTING, status: "matched" }, PARTICIPANT).includes("submit"));
    assert.ok(!actionIds({ ...OPEN_POSTING, expiresAt: PAST }, PARTICIPANT).includes("submit"));
    assert.ok(!actionIds({ ...OPEN_POSTING, moderated: true }, PARTICIPANT).includes("submit"));
  });

  it("[FUT-OPD-125] shows fund, evaluate, moderate and edit only where role and workflow allow it", () => {
    assert.ok(actionIds(OPEN_POSTING, PARTICIPANT).includes("fund"));
    assert.ok(!actionIds(OPEN_POSTING, { ...PARTICIPANT, id: OWNER }).includes("fund"));
    assert.ok(!actionIds({ ...OPEN_POSTING, status: "completed" }, PARTICIPANT).includes("fund"));

    assert.ok(!actionIds(OPEN_POSTING, PARTICIPANT).includes("evaluate"));
    assert.ok(actionIds({ ...OPEN_POSTING, status: "in_review" }, PARTICIPANT).includes("evaluate"));

    const admin = postingActions(OPEN_POSTING, { id: "0xadmin", roles: [ROLES.ADMIN] });
    assert.deepEqual(admin.map((action) => action.id), ["moderate"]);
    assert.equal(admin[0].route, "admin");

    const owner = { id: OWNER, roles: PARTICIPANT.roles };
    assert.equal(
      postingActions({ ...OPEN_POSTING, status: "draft" }, owner).find((action) => action.id === "edit").route,
      "create/posting123",
    );
    assert.equal(
      postingActions({
        ...OPEN_POSTING,
        status: "draft",
        opportunityType: OPEN_FUNDING_TYPE,
      }, owner).find((action) => action.id === "edit").route,
      "create-funding/posting123",
    );
  });

  it("[FUT-OPD-126] never offers comment or escrow, and a member can submit and fund together", () => {
    assert.deepEqual(actionIds(OPEN_POSTING, PARTICIPANT), ["submit", "fund"]);
    for (const user of [PARTICIPANT, { id: OWNER, roles: PARTICIPANT.roles }, { id: "0xadmin", roles: [ROLES.ADMIN] }, null]) {
      const ids = actionIds(OPEN_POSTING, user, { isAuthenticated: Boolean(user) });
      assert.ok(!ids.includes("comment"));
      assert.ok(!ids.includes("escrow"));
    }
  });

  it("[FUT-OPD-127] scopes proposal reads to the author, and to the poster inbox", () => {
    const listing = source("../../src/lib/proposals.js")
      .split("export async function listProposalsForPosting")[1]
      .split("export async function listProposalRevisions")[0];
    assert.match(listing, /where\("researcherId"/);
    assert.match(listing, /where\("postingOwnerId"/);
    assert.match(listing, /uid === owner/);
  });

  it("[FUT-OPD-128] issues no proposal reads without a viewer or posting", () => {
    const listing = source("../../src/lib/proposals.js")
      .split("export async function listProposalsForPosting")[1]
      .split("export async function listProposalRevisions")[0];
    assert.match(listing, /if \(!problemId \|\| !uid\) return \[\]/);
  });

  it("[FUT-OPD-129] declares the compound indexes those posting-scoped reads need", () => {
    const indexes = JSON.parse(source("../../../firebase/firestore.indexes.json"));
    const paths = indexes.indexes
      .filter((index) => index.collectionGroup === "proposals")
      .map((index) => index.fields.map((field) => field.fieldPath).join("+"));
    assert.ok(paths.includes("problemId+researcherId"));
    assert.ok(paths.includes("problemId+postingOwnerId"));
  });
});
