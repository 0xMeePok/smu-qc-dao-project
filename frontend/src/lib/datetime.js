import { deadlinePassed } from "../../../firebase/functions/opportunityExpiry.js";

/** UTC date and countdown formatters. */

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
  if (deadlinePassed(end, from)) {
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

/** Format remaining time to the minute. */
export function formatCountdown(target, now = new Date()) {
  const parts = countdownParts(target, now);
  if (!parts) return "—";
  if (parts.expired) return "Expired";

  return `${parts.days}d ${pad(parts.hours)}h ${pad(parts.minutes)}m left`;
}

export function isExpired(target, now = new Date()) {
  return deadlinePassed(target, now);
}

/** Shared countdown urgency. */
export function expiryUrgency(target, now = new Date()) {
  const parts = countdownParts(target, now);
  if (!parts) return "unknown";
  if (parts.expired) return "expired";
  if (parts.remainingMs <= 48 * 60 * 60 * 1000) return "critical";
  if (parts.remainingMs <= 14 * 24 * 60 * 60 * 1000) return "approaching";
  return "normal";
}

export function expiryUrgencyLabel(urgency) {
  return {
    normal: "Open",
    approaching: "Approaching deadline",
    critical: "Deadline imminent",
    expired: "Expired",
    unknown: "Deadline unavailable",
  }[urgency] ?? "Deadline unavailable";
}
