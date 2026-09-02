import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CATEGORY_VALUES,
  CURRENCIES,
  MAX_CATEGORIES,
  POSTING_CATEGORIES,
  categoryLabel,
  expiryDateFrom,
} from "../../src/config/postingCategories.js";
import {
  validateCategories,
  validateCurrency,
  validateExpiry,
  validateFundingAmount,
  validatePosting,
  validatePostingTitle,
} from "../../src/lib/validation.js";
import { postingAuditPayload } from "../../src/lib/postings.js";

/** QCDAO-48 - the funded business problem statement form. */

function completeForm(overrides = {}) {
  return {
    title: "Cold-chain route optimisation",
    businessContext: "Perishable deliveries across a dense urban network.",
    summary: "Vehicle routing degrades badly under demand spikes.",
    currentApproach: "A nightly heuristic solver over the previous day's demand.",
    currentLimitations: "Runtime grows past the delivery window above 400 stops.",
    expectedOutcome: "A schedule produced inside a thirty minute window.",
    successCriteria: "Ten percent lower distance at equal service level.",
    dataAvailability: "Two years of anonymised delivery telemetry.",
    categories: ["ai"],
    amount: "80000",
    currency: "SGD",
    expiryDays: 90,
    ...overrides,
  };
}

describe("[QCDAO-48] quantum-adjacent categories", () => {
  it("[FUT-OPD-092] spans several fields, not just quantum", () => {
    for (const value of ["ai", "quantum", "web3", "robotics", "iot"]) {
      assert.ok(CATEGORY_VALUES.includes(value), `${value} should be offered`);
    }
    assert.ok(CATEGORY_VALUES.length >= 8, "too few areas to cover the sponsor base");
  });

  it("[FUT-OPD-093] keeps quantum broad enough to include non-gate-based work", () => {
    const quantum = POSTING_CATEGORIES.find((category) => category.value === "quantum");
    assert.ok(quantum, "quantum must remain an option");
    assert.match(quantum.note, /annealing/i);
    assert.match(quantum.note, /inspired/i);
  });

  it("[FUT-OPD-094] offers only categories firestore.rules will accept", () => {
    const rules = readFileSync(
      new URL("../../../firebase/firestore.rules", import.meta.url), "utf8",
    );
    const allowed = rules
      .split("function allowedCategories()")[1]
      .split("}")[0];
    for (const value of CATEGORY_VALUES) {
      assert.ok(allowed.includes(`'${value}'`), `${value} is missing from firestore.rules`);
    }
  });

  it("[FUT-OPD-095] resolves a label for a stored value", () => {
    assert.equal(categoryLabel("ai"), "AI & machine learning");
    assert.equal(categoryLabel("something-else"), "something-else");
  });

  it("[FUT-OPD-096] accepts a valid selection and rejects an unknown one", () => {
    assert.equal(validateCategories(["ai", "quantum"]), null);
    assert.match(validateCategories(["blockchain"]), /not a category/);
  });

  it("[FUT-OPD-097] requires at least one and caps the maximum", () => {
    assert.match(validateCategories([]), /at least one/);
    assert.match(
      validateCategories(Array(MAX_CATEGORIES + 1).fill("ai")),
      /no more than/,
    );
  });
});

describe("[QCDAO-48] funding, currency and expiry", () => {
  it("[FUT-OPD-098] rejects a zero or negative funding requirement", () => {
    assert.match(validateFundingAmount("0"), /greater than zero/);
    assert.match(validateFundingAmount("-100"), /greater than zero/);
    assert.equal(validateFundingAmount("80000"), null);
  });

  it("[FUT-OPD-099] rejects a missing or non-numeric amount", () => {
    assert.match(validateFundingAmount(""), /required/);
    assert.match(validateFundingAmount("lots"), /must be a number/);
  });

  it("[FUT-OPD-100] accepts only the supported currencies", () => {
    for (const code of CURRENCIES) assert.equal(validateCurrency(code), null);
    assert.match(validateCurrency("XYZ"), /Choose a currency/);
  });

  it("[FUT-OPD-101] turns an expiry window into a future date", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const expiry = expiryDateFrom(90, now);
    assert.ok(expiry > now);
    assert.equal(validateExpiry(90), null);
    assert.match(validateExpiry(0), /how long/);
  });
});

describe("[QCDAO-48] field-level validation", () => {
  it("[FUT-OPD-102] passes a complete form", () => {
    assert.deepEqual(validatePosting(completeForm()), {});
  });

  it("[FUT-OPD-103] names every empty required field individually", () => {
    const errors = validatePosting({
      title: "", businessContext: "", summary: "", currentApproach: "",
      currentLimitations: "", expectedOutcome: "", successCriteria: "",
      dataAvailability: "", categories: [], amount: "", currency: "", expiryDays: 0,
    });
    for (const field of [
      "title", "businessContext", "summary", "currentApproach", "currentLimitations",
      "expectedOutcome", "successCriteria", "dataAvailability",
      "categories", "amount", "currency", "expiryDays",
    ]) {
      assert.ok(errors[field], `${field} should have its own message`);
    }
  });

  it("[FUT-OPD-104] rejects a single-character entry, matching the rules", () => {
    assert.match(validatePostingTitle("x"), /more than one character/);
  });

  it("[FUT-OPD-105] rejects text beyond the stored maximum", () => {
    assert.match(validatePostingTitle("x".repeat(161)), /160 characters or fewer/);
  });
});

describe("[QCDAO-75] funded posting audit payload", () => {
  it("normalises set-like fields and excludes mutable receipt timestamps", () => {
    const expiresAt = new Date("2026-12-01T00:00:00Z");
    const payload = postingAuditPayload({
      ...completeForm({ categories: ["quantum", "ai"], amount: "80000" }),
      ownerId: `0x${"A".repeat(40)}`,
      organisation: " SMU ",
      expiresAt,
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-09-02T00:00:00Z"),
      audit: { status: "confirmed" },
      attachments: [
        { id: "z", name: " Z.pdf ", size: 20, contentType: "application/pdf" },
        { id: "a", name: "A.pdf", size: 10 },
      ],
    });

    assert.deepEqual(payload.categories, ["ai", "quantum"]);
    assert.deepEqual(payload.attachments.map(({ id }) => id), ["a", "z"]);
    assert.equal(payload.ownerId, `0x${"a".repeat(40)}`);
    assert.equal(payload.organisation, "SMU");
    assert.equal(payload.amount, 80000);
    assert.equal(payload.expiresAt, expiresAt);
    assert.equal("createdAt" in payload, false);
    assert.equal("updatedAt" in payload, false);
    assert.equal("audit" in payload, false);
  });
});
