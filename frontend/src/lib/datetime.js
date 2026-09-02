/**
 * QCDAO-48 - one way to record and show an instant.
 *
 * Postings are read across organisations and time zones, so "1/9/2026" is
 * ambiguous (1 September or 9 January, and in whose day?) and a bare local time
 * says nothing about which offset it was written in. Everything stored and
 * displayed here is UTC, ISO-8601 ordered, to the nearest SECOND:
 *
 *     2026-12-01 09:30:00 UTC
 *
 * Seconds matter because `createdAt` is the audit record of when a funded problem
 * statement was posted, and `expiresAt` is the instant responses stop being
 * accepted. Rounding either to the minute would make two postings a few seconds
 * apart look simultaneous.
 *
 * These are pure functions on purpose - the countdown component is the only part
 * that needs a clock, and it passes `now` in.
 */

/**
 * Normalises the several shapes an instant arrives in: a Firestore Timestamp (has
 * toDate), a Date, an epoch number, or an ISO string. Returns null for anything
 * unusable, so callers render a placeholder instead of "Invalid Date".
 */
export function toDate(value) {
  if (value === null || value === undefined) return null;
  if (typeof value?.toDate === "function") {
    const converted = value.toDate();
    return Number.isNaN(converted.getTime()) ? null : converted;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Drops sub-second precision, so a stored instant is exact to the second. */
export function truncateToSecond(value) {
  const date = toDate(value);
  if (!date) return null;
  const truncated = new Date(date);
  truncated.setMilliseconds(0);
  return truncated;
}

function pad(number, width = 2) {
  return String(number).padStart(width, "0");
}

/**
 * The canonical display format. Not toISOString(): that renders
 * "2026-12-01T09:30:00.000Z", which carries milliseconds nobody needs and a T/Z
 * that reads as machine output. Same information, same ordering, legible.
 */
export function formatInstant(value) {
  const date = toDate(value);
  if (!date) return "—";
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

/** Date only, for places where the time of day would be noise. */
export function formatInstantDate(value) {
  const date = toDate(value);
  if (!date) return "—";
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} UTC`;
}

/**
 * Whole units remaining until `target`.
 *
 * `expired` is true the moment the target is reached or passed, matching the
 * posting rules: expiry is the instant responses stop, not the end of that second.
 */
export function countdownParts(target, now = new Date()) {
  const end = toDate(target);
  const from = toDate(now);
  if (!end || !from) return null;

  const remainingMs = end.getTime() - from.getTime();
  if (remainingMs <= 0) {
    return { expired: true, remainingMs: 0, days: 0, hours: 0, minutes: 0, seconds: 0 };
  }

  const totalSeconds = Math.floor(remainingMs / 1000);
  return {
    expired: false,
    remainingMs,
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

/**
 * Human countdown. Days are dropped once there are none left, so the last day
 * reads "04:33:12 left" rather than "0d 04h 33m 12s left" - the shorter string is
 * also the more urgent one, which is when it matters most.
 */
export function formatCountdown(target, now = new Date()) {
  const parts = countdownParts(target, now);
  if (!parts) return "—";
  if (parts.expired) return "Expired";

  const clock = `${pad(parts.hours)}:${pad(parts.minutes)}:${pad(parts.seconds)}`;
  return parts.days > 0 ? `${parts.days}d ${clock} left` : `${clock} left`;
}

export function isExpired(target, now = new Date()) {
  return countdownParts(target, now)?.expired ?? false;
}
