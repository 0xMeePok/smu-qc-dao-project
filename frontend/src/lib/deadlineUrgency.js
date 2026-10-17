import { countdownParts, expiryUrgency } from "./datetime.js";

/** Selection acceptance, grant offers and upfront escrow approval all run for seven days. */
export const ACCEPTANCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A windowed deadline is "approaching" only in the last quarter of its window. */
export const APPROACHING_WINDOW_SHARE = 0.25;

/**
 * The shared countdown urgency, made relative for short windows. The posting
 * rule (approaching inside 14 days, imminent inside 48 hours) would flag every
 * seven-day window as approaching from its first minute, so "6d 23h left"
 * read as urgent. With a known window, "approaching" starts once 25% of it is
 * left (42 hours for seven days, so the 48-hour "Deadline imminent" stage
 * arrives first); the imminent and expired stages are unchanged.
 */
export function deadlineUrgency(target, now = new Date(), { windowMs } = {}) {
  const urgency = expiryUrgency(target, now);
  if (urgency !== "approaching" || !(Number(windowMs) > 0)) return urgency;
  const parts = countdownParts(target, now);
  return parts && parts.remainingMs <= Number(windowMs) * APPROACHING_WINDOW_SHARE ? "approaching" : "normal";
}
