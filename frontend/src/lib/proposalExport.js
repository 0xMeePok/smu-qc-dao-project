import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

/** Downloads one accepted posting, or every accepted posting in a UTC date range. */
export async function exportSelectedProposals(input) {
  requireFirebase();
  const callable = httpsCallable(functions, "adminExportSelectedProposals");
  const response = await callable(input);
  return response.data;
}
