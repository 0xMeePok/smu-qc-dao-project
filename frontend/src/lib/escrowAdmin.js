import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";

async function call(name, payload) {
  requireFirebase();
  return (await httpsCallable(functions, name)(payload)).data;
}
export const getEscrowAdminCancellation = payload => call("getEscrowAdminCancellation", payload);
export const startEscrowAdminCancellation = payload => call("startEscrowAdminCancellation", payload);
