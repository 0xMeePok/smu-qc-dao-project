/**
 * Idle-timeout bookkeeping for the wallet session.
 *
 * The session ends after 15 minutes of INACTIVITY, not 15 minutes after sign-in:
 * any interaction restarts the clock. An absolute 15-minute cap would sign people
 * out in the middle of a multi-step workflow, which is the exact thing session
 * persistence is here to prevent.
 *
 * The timestamp lives in localStorage so it survives a page reload - Firebase's own
 * session is persisted in IndexedDB and would otherwise come back with no memory of
 * when the user was last actually present, letting a tab reopened the next morning
 * restore a session that should have lapsed overnight.
 */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

// How often to re-check while the tab is open. Worst case a session outlives its
// deadline by this much, which is not worth a tighter loop; the check also runs on
// tab focus and visibility change, which covers the case that actually matters (a
// tab left in the background, where timers get throttled hard).
export const IDLE_CHECK_INTERVAL_MS = 30 * 1000;

const STORAGE_KEY = "qcdao.lastActivityAt";

// Activity fires constantly (every keystroke, every scroll tick). The stored value
// only matters at minute resolution, so writing more than twice a minute is pure
// churn on the main thread.
const WRITE_THROTTLE_MS = 30 * 1000;

let lastWriteAt = 0;

// Used when localStorage is unusable (private windows, storage disabled by policy,
// quota errors). The timeout still works for as long as the page stays open; it
// just cannot survive a reload. Failing that way keeps a broken-storage browser
// usable instead of signing the user out on every single page load.
let inMemoryLastActivity = null;

// `undefined` means storage itself is unusable; `null` means storage works and is
// simply empty. The difference decides whether an unknown value is safe to ignore.
function readRaw() {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return undefined;
  }
}

export function markActivity({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastWriteAt < WRITE_THROTTLE_MS) return;
  lastWriteAt = now;
  inMemoryLastActivity = now;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(now));
  } catch {
    // Storage unusable - inMemoryLastActivity above is the fallback.
  }
}

export function clearActivity() {
  lastWriteAt = 0;
  inMemoryLastActivity = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: a value we cannot remove is one we also cannot read back.
  }
}

/**
 * Milliseconds since the last recorded activity, or `null` when that cannot be
 * determined (no stored value, unreadable storage, or a corrupted entry).
 */
export function idleMs(now = Date.now()) {
  const raw = readRaw();

  if (raw === undefined) {
    return inMemoryLastActivity === null ? null : now - inMemoryLastActivity;
  }
  if (raw === null) return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;

  // A timestamp in the future means a clock change or a hand-edited value. Treating
  // it as "no information" is safer than trusting it, which would hold a session
  // open indefinitely.
  if (parsed > now) return null;

  return now - parsed;
}

/**
 * Deliberately returns false when idleness is unknown. An unknown value is not
 * evidence the user has been away, and signing someone out on a missing key would
 * make any storage hiccup look like a random logout. `hasActivityRecord()` is what
 * callers use to notice the missing record and start the clock instead.
 */
export function isIdleExpired(now = Date.now()) {
  const elapsed = idleMs(now);
  if (elapsed === null) return false;
  return elapsed >= IDLE_TIMEOUT_MS;
}

export function hasActivityRecord() {
  return idleMs() !== null;
}
