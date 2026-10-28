import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

/** Lists proposals an administrator can export, accepted or not. */
export async function listExportableProposals() {
  requireFirebase();
  const callable = httpsCallable(functions, "adminListExportProposals");
  const response = await callable({});
  return response.data;
}

/** Downloads one proposal, or every non-draft proposal created in a UTC date range. */
export async function exportSelectedProposals(input) {
  requireFirebase();
  const callable = httpsCallable(functions, "adminExportSelectedProposals");
  const response = await callable(input);
  return response.data;
}
