import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase.js";

// One metadata listener per visible resource/session. Content and financial
// records still come from their existing permission-checked readers.
const listeners = new Map();
export function subscribeToActivity({ proposalId, problemId, identity = "" }, channel, onChange) {
  const scope = proposalId ? "proposals" : "problems", id = proposalId || problemId;
  if (!db || !id || !["comments", "funding", "all"].includes(channel)) return () => {};
  const key = `${identity}:${scope}/${id}`;
  let entry = listeners.get(key);
  if (!entry) {
    entry = { subscribers: new Set(), previous: null, stop: null };
    listeners.set(key, entry);
    try { entry.stop = onSnapshot(doc(db, scope, id, "activity", "latest"), snapshot => {
      const data = snapshot.exists() ? snapshot.data() : {};
      const next = { comments: data.comments ?? 0, funding: data.funding ?? 0 };
      const previous = entry.previous;
      entry.previous = next;
      // The page performs its own initial read. Subsequent changes invalidate it.
      if (!previous) return;
      for (const subscriber of entry.subscribers) {
        if (subscriber.channel === "all"
          ? next.comments !== previous.comments || next.funding !== previous.funding
          : next[subscriber.channel] !== previous[subscriber.channel]) subscriber.onChange({ fundingSnapshot: data.fundingSnapshot ?? null });
      }
    }, () => { /* Visible-page fallback covers old deployments and reconnects. */ });
    } catch { /* An unavailable SDK/listener must not disable the ordinary reader. */ }
  }
  const subscriber = { channel, onChange };
  entry.subscribers.add(subscriber);
  return () => {
    entry.subscribers.delete(subscriber);
    if (!entry.subscribers.size) { entry.stop?.(); listeners.delete(key); }
  };
}
