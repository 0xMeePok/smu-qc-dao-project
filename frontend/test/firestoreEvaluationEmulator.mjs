import { initializeApp, deleteApp } from "firebase/app";
import { connectFirestoreEmulator, getFirestore } from "firebase/firestore";
import { createEvaluation } from "../src/lib/evaluations.js";

// Rules tests use a separately installed Firebase SDK. Initialize the real
// frontend SDK here so production helper calls receive their own SDK instance.
export async function createEvaluationInEmulator({ uid, projectId, evaluationId, record }) {
  const app = initializeApp({ projectId, apiKey: "demo-key" }, `evaluation-sdk-${Date.now()}`);
  const db = getFirestore(app);
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":");
  connectFirestoreEmulator(db, host, Number(port), { mockUserToken: { sub: uid, user_id: uid, auth_time: 1 } });
  try { return await createEvaluation(db, evaluationId, record); }
  finally { await deleteApp(app); }
}
