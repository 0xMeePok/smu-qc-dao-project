import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

/** QCDAO-140 - platform activity counts for the administrator overview. */
export async function fetchAdminActivity() {
  requireFirebase();
  const { data } = await httpsCallable(functions, "adminGetActivitySummary")({});
  return data;
}

/**
 * Escrow targets are exact on-chain base units and arrive as a decimal string,
 * so they are never parsed into a JS number. Grouping digits is presentation
 * only; the value itself is passed through untouched.
 */
export function formatBaseUnits(value) {
  const digits = String(value ?? "0").replace(/[^0-9]/g, "") || "0";
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
