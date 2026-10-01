import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

export async function listAuditTrail(input) {
  requireFirebase();
  const { data } = await httpsCallable(functions, "listAuditTrail")(input);
  return data;
}
