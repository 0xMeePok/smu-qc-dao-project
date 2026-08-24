import { roleValues } from "./roles.js";

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

export function validateRole(value = "") {
  if (!value) return "Choose the role that matches how you will use the platform.";
  if (!roleValues.includes(value)) return "That role is not one of the available options.";
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
// Role is deliberately not collected or validated here. It used to be, but that
// meant asking for it twice - once in this onboarding form, once again on the
// role-selection screen right after - and only the second answer was ever kept,
// since createProfile wrote whatever role-selection later overwrote. The account is
// created with roles.DEFAULT_ROLE and the role-selection screen is now the one place
// a role is actually chosen and stored.
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
