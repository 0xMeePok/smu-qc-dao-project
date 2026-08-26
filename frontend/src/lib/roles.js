// Access level, not a stakeholder role. Every account is 0 (normal user) unless
// deliberately flipped to 1 (administrator) directly in Firestore - the client can
// never set this itself. See firebase/firestore.rules: `role` is fixed to 0 on
// create and immutable on every update from a client, so self-promotion to admin
// is not something any amount of frontend code can do.
export const ROLE_USER = 0;
export const ROLE_ADMIN = 1;

export function isAdmin(role) {
  return role === ROLE_ADMIN;
}

export function roleLabel(role) {
  return isAdmin(role) ? "Administrator" : "User";
}
