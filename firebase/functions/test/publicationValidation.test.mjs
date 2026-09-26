import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Timestamp } from "firebase-admin/firestore";
import { isPublishableProblem } from "../publicationValidation.js";

// Mirrors the firestore.rules checks attestPublication now runs for a publish.
// Each rejection case names the rule it stands in for.
const UID = `0x${"a".repeat(40)}`;
const ORG = "Singapore Management University";
const ctx = { uid: UID, profileOrganisation: ORG };
const expiresAt = Timestamp.fromMillis(Date.now() + 90 * 864e5);
const pdf = (i, extra = {}) => ({
  id: `124bfa6b-1dac-4d57-a1de-fa35b736198${i}`, name: "spec.pdf", size: 580505,
  contentType: "application/pdf", sha256: `0x${"ab".repeat(32)}`, ...extra,
});

const problem = (overrides = {}) => ({
  ownerId: UID, organisation: ORG, status: "submitted",
  title: "Cold-chain route optimisation", summary: "Routing degrades under demand spikes.",
  businessContext: "Perishable deliveries.", currentApproach: "Nightly heuristic.",
  currentLimitations: "Too slow.", expectedOutcome: "Schedules in 30 minutes.",
  successCriteria: "Ten percent shorter routes.", dataAvailability: "Two years of telemetry.",
  categories: ["ai", "quantum"], amount: 80000, currency: "USDT", expiresAt,
  attachments: [pdf(0), pdf(1)],
  ...overrides,
});

const funding = (overrides = {}) => ({
  ownerId: UID, organisation: ORG, status: "submitted", opportunityType: "open-funding",
  title: "Open call", fundingThesis: "Resilient supply chains.", eligibilityNotes: "Singapore institutions.",
  categories: ["ai"], tags: ["AI & machine learning"], amount: 10000, currency: "XSGD", expiresAt,
  attachments: [pdf(0)],
  ...overrides,
});

const without = (record, key) => { const copy = { ...record }; delete copy[key]; return copy; };

