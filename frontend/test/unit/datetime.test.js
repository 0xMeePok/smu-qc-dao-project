import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countdownParts,
  formatCountdown,
  formatInstant,
  formatInstantDate,
  isExpired,
  toDate,
  truncateToSecond,
} from "../../src/lib/datetime.js";
import { expiryDateFrom } from "../../src/config/postingCategories.js";

/**
 * QCDAO-48 - instants are recorded and displayed in one global format, to the
 * nearest second, so a posting read from another time zone is unambiguous.
 */

// Stands in for a Firestore Timestamp, which is what these values really are.
function firestoreTimestamp(date) {
  return { toDate: () => date };
}

describe("[QCDAO-48] instant formatting", () => {
  it("[FUT-DT-01] renders UTC to the nearest second in a sortable order", () => {
    assert.equal(
      formatInstant(new Date("2026-12-01T09:30:45.678Z")),
      "2026-12-01 09:30:45 UTC",
    );
  });

  it("[FUT-DT-02] renders the same instant regardless of the reader's zone", () => {
    // The point of the format: this is one instant, and it must read identically
    // whether the viewer is in Singapore or California.
    const instant = new Date("2026-12-01T09:30:45Z");
    assert.equal(formatInstant(instant), "2026-12-01 09:30:45 UTC");
    assert.equal(formatInstant(instant.toISOString()), "2026-12-01 09:30:45 UTC");
    assert.equal(formatInstant(instant.getTime()), "2026-12-01 09:30:45 UTC");
  });

  it("[FUT-DT-03] accepts a Firestore Timestamp", () => {
    assert.equal(
      formatInstant(firestoreTimestamp(new Date("2026-12-01T09:30:45Z"))),
      "2026-12-01 09:30:45 UTC",
    );
  });

  it("[FUT-DT-04] shows a placeholder rather than 'Invalid Date'", () => {
    for (const value of [null, undefined, "not a date", NaN]) {
      assert.equal(formatInstant(value), "—", `${String(value)} should render as a dash`);
    }
    assert.equal(formatInstantDate(null), "—");
  });

  it("[FUT-DT-05] keeps second precision, so near-simultaneous postings differ", () => {
    const first = formatInstant(new Date("2026-12-01T09:30:45Z"));
    const second = formatInstant(new Date("2026-12-01T09:30:46Z"));
    assert.notEqual(first, second);
  });

  it("[FUT-DT-06] normalises every accepted shape to a Date", () => {
    const instant = new Date("2026-12-01T09:30:45Z");
    assert.equal(toDate(instant).getTime(), instant.getTime());
    assert.equal(toDate(firestoreTimestamp(instant)).getTime(), instant.getTime());
    assert.equal(toDate("nonsense"), null);
  });

  it("[FUT-DT-07] truncates sub-second precision", () => {
    assert.equal(truncateToSecond(new Date("2026-12-01T09:30:45.999Z")).getMilliseconds(), 0);
  });

  it("[FUT-DT-08] stores an expiry with no milliseconds", () => {
    // Two postings submitted in the same second must carry the same expiry, not
    // two that differ by a few hundred milliseconds nobody can see.
    const expiry = expiryDateFrom(90, new Date("2026-09-01T10:00:00.512Z"));
    assert.equal(expiry.getMilliseconds(), 0);
  });
});

describe("[QCDAO-48] expiry countdown", () => {
  const now = new Date("2026-09-01T00:00:00Z");

  it("[FUT-DT-09] breaks the remaining time into whole units", () => {
    const target = new Date("2026-09-13T04:33:12Z");
    assert.deepEqual(countdownParts(target, now), {
      expired: false, remainingMs: target - now, days: 12, hours: 4, minutes: 33, seconds: 12,
    });
  });

  it("[FUT-DT-10] formats days plus a clock while more than a day remains", () => {
    assert.equal(formatCountdown(new Date("2026-09-13T04:33:12Z"), now), "12d 04:33:12 left");
  });

  it("[FUT-DT-11] drops the day part inside the final day", () => {
    assert.equal(formatCountdown(new Date("2026-09-01T04:33:12Z"), now), "04:33:12 left");
  });

  it("[FUT-DT-12] pads every unit so the countdown does not jitter in width", () => {
    assert.equal(formatCountdown(new Date("2026-09-01T01:02:03Z"), now), "01:02:03 left");
  });

  it("[FUT-DT-13] reports expiry at the instant itself, not a second later", () => {
    // Expiry is the moment responses stop being accepted, so the boundary is
    // inclusive - at exactly the expiry time the posting is already closed.
    assert.equal(isExpired(now, now), true);
    assert.equal(formatCountdown(now, now), "Expired");
  });

  it("[FUT-DT-14] reports a past expiry as expired", () => {
    const past = new Date("2026-08-31T23:59:59Z");
    assert.equal(isExpired(past, now), true);
    assert.deepEqual(countdownParts(past, now), {
      expired: true, remainingMs: 0, days: 0, hours: 0, minutes: 0, seconds: 0,
    });
  });

  it("[FUT-DT-15] counts down second by second", () => {
    const target = new Date("2026-09-01T00:01:00Z");
    assert.equal(formatCountdown(target, now), "00:01:00 left");
    assert.equal(formatCountdown(target, new Date("2026-09-01T00:00:01Z")), "00:00:59 left");
  });

  it("[FUT-DT-16] handles a missing expiry without throwing", () => {
    assert.equal(countdownParts(null, now), null);
    assert.equal(formatCountdown(null, now), "—");
    assert.equal(isExpired(null, now), false);
  });
});
