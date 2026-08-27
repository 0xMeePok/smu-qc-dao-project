import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

/**
 * Invokes the adminListUsers Cloud Function.
 */
export async function fetchAdminUsers(params = {}) {
  requireFirebase();
  const adminListUsers = httpsCallable(functions, "adminListUsers");
  const response = await adminListUsers(params);
  return response.data;
}

/**
 * Invokes the adminChangeRole Cloud Function.
 */
export async function updateUserRole({ targetAddress, newRole, reason }) {
  requireFirebase();
  const adminChangeRole = httpsCallable(functions, "adminChangeRole");
  const response = await adminChangeRole({ targetAddress, newRole, reason });
  return response.data;
}

/**
 * Invokes the adminSetSuspended Cloud Function.
 */
export async function setUserSuspension({ targetAddress, suspended, reason }) {
  requireFirebase();
  const adminSetSuspended = httpsCallable(functions, "adminSetSuspended");
  const response = await adminSetSuspended({ targetAddress, suspended, reason });
  return response.data;
}
