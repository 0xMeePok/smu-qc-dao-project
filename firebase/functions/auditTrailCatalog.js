/** QCDAO-96 / QCDAO-97 filter vocabulary. Shared by the callable and the trail UI. */

export const AUDIT_EVENT_OPTIONS = Object.freeze([
  ["proposal_submitted", "Proposal submission"],
  ["evaluator_recommendation", "Evaluator recommendation"],
  ["decision_recorded", "Decision recorded"],
  ["selection", "Selection"],
  ["owner_approval", "Owner approval"],
  ["owner_decline", "Owner decline"],
  ["solution_owner_approval", "Solution owner approval"],
  ["solution_owner_decline", "Solution owner decline"],
  ["invalidation", "Invalidation"],
  ["moderation", "Moderation action"],
  ["expiry", "Expiry"],
  ["funding_status", "Funding status change"],
  ["governance", "Role and account changes"],
]);

export const ACTOR_ROLE_OPTIONS = Object.freeze([
  ["problem_owner", "Problem owner"],
  ["proposal_creator", "Solution owner"],
  ["evaluator", "Evaluator"],
  ["funder", "Funder"],
  ["admin", "Administrator"],
  ["member", "Member"],
  ["system", "System"],
]);

export const VERIFICATION_OPTIONS = Object.freeze([
  ["anchored", "Anchored on-chain"],
  ["pending", "Verification pending"],
  ["failed", "Verification failed"],
  ["off_chain", "Off-chain record"],
]);

export const RECOMMENDATION_VALUES = Object.freeze([
  "recommend",
  "recommend_with_revisions",
  "do_not_recommend",
]);

export const AUDIT_EVENT_IDS = new Set(AUDIT_EVENT_OPTIONS.map(([id]) => id));
export const ACTOR_ROLE_IDS = new Set(ACTOR_ROLE_OPTIONS.map(([id]) => id));
export const VERIFICATION_IDS = new Set(VERIFICATION_OPTIONS.map(([id]) => id));

const ROLE_LABELS = Object.fromEntries(ACTOR_ROLE_OPTIONS);
const VERIFY_LABELS = Object.fromEntries(VERIFICATION_OPTIONS);

export function actorRoleLabel(role) {
  return ROLE_LABELS[role] || "Member";
}

export function verificationLabel(status) {
  return VERIFY_LABELS[status] || "Off-chain record";
}
