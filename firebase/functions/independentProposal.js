/** Independent (unattached) solution proposals. Shared by Cloud Functions and the frontend. */

import { deadlinePassed } from "./opportunityExpiry.js";

export const INDEPENDENT_PROPOSAL_KIND = "independent";

/** Canonical audit hash scheme for independent listings. Attached proposals stay on scheme 1. */
export const INDEPENDENT_PROPOSAL_HASH_SCHEME = 2;

export const PROPOSAL_MATURITY_LEVELS = Object.freeze([
  { value: "concept", label: "Concept / early research" },
  { value: "laboratory", label: "Laboratory prototype" },
  { value: "pilot", label: "Pilot / demonstration" },
  { value: "production", label: "Production-ready" },
]);

export const PROPOSAL_MATURITY_VALUES = Object.freeze(
  PROPOSAL_MATURITY_LEVELS.map((item) => item.value),
);

/** Story fields that are unique to an independent listing (plus shared title/summary/methodology/team). */
export const INDEPENDENT_PROPOSAL_FIELDS = Object.freeze([
  ["title", "Proposal title", 160],
  ["summary", "Solution summary", 4000],
  ["methodology", "Technical approach", 4000],
  ["addressedProblems", "Problems this solution could address", 4000],
  ["team", "Team and relevant experience", 4000],
]);

export function isIndependentProposal(record) {
  return record?.proposalKind === INDEPENDENT_PROPOSAL_KIND;
}

/** Live listing window for comments and author edits. Uses this record's expiresAt, not a parent posting. */
export function independentListingWindowOpen(record, now = new Date()) {
  if (!isIndependentProposal(record)) return false;
  const status = String(record?.status ?? "");
  if (status !== "submitted" && status !== "under_review") return false;
  return !deadlinePassed(record.expiresAt, now);
}
