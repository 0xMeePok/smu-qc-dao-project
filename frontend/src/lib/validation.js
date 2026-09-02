import {
  CATEGORY_VALUES,
  CURRENCIES,
  MAX_CATEGORIES,
} from "../config/postingCategories.js";

export function validateFullName(value = "") {
  const trimmed = value.trim();
  if (!trimmed) return "Enter your full name.";
  if (trimmed.length < 2) return "Your full name needs at least 2 characters.";
  if (trimmed.length > 80) return "Your full name cannot be longer than 80 characters.";
  return null;
}

export function validateOrganisation(value = "") {
  const trimmed = value.trim();
  if (!trimmed) return "Enter the organisation you represent.";
  if (trimmed.length < 2) return "The organisation name needs at least 2 characters.";
  if (trimmed.length > 120) return "The organisation name cannot be longer than 120 characters.";
  return null;
}

export function validateBiography(value = "") {
  if (typeof value !== "string") return "Your biography must be text.";
  if (value.length > 500) return "Your biography cannot be longer than 500 characters.";
  return null;
}

export function validateExpertise(value = []) {
  if (!Array.isArray(value)) return "Areas of expertise must be a list.";
  if (value.length > 12) return "Choose no more than 12 areas of expertise.";
  if (value.some((item) => typeof item !== "string" || item.trim().length < 2)) {
    return "Each area of expertise needs at least 2 characters.";
  }
  if (value.some((item) => item.trim().length > 80)) {
    return "Each area of expertise cannot be longer than 80 characters.";
  }
  return null;
}

export function validateTerms(accepted) {
  if (!accepted) return "You need to accept the platform terms to continue.";
  return null;
}

// The signature itself is verified on the server before any of this runs, so all
// that is left to check here is that we actually have a verified address to write to.
export function validateWallet(address) {
  if (!address) return "Connect and verify your wallet before continuing.";
  if (!isAddress(address)) return "That wallet address is not a valid Ethereum address.";
  return null;
}

function isAddress(value = "") {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

// Runs every rule and returns a field -> message map. Empty means the form is valid.
//
// There is no role field to collect: every account is created as a normal user
// (roles.ROLE_USER), and administrator access is granted by hand in Firestore, not
// chosen by the person signing up.
export function validateOnboarding(form, address) {
  const errors = {
    fullName: validateFullName(form.fullName),
    organisation: validateOrganisation(form.organisation),
    acceptedTerms: validateTerms(form.acceptedTerms),
    wallet: validateWallet(address),
  };

  for (const key of Object.keys(errors)) {
    if (errors[key] === null) delete errors[key];
  }
  return errors;
}

export function validateProfile(form, address) {
  const errors = {
    fullName: validateFullName(form.fullName),
    organisation: validateOrganisation(form.organisation),
    biography: validateBiography(form.biography),
    expertise: validateExpertise(form.expertise),
    wallet: validateWallet(address),
  };

  for (const key of Object.keys(errors)) {
    if (errors[key] === null) delete errors[key];
  }
  return errors;
}

/* ------------------------------------------------------------------ QCDAO-48 */


// Mirrors isNonEmptyString(value, max) in firebase/firestore.rules, which requires
// size() > 1 - a single character is rejected there, so it is rejected here too
// rather than being accepted and then bounced by the server.
function validateLongText(value = "", { label, max = 4000 }) {
  const text = String(value ?? "").trim();
  if (text.length === 0) return `${label} is required.`;
  if (text.length < 2) return `${label} needs to be more than one character.`;
  if (text.length > max) return `${label} must be ${max} characters or fewer.`;
  return null;
}

export function validatePostingTitle(value = "") {
  return validateLongText(value, { label: "Title", max: 160 });
}

export function validateCategories(values = []) {
  if (!Array.isArray(values) || values.length === 0) {
    return "Choose at least one category of interest.";
  }
  if (values.length > MAX_CATEGORIES) {
    return `Choose no more than ${MAX_CATEGORIES} categories.`;
  }
  const unknown = values.find((value) => !CATEGORY_VALUES.includes(value));
  if (unknown) return `"${unknown}" is not a category we recognise.`;
  return null;
}

export function validateFundingAmount(value) {
  const amount = Number(value);
  if (value === "" || value === null || value === undefined) {
    return "Funding requirement is required.";
  }
  if (!Number.isFinite(amount)) return "Funding requirement must be a number.";
  // The rules reject 0 for a submitted posting, so do not let one through here.
  if (amount <= 0) return "Funding requirement must be greater than zero.";
  if (amount > 1000000000) return "Funding requirement is too large.";
  return null;
}

export function validateCurrency(value) {
  if (!CURRENCIES.includes(value)) return "Choose a currency.";
  return null;
}

export function validateExpiry(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days <= 0) return "Choose how long this stays open.";
  return null;
}


/**
 * Every field-level message for the funded problem statement form, keyed by field
 * name so the form can render each one against its own input rather than showing a
 * single summary. An empty object means the form is submittable.
 */
export function validatePosting(form) {
  const errors = {
    title: validatePostingTitle(form.title),
    businessContext: validateLongText(form.businessContext, { label: "Business context" }),
    summary: validateLongText(form.summary, { label: "Problem description" }),
    currentApproach: validateLongText(form.currentApproach, { label: "Current approach" }),
    currentLimitations: validateLongText(form.currentLimitations, { label: "Limitations" }),
    expectedOutcome: validateLongText(form.expectedOutcome, { label: "Expected outcome" }),
    successCriteria: validateLongText(form.successCriteria, { label: "Success criteria" }),
    dataAvailability: validateLongText(form.dataAvailability, { label: "Data availability" }),
    categories: validateCategories(form.categories),
    amount: validateFundingAmount(form.amount),
    currency: validateCurrency(form.currency),
    expiryDays: validateExpiry(form.expiryDays),
  };

  for (const key of Object.keys(errors)) {
    if (errors[key] === null) delete errors[key];
  }
  return errors;
}
