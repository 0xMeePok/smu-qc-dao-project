import {
  listModerationNotifications,
  markAllModerationNotificationsRead,
  markModerationNotificationRead,
  moderationError,
} from "./moderation.js";

/**
 * QCDAO-68. One copy of the signed-in member's notice feed, shared by the
 * header bell and the Profile page so both show the same items, unread count
 * and read state. Each mount used to fetch once on its own: the bell mounted
 * at sign-in and never fetched again, so notices written later (and any first
 * fetch that lost a race with session setup) left it on "No content notices."
 * while the Profile page, mounted later, listed them.
 *
 * The server callable stays the only reader: `moderationNotifications` is
 * closed to clients in firestore.rules.
 */
export const NOTIFICATION_REFRESH_MS = 120_000;
const FRESH_MS = 2_000;
const RETRY_MS = 5_000;

const EMPTY = Object.freeze({ userId: null, items: [], loaded: false, loading: false, error: "", busy: null });
let state = EMPTY;
let generation = 0;
let inflight = null;
let loadedAt = 0;
let retryTimer = null;
const listeners = new Set();

function emit(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function clearRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

export function subscribeNotifications(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function notificationSnapshot() {
  return state;
}

/** Switching or clearing the account drops the previous member's notices at once. */
export function setNotificationUser(userId) {
  const next = userId || null;
  if (state.userId === next) return false;
  generation += 1;
  inflight = null;
  loadedAt = 0;
  clearRetry();
  state = { ...EMPTY, userId: next };
  for (const listener of listeners) listener();
  return true;
}

/**
 * Concurrent callers share one request. A failed load keeps the last good
 * list, shows the error, and retries once shortly after: the first fetch can
 * run before the session's App Check or ID token is ready.
 */
export function refreshNotifications({ force = false, retry = true } = {}) {
  if (!state.userId) return Promise.resolve();
  if (inflight) return inflight;
  if (!force && state.loaded && Date.now() - loadedAt < FRESH_MS) return Promise.resolve();
  const version = generation;
  clearRetry();
  emit({ loading: true });
  inflight = listModerationNotifications()
    .then((data) => {
      if (version !== generation) return;
      loadedAt = Date.now();
      emit({ items: Array.isArray(data?.items) ? data.items : [], loaded: true, loading: false, error: "" });
    })
    .catch((err) => {
      if (version !== generation) return;
      emit({ loading: false, error: moderationError(err) });
      if (retry) retryTimer = setTimeout(() => { retryTimer = null; refreshNotifications({ force: true, retry: false }); }, RETRY_MS);
    })
    .finally(() => { if (version === generation) inflight = null; });
  return inflight;
}

async function acknowledge(busy, request, update) {
  const version = generation;
  emit({ busy, error: "" });
  try {
    await request();
    if (version === generation) emit({ items: state.items.map(update) });
  } catch (err) {
    if (version === generation) emit({ error: moderationError(err) });
  } finally {
    if (version === generation) emit({ busy: null });
  }
}

/** Read state changes only after the server acknowledges it, in every view at once. */
export function markNotificationRead(id) {
  return acknowledge(id, () => markModerationNotificationRead(id), (item) => (item.id === id ? { ...item, read: true } : item));
}

export function markAllNotificationsRead() {
  return acknowledge("all", () => markAllModerationNotificationsRead(), (item) => ({ ...item, read: true }));
}

/** Test seam: forget the shared feed between isolated renders. */
export function resetNotificationStore() {
  generation += 1;
  inflight = null;
  loadedAt = 0;
  clearRetry();
  state = EMPTY;
  for (const listener of listeners) listener();
}
