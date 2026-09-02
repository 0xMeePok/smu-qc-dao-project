import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countdownParts,
  formatCountdown,
  formatInstant,
  formatInstantDate,
  isExpired,
} from "../../src/lib/datetime.js";
import { expiryDateFrom } from "../../src/config/postingCategories.js";

/**
 * QCDAO-48 - instants are recorded and displayed in one global format, to the
 * nearest second, so a posting read from another time zone is unambiguous.
 */

function firestoreTimestamp(date) {
  return { toDate: () => date };
}

describe("[QCDAO-48] instant formatting", () => {
  it("[FUT-OPD-084] renders UTC to the nearest second in a sortable order", () => {
    assert.equal(
      formatInstant(new Date("2026-12-01T09:30:45.678Z")),
      "2026-12-01 09:30:45 UTC",
    );
  });

  it("[FUT-OPD-085] accepts a Firestore Timestamp", () => {
    assert.equal(
      formatInstant(firestoreTimestamp(new Date("2026-12-01T09:30:45Z"))),
      "2026-12-01 09:30:45 UTC",
    );
  });

  it("[FUT-OPD-086] shows a placeholder rather than 'Invalid Date'", () => {
    for (const value of [null, undefined, "not a date", NaN]) {
      assert.equal(formatInstant(value), "—", `${String(value)} should render as a dash`);
    }
    assert.equal(formatInstantDate(null), "—");
  });

  it("[FUT-OPD-087] stores an expiry with no milliseconds", () => {
    const expiry = expiryDateFrom(90, new Date("2026-09-01T10:00:00.512Z"));
    assert.equal(expiry.getMilliseconds(), 0);
  });
});

describe("[QCDAO-48] expiry countdown", () => {
  const now = new Date("2026-09-01T00:00:00Z");

  it("[FUT-OPD-088] formats days plus a clock while more than a day remains", () => {
    assert.equal(formatCountdown(new Date("2026-09-13T04:33:12Z"), now), "12d 04:33:12 left");
  });

  it("[FUT-OPD-089] drops the day part inside the final day", () => {
    assert.equal(formatCountdown(new Date("2026-09-01T04:33:12Z"), now), "04:33:12 left");
  });

  it("[FUT-OPD-090] reports expiry at the instant itself, not a second later", () => {
    assert.equal(isExpired(now, now), true);
    assert.equal(formatCountdown(now, now), "Expired");
  });

  it("[FUT-OPD-091] handles a missing expiry without throwing", () => {
    assert.equal(countdownParts(null, now), null);
    assert.equal(formatCountdown(null, now), "—");
    assert.equal(isExpired(null, now), false);
  });
});
