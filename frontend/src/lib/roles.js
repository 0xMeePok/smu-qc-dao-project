// Single source of truth for the five stakeholder roles. The identifiers here are
// mirrored in firebase/firestore.rules; change both together or registration will
// be rejected server side.
export const roles = [
  {
    value: "problem-owner",
    label: "Problem owner",
    note: "Publish problem statements and review incoming proposals.",
  },
  {
    value: "funder",
    label: "Funder",
    note: "Commit funding to problems and approve delivery stages.",
  },
  {
    value: "researcher",
    label: "Researcher",
    note: "Submit proposals and deliver funded research work.",
  },
  {
    value: "evaluator",
    label: "Evaluator",
    note: "Assess proposals and record independent evaluations.",
  },
  {
    value: "observer",
    label: "Observer",
    note: "Follow the audit trail without taking part in decisions.",
  },
];

export const roleValues = roles.map((role) => role.value);

// Assigned at account creation before the user has actually chosen a role on the
// role-selection screen. "Observer" is the lowest-privilege option, so defaulting to
// it before that explicit choice grants nothing. Firestore's create rule requires a
// valid role from day one (an empty/unset value is not in the allowed list), so
// something has to be written here.
export const DEFAULT_ROLE = "observer";

export function roleLabel(value) {
  return roles.find((role) => role.value === value)?.label ?? value;
}