describe("isPublishableProblem - business problem", () => {
  it("accepts a complete posting with 0, 1 or 2 PDFs, with or without legacy 4-field entries", () => {
    for (const attachments of [[], [pdf(0)], [pdf(0), pdf(1)], [without(pdf(0), "sha256")]]) {
      assert.equal(isPublishableProblem(problem({ attachments }), ctx), true);
    }
    assert.equal(isPublishableProblem(problem({ status: "open" }), ctx), true);
    assert.equal(isPublishableProblem(without(problem(), "attachments"), ctx), true);
  });

  it("rejects the wrong owner, status or a withdrawn reason (create rule, validProblemStatus)", () => {
    assert.equal(isPublishableProblem(problem({ ownerId: `0x${"b".repeat(40)}` }), ctx), false);
    assert.equal(isPublishableProblem(problem(), { ...ctx, uid: "not-a-wallet" }), false);
    for (const status of ["draft", "cancelled", "expired", "matched"]) {
      assert.equal(isPublishableProblem(problem({ status }), ctx), false, status);
    }
    assert.equal(isPublishableProblem(problem({ withdrawalReason: "gone" }), ctx), false);
    assert.equal(isPublishableProblem(problem({ withdrawalReason: "" }), ctx), true);
  });

  it("rejects unknown keys (hasProblemSchema)", () => {
    for (const key of ["matching", "moderationStatus", "problemBrowsable", "injected"]) {
      assert.equal(isPublishableProblem(problem({ [key]: "x" }), ctx), false, key);
    }
  });

  it("requires every text field, more than one character, within its bound (validFundedPosting)", () => {
    const fields = { title: 160, summary: 4000, organisation: 120, businessContext: 4000, currentApproach: 4000,
      currentLimitations: 4000, expectedOutcome: 4000, successCriteria: 4000, dataAvailability: 4000 };
    for (const [key, max] of Object.entries(fields)) {
      assert.equal(isPublishableProblem(without(problem(), key), ctx), false, `${key} missing`);
      assert.equal(isPublishableProblem(problem({ [key]: "x" }), ctx), false, `${key} one char`);
      assert.equal(isPublishableProblem(problem({ [key]: "x".repeat(max + 1) }), { ...ctx, profileOrganisation: key === "organisation" ? "x".repeat(max + 1) : ORG }), false, `${key} too long`);
    }
  });

  it("bounds the optional legacy strings (legacyTextIsBounded)", () => {
    assert.equal(isPublishableProblem(problem({ fundingThesis: "x".repeat(4001) }), ctx), false);
    assert.equal(isPublishableProblem(problem({ eligibilityNotes: 5 }), ctx), false);
    assert.equal(isPublishableProblem(problem({ opportunityType: "business-problem" }), ctx), true);
    assert.equal(isPublishableProblem(problem({ opportunityType: "funding-request" }), ctx), false);
  });

  it("checks categories, tags, currency, amount and expiry (validProblem)", () => {
    assert.equal(isPublishableProblem(problem({ categories: [] }), ctx), false);
    assert.equal(isPublishableProblem(problem({ categories: ["ai", "made-up"] }), ctx), false);
    assert.equal(isPublishableProblem(problem({ categories: ["ai", "quantum", "web3", "iot", "data", "cloud", "other"] }), ctx), false);
    assert.equal(isPublishableProblem(problem({ tags: [] }), ctx), true);
    assert.equal(isPublishableProblem(problem({ tags: ["a", "a"] }), ctx), false);
    assert.equal(isPublishableProblem(without(problem(), "currency"), ctx), false);
    assert.equal(isPublishableProblem(problem({ currency: "DOGE" }), ctx), false);
    for (const amount of [0, -1, 1_000_000_001, "80000", Number.NaN]) {
      assert.equal(isPublishableProblem(problem({ amount }), ctx), false, String(amount));
    }
    assert.equal(isPublishableProblem(problem({ expiresAt: "2026-12-25T00:00:00Z" }), ctx), false);
    assert.equal(isPublishableProblem(without(problem(), "expiresAt"), ctx), false);
  });

  it("binds the sponsor to the caller's profile organisation", () => {
    assert.equal(isPublishableProblem(problem({ organisation: "Someone Else Ltd" }), ctx), false);
    assert.equal(isPublishableProblem(problem(), { ...ctx, profileOrganisation: undefined }), false);
  });

  it("checks every attachment entry (validAttachments / attachmentEntry)", () => {
    const bad = [
      [pdf(0), pdf(1), pdf(2)],
      [pdf(0, { contentType: "image/png" })],
      [pdf(0, { size: 0 })],
      [pdf(0, { size: 10 * 1024 * 1024 + 1 })],
      [pdf(0, { id: "short" })],
      [pdf(0, { name: "" })],
      [pdf(0, { sha256: "0xnothex" })],
      [pdf(0, { path: "other/owner/file.pdf" })],
      [{ ...without(pdf(0), "sha256"), path: "x" }],
      ["not-a-map"],
    ];
    for (const attachments of bad) assert.equal(isPublishableProblem(problem({ attachments }), ctx), false, JSON.stringify(attachments).slice(0, 60));
    assert.equal(isPublishableProblem(problem({ attachments: "nope" }), ctx), false);
  });
});

describe("isPublishableProblem - open funding", () => {
  it("accepts a complete open-funding call", () => {
    assert.equal(isPublishableProblem(funding(), ctx), true);
    assert.equal(isPublishableProblem(funding({ categories: [] }), ctx), true);
  });

  it("rejects problem-statement fields and unknown keys (validOpenFunding hasOnly)", () => {
    for (const key of ["summary", "businessContext", "matching", "injected"]) {
      assert.equal(isPublishableProblem(funding({ [key]: "text" }), ctx), false, key);
    }
  });

  it("requires the complete call (completeOpenFunding)", () => {
    for (const key of ["organisation", "title", "fundingThesis", "eligibilityNotes", "categories", "tags", "amount", "currency", "expiresAt"]) {
      assert.equal(isPublishableProblem(without(funding(), key), ctx), false, key);
    }
    assert.equal(isPublishableProblem(funding({ tags: [] }), ctx), false);
    assert.equal(isPublishableProblem(funding({ tags: ["x".repeat(41)] }), ctx), false);
    assert.equal(isPublishableProblem(funding({ amount: 0 }), ctx), false);
    assert.equal(isPublishableProblem(funding({ organisation: "Other" }), ctx), false);
    assert.equal(isPublishableProblem(funding({ attachments: [pdf(0, { contentType: "text/plain" })] }), ctx), false);
  });
});
