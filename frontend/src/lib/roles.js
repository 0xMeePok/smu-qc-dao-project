// Access level, not a stakeholder capability. Every account is created as 0
// (platform user). 1 (administrator) and 2 (assigned evaluator) are set only
// through the Admin SDK — firestore.rules keeps `role` fixed at 0 on create and
// immutable on every client update, so no amount of frontend code can grant them.
import { ROLES } from "../config/roles.js";

export const ROLE_USER = 0;
export const ROLE_ADMIN = 1;
export const ROLE_EVALUATOR = 2;

export const ACCESS_LEVELS = [ROLE_USER, ROLE_EVALUATOR, ROLE_ADMIN];

const PARTICIPANT_CAPABILITIES = [ROLES.OWNER, ROLES.RESEARCHER, ROLES.FUNDER];
const EVALUATOR_CAPABILITIES = [ROLES.OWNER, ROLES.RESEARCHER, ROLES.EVALUATOR, ROLES.FUNDER];

export function isAdmin(role) {
  return role === ROLE_ADMIN;
}

export function isAssignedEvaluator(role) {
  return role === ROLE_EVALUATOR;
}

export function isAccessLevel(role) {
  return role === ROLE_USER || role === ROLE_ADMIN || role === ROLE_EVALUATOR;
}

export function roleLabel(role) {
  if (role === ROLE_ADMIN) return "Administrator";
  if (role === ROLE_EVALUATOR) return "Evaluator";
  return "User";
}

export function roleChipClass(role) {
  if (role === ROLE_ADMIN) return "role-chip-admin";
  if (role === ROLE_EVALUATOR) return "role-chip-evaluator";
  return "role-chip-user";
}

/** Stakeholder capabilities granted from the Firestore access level. */
export function capabilitiesForAccessLevel(role) {
  if (role === ROLE_ADMIN) return [ROLES.ADMIN];
  if (role === ROLE_EVALUATOR) return EVALUATOR_CAPABILITIES;
  return PARTICIPANT_CAPABILITIES;
}

export function primaryCapability(role) {
  if (role === ROLE_ADMIN) return ROLES.ADMIN;
  if (role === ROLE_EVALUATOR) return ROLES.EVALUATOR;
  return ROLES.OWNER;
}

/** Default target when an admin opens Change Role: assign evaluator, otherwise demote to user. */
export function defaultRoleAssignment(currentRole) {
  return currentRole === ROLE_USER ? ROLE_EVALUATOR : ROLE_USER;
}
