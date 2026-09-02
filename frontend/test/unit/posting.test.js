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
  it("[FUT-P48-01] spans several fields, not just quantum", () => {
    // The platform takes business problems from any technology area, so the picker
    // has to reach beyond quantum or the form silently narrows who can post.
    for (const value of ["ai", "quantum", "web3", "robotics", "iot"]) {
      assert.ok(CATEGORY_VALUES.includes(value), `${value} should be offered`);
    }
    assert.ok(CATEGORY_VALUES.length >= 8, "too few areas to cover the sponsor base");
  });

  it("[FUT-P48-01b] keeps quantum broad enough to include non-gate-based work", () => {
    // Sponsor feedback of 09/06/2026 was that annealing and quantum-inspired work
    // must not be excluded. These are no longer separate options - "quantum" is one
    // domain - so the note is what carries that promise to the person choosing.
    const quantum = POSTING_CATEGORIES.find((category) => category.value === "quantum");
    assert.ok(quantum, "quantum must remain an option");
    assert.match(quantum.note, /annealing/i);
    assert.match(quantum.note, /inspired/i);
  });

  it("[FUT-P48-01c] offers only categories firestore.rules will accept", () => {
    // A value here that the rules reject means every posting using it fails on
    // write, with a rules error and no field to attach it to.
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

  it("[FUT-P48-02] gives every category a label and a note", () => {
    for (const category of POSTING_CATEGORIES) {
      assert.ok(category.label?.length > 0, `${category.value} has no label`);
      assert.ok(category.note?.length > 0, `${category.value} has no note`);
    }
  });

  it("[FUT-P48-03] resolves a label for a stored value", () => {
    assert.equal(categoryLabel("ai"), "AI & machine learning");
    // An unknown value must render as itself rather than as "undefined".
    assert.equal(categoryLabel("something-else"), "something-else");
  });

  it("[FUT-P48-04] accepts a valid selection and rejects an unknown one", () => {
    assert.equal(validateCategories(["ai", "quantum"]), null);
    assert.match(validateCategories(["blockchain"]), /not a category/);
  });

  it("[FUT-P48-05] requires at least one and caps the maximum", () => {
    assert.match(validateCategories([]), /at least one/);
    assert.match(
      validateCategories(Array(MAX_CATEGORIES + 1).fill("ai")),
      /no more than/,
    );
  });
});

describe("[QCDAO-48] funding, currency and expiry", () => {
  it("[FUT-P48-06] rejects a zero or negative funding requirement", () => {
    // firestore.rules refuses amount <= 0 for a submitted posting, so the form must
    // not let one through and then surface a rules error instead of a field message.
    assert.match(validateFundingAmount("0"), /greater than zero/);
    assert.match(validateFundingAmount("-100"), /greater than zero/);
    assert.equal(validateFundingAmount("80000"), null);
  });

  it("[FUT-P48-07] rejects a missing or non-numeric amount", () => {
    assert.match(validateFundingAmount(""), /required/);
    assert.match(validateFundingAmount("lots"), /must be a number/);
  });

  it("[FUT-P48-08] accepts only the supported currencies", () => {
    for (const code of CURRENCIES) assert.equal(validateCurrency(code), null);
    assert.match(validateCurrency("XYZ"), /Choose a currency/);
  });

  it("[FUT-P48-09] turns an expiry window into a future date", () => {
    const now = new Date("2026-09-01T00:00:00Z");
    const expiry = expiryDateFrom(90, now);
    assert.ok(expiry > now);
    assert.equal(validateExpiry(90), null);
    assert.match(validateExpiry(0), /how long/);
  });
});

describe("[QCDAO-48] field-level validation", () => {
  it("[FUT-P48-10] passes a complete form", () => {
    assert.deepEqual(validatePosting(completeForm()), {});
  });

  it("[FUT-P48-11] names every empty required field individually", () => {
    // The story asks for field-level messages, not one summary error, so each
    // missing field must appear under its own key.
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

  it("[FUT-P48-12] reports only the fields that are actually wrong", () => {
    const errors = validatePosting(completeForm({ amount: "0" }));
    assert.deepEqual(Object.keys(errors), ["amount"]);
  });

  it("[FUT-P48-13] rejects a single-character entry, matching the rules", () => {
    // isNonEmptyString in firestore.rules requires size() > 1. Accepting one
    // character here would produce a server rejection with no field to attach it to.
    assert.match(validatePostingTitle("x"), /more than one character/);
  });


  it("[FUT-P48-15] rejects text beyond the stored maximum", () => {
    assert.match(validatePostingTitle("x".repeat(161)), /160 characters or fewer/);
  });
});
