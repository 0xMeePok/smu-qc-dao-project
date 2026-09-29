import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { hashEscrowEvidence } from "./escrow.js";

function normalizeEvidence(evidence) {
  const summary = String(evidence?.summary ?? "").trim().normalize("NFC");
  const url = String(evidence?.url ?? "").trim();
  if (summary.length < 2 || summary.length > 4000) throw new Error("Describe the delivery evidence in 2–4,000 characters.");
  let parsed;
  try { parsed = new URL(url); } catch { /* Rejected below. */ }
  if (url.length > 2048 || !url.startsWith("https://") || parsed?.protocol !== "https:" || !parsed.hostname) {
    throw new Error("Provide an HTTPS evidence link of at most 2,048 characters.");
  }
  return { summary, url };
}

function evidenceRef(proposalId, evidenceHash) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(proposalId ?? "") || !/^0x[0-9a-f]{64}$/.test(evidenceHash ?? "")) {
    throw new Error("Invalid proposal evidence reference.");
  }
  return doc(db, "proposals", proposalId, "deliveryEvidence", evidenceHash);
}

/** Save readable evidence before its hash is submitted through the wallet. */
export async function saveEscrowEvidence({ proposalId, ownerId, evidence, evidenceHash }) {
  requireFirebase();
  const owner = String(ownerId ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(owner) || auth?.currentUser?.uid !== owner) {
    throw new Error("Sign in with the proposal owner's wallet to save delivery evidence.");
  }
  const normalized = normalizeEvidence(evidence);
  if (hashEscrowEvidence(normalized) !== evidenceHash) throw new Error("The evidence differs from its delivery hash.");
  const ref = evidenceRef(proposalId, evidenceHash);
  try {
    await setDoc(ref, { ...normalized, ownerId: owner, createdAt: serverTimestamp() });
  } catch (error) {
    // Immutable evidence may already exist after a wallet retry or a successful
    // write whose response was lost. Never overwrite it to refresh its timestamp.
    const existing = await getDoc(ref).catch(() => null);
    const saved = existing?.exists() ? existing.data() : null;
    if (!saved || saved.ownerId !== owner || saved.summary !== normalized.summary || saved.url !== normalized.url) throw error;
  }
  return { ...normalized, ownerId: owner };
}

/** A hash mismatch must never become readable evidence for an approval. */
export async function loadEscrowEvidence(proposalId, evidenceHash) {
  requireFirebase();
  const snapshot = await getDoc(evidenceRef(proposalId, evidenceHash));
  if (!snapshot.exists()) return null;
  const saved = snapshot.data();
  const evidence = normalizeEvidence(saved);
  if (saved.summary !== evidence.summary || saved.url !== evidence.url || hashEscrowEvidence(evidence) !== evidenceHash) {
    throw new Error("The saved delivery evidence does not match its on-chain hash.");
  }
  return { ...evidence, ownerId: saved.ownerId, createdAt: saved.createdAt };
}
