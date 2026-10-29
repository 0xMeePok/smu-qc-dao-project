import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

export const AI_QUOTA_LIMITS = Object.freeze({ perMinute: 3, perDay: 20, globalPerDay: 200, leaseMs: 90000 });
export const AI_RETRIEVAL_LIMITS = Object.freeze({ perMinute: 10, perDay: 100, globalPerDay: 2000, leaseMs: 60000 });
const fail = (code, message) => { throw new HttpsError(code, message); };
const hash = value => createHash("sha256").update(value).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function reserve({ db, uid, requestId, now = Date.now(), mode = "draft" }) {
  if (!/^0x[0-9a-f]{40}$/.test(uid ?? "")) fail("unauthenticated", "Sign in to use AI assistance.");
  if (!UUID.test(requestId ?? "")) fail("invalid-argument", "Start a new request and try again.");
  const limits = mode === "retrieval" ? AI_RETRIEVAL_LIMITS : AI_QUOTA_LIMITS;
  const memberHash = hash(uid), requestHash = hash(`${mode}:${uid}:${requestId}`);
  const day = new Date(now).toISOString().slice(0, 10);
  const userRef = db.collection("aiUsage").doc(`${mode}_${memberHash}`);
  const globalRef = db.collection("aiUsage").doc(mode === "draft" ? `global_${day}` : `retrieval_global_${day}`);
  const requestRef = db.collection("aiRequests").doc(requestHash);
  return db.runTransaction(async tx => {
    const [userSnap, globalSnap, previous] = await Promise.all([tx.get(userRef), globalRef ? tx.get(globalRef) : null, tx.get(requestRef)]);
    if (previous.exists) fail("already-exists", "This AI request has already been received. Start a new request to continue.");
    const user = userSnap.data() ?? {}, global = globalSnap?.data() ?? {};
    if (user.leaseUntil > now) fail("resource-exhausted", "An AI request is already running. Wait for it to finish.");
    const minute = Array.isArray(user.minute) ? user.minute.filter(value => Number.isFinite(value) && value > now - 60000) : [];
    const used = user.day === day && Number.isSafeInteger(user.used) ? user.used : 0;
    if (minute.length >= limits.perMinute) fail("resource-exhausted", "Too many requests. Wait a minute before trying again.");
    if (used >= limits.perDay) fail("resource-exhausted", mode === "retrieval" ? "Your similar-proposal search limit has been reached for today." : "You have used today's 20 AI requests. You can continue editing by hand.");
    if ((global.used ?? 0) >= limits.globalPerDay) fail("resource-exhausted", mode === "retrieval" ? "Similar-proposal search has reached today's platform limit. You can continue writing." : "AI assistance has reached today's platform limit. You can continue editing by hand.");
    const expiresAt = Timestamp.fromMillis(now + 7 * 86400000);
    tx.set(userRef, { day, used: used + 1, minute: [...minute, now], leaseUntil: now + limits.leaseMs, leaseId: requestHash, expiresAt });
    if (globalRef) tx.set(globalRef, { day, used: (global.used ?? 0) + 1, expiresAt });
    // Only request metadata is stored; never form text, chat, or model output.
    tx.create(requestRef, { mode, memberHash, startedAt: Timestamp.fromMillis(now), expiresAt });
    return { memberHash, requestHash, mode, remainingToday: limits.perDay - used - 1 };
  });
}
export const reserveAIQuota = options => reserve({ ...options, mode: "draft" });
export const reserveRetrievalQuota = options => reserve({ ...options, mode: "retrieval" });
export async function releaseAIQuota({ db, reservation, now = Date.now() }) {
  if (!reservation) return;
  const ref = db.collection("aiUsage").doc(`${reservation.mode}_${reservation.memberHash}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.data()?.leaseId === reservation.requestHash) tx.update(ref, { leaseUntil: 0, leaseId: null });
    const requestRef = db.collection("aiRequests").doc(reservation.requestHash);
    tx.update(requestRef, { finishedAt: Timestamp.fromMillis(now) });
  });
}
