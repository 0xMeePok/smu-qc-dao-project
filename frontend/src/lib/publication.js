import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";

export async function reserveResource(scope, recordId) {
  await httpsCallable(functions, "reserveResource")({ scope, recordId });
}

export async function attestPublication(scope, recordId, record) {
  const { id, createdAt, updatedAt, ...content } = record;
  if (content.expiresAt?.toDate) content.expiresAt = content.expiresAt.toDate().toISOString();
  else if (content.expiresAt instanceof Date) content.expiresAt = content.expiresAt.toISOString();
  await httpsCallable(functions, "attestPublication")({ scope, recordId, record: content });
}
