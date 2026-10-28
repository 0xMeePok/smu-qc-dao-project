/** Copy shared by the export file and the admin screen. QCDAO-107. */
export const EXPORT_SCHEMA_VERSION = 2;

export const EXPORT_NOTICE = "Grading and token distribution happen outside QC DAO. This file is the record the sponsor uses. It does not calculate grades, token amounts, or evaluator scores.";

/** Latest civil date already reached anywhere. Kiribati is UTC+14. */
export const LATEST_UTC_OFFSET_MINUTES = 14 * 60;
/** Earliest civil date still current anywhere. The Baker Island offset is UTC−12. */
export const EARLIEST_UTC_OFFSET_MINUTES = -12 * 60;

function instant(now) {
  if (now?.toMillis) return now.toMillis();
  if (now instanceof Date) return now.getTime();
  const parsed = Date.parse(now ?? "");
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function civilDate(now, offsetMinutes) {
  return new Date(instant(now) + offsetMinutes * 60 * 1000).toISOString().slice(0, 10);
}

/** The latest YYYY-MM-DD that is already today somewhere. */
export function latestCurrentDate(now = new Date()) {
  return civilDate(now, LATEST_UTC_OFFSET_MINUTES);
}

/** The earliest YYYY-MM-DD that is still today somewhere. */
export function earliestCurrentDate(now = new Date()) {
  return civilDate(now, EARLIEST_UTC_OFFSET_MINUTES);
}
