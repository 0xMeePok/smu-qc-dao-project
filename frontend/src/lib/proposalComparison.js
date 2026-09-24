import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { RECOMMENDATIONS } from "./comments.js";
import { proposalFundingLabel } from "./matching.js";
import { PROPOSAL_CATEGORIES } from "../config/proposal.js";

export const COMPARISON_SORTS = [
  ["title:asc", "Title A–Z"],
  ["title:desc", "Title Z–A"],
  ["developer:asc", "Developer A–Z"],
  ["developer:desc", "Developer Z–A"],
  ["organisation:asc", "Organisation A–Z"],
  ["organisation:desc", "Organisation Z–A"],
  ["category:asc", "Category A–Z"],
  ["category:desc", "Category Z–A"],
  ["amount:asc", "Requested funding low–high"],
  ["amount:desc", "Requested funding high–low"],
  ["qualifyingCount:asc", "Qualifying comments few–many"],
  ["qualifyingCount:desc", "Qualifying comments many–few"],
  ["commentCount:asc", "Comments few–many"],
  ["commentCount:desc", "Comments many–few"],
  ["status:asc", "Status A–Z"],
  ["status:desc", "Status Z–A"],
];

const SORT_KEYS = new Set(COMPARISON_SORTS.map(([id]) => id.split(":")[0]));

export function categoryLabel(value) {
  return PROPOSAL_CATEGORIES.find((item) => item.value === value)?.label || value || "Unspecified category";
}

export function recommendationSummary(row) {
  if (!row?.qualifyingCount) return "No qualifying recommendation";
  return RECOMMENDATIONS.map(([id, label]) => `${row.recommendations?.[id] || 0} ${label}`).join(" · ");
}

export function filterComparisonRows(rows, outcome) {
  const list = rows ?? [];
  if (!outcome || !RECOMMENDATIONS.some(([id]) => id === outcome)) return list;
  return list.filter((row) => (row.recommendations?.[outcome] || 0) > 0);
}

function sortValue(row, key, problemMatching) {
  if (key === "developer") return (row.developerName || "").toLowerCase();
  if (key === "organisation") return (row.organisation || "").toLowerCase();
  if (key === "category") return categoryLabel(row.category).toLowerCase();
  if (key === "amount") return Number(row.amount) || 0;
  if (key === "qualifyingCount") return row.qualifyingCount || 0;
  if (key === "commentCount") return row.commentCount || 0;
  if (key === "status") return proposalFundingLabel(row, problemMatching).toLowerCase();
  return String(row.title || "").toLowerCase();
}

export function sortComparisonRows(rows, sortId, problemMatching) {
  const [rawKey, rawDirection] = String(sortId || "title:asc").split(":");
  const allowed = SORT_KEYS.has(rawKey);
  const key = allowed ? rawKey : "title";
  const factor = allowed && rawDirection === "desc" ? -1 : 1;
  return [...(rows ?? [])].sort((left, right) => {
    const leftValue = sortValue(left, key, problemMatching);
    const rightValue = sortValue(right, key, problemMatching);
    if (leftValue < rightValue) return -1 * factor;
    if (leftValue > rightValue) return 1 * factor;
    return String(left.title).localeCompare(String(right.title)) || String(left.id).localeCompare(String(right.id));
  });
}

export async function getProposalComparison(problemId) {
  requireFirebase();
  return (await httpsCallable(functions, "getProposalComparison")({ problemId })).data;
}

export function comparisonError(error) {
  const code = String(error?.code || "").split("/").pop();
  if (code === "unauthenticated") return "Sign in again to continue.";
  if (["invalid-argument", "permission-denied", "failed-precondition", "not-found"].includes(code)) return error.message;
  return "The proposal comparison could not be loaded. Refresh and try again.";
}
