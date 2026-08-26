import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  IDLE_TIMEOUT_MS,
  clearActivity,
  hasActivityRecord,
  idleMs,
  isIdleExpired,
  markActivity,
} from "../src/lib/idleTimeout.js";

// The module reads window.localStorage lazily inside each function rather than at
// import time, so a stub installed here is picked up for every call below.
function installStorage({ broken = false } = {}) {
  const store = new Map();
  // Write counter, so a test can assert on how often storage was actually touched
  // rather than inferring it from a value that may not have changed.
  const writes = { count: 0 };
  globalThis.window = {
    localStorage: {
      getItem(key) {
        if (broken) throw new Error("storage disabled");
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        if (broken) throw new Error("storage disabled");
        writes.count += 1;
        store.set(key, String(value));
      },
      removeItem(key) {
        if (broken) throw new Error("storage disabled");
        store.delete(key);
      },
    },
  };
  return { store, writes };
}

describe("idle timeout", () => {
  beforeEach(() => {
    installStorage();
    clearActivity();
  });

  it("is a 15 minute window", () => {
    assert.equal(IDLE_TIMEOUT_MS, 15 * 60 * 1000);
  });

  it("reports no idle time before any activity is recorded", () => {
    assert.equal(idleMs(), null);
    assert.equal(hasActivityRecord(), false);
  });

  it("records activity and reports a fresh session as not expired", () => {
    markActivity({ force: true });
    assert.equal(hasActivityRecord(), true);
    assert.ok(idleMs() < 1000);
    assert.equal(isIdleExpired(), false);
  });

  it("expires once the idle window has fully elapsed", () => {
    markActivity({ force: true });
    const wayLater = Date.now() + IDLE_TIMEOUT_MS + 1;
    assert.equal(isIdleExpired(wayLater), true);
  });

  it("does not expire one moment before the deadline", () => {
    markActivity({ force: true });
    const justBefore = Date.now() + IDLE_TIMEOUT_MS - 1000;
    assert.equal(isIdleExpired(justBefore), false);
  });

  it("resets the clock when activity happens, which is what makes it idle-based", () => {
    // The whole point of an idle timeout rather than an absolute one: a user still
    // working must not be signed out just because 15 minutes passed since login.
    const { store } = installStorage();
    clearActivity();

    const longAgo = Date.now() - (IDLE_TIMEOUT_MS - 1000);
    store.set("qcdao.lastActivityAt", String(longAgo));
    assert.equal(isIdleExpired(), false);

    markActivity({ force: true });
    // Where the old timestamp would have expired seconds later, the refreshed one
    // has the full window ahead of it again.
    assert.equal(isIdleExpired(Date.now() + 2000), false);
  });

  it("throttles writes but still honours a forced one", () => {
    // Counts setItem CALLS rather than comparing stored values. The value-comparison
    // version of this test passed even with the throttle deleted: two markActivity()
    // calls on adjacent lines usually land in the same millisecond, so Date.now()
    // returns the same number and the "unchanged" assertion holds for the wrong
    // reason. Counting writes is what actually distinguishes throttled from not.
    const { writes } = installStorage();
    clearActivity();

    markActivity({ force: true });
    assert.equal(writes.count, 1, "a forced write always lands");

    markActivity();
    markActivity();
    markActivity();
    assert.equal(writes.count, 1, "unforced writes inside the window are dropped");

    markActivity({ force: true });
    assert.equal(writes.count, 2, "force still bypasses the throttle");
  });

  it("clears the record on sign-out", () => {
    markActivity({ force: true });
    assert.equal(hasActivityRecord(), true);

    clearActivity();
    assert.equal(hasActivityRecord(), false);
    assert.equal(isIdleExpired(), false);
  });

  it("treats a corrupted timestamp as unknown rather than expired", () => {
    const { store } = installStorage();
    clearActivity();
    store.set("qcdao.lastActivityAt", "not-a-number");

    assert.equal(idleMs(), null);
    assert.equal(isIdleExpired(), false);
  });

  it("ignores a timestamp from the future instead of trusting it", () => {
    // A clock change or hand-edited value would otherwise hold a session open
    // indefinitely, since `now - future` is negative and never reaches the window.
    const { store } = installStorage();
    clearActivity();
    store.set("qcdao.lastActivityAt", String(Date.now() + 60 * 60 * 1000));

    assert.equal(idleMs(), null);
    assert.equal(isIdleExpired(), false);
  });

  it("keeps working in-memory when storage throws, without expiring on every call", () => {
    // Private windows and locked-down browsers throw on localStorage access. The
    // session should survive that, not be killed on sight.
    installStorage({ broken: true });
    clearActivity();

    assert.equal(isIdleExpired(), false);

    markActivity({ force: true });
    assert.equal(isIdleExpired(), false);
    assert.equal(isIdleExpired(Date.now() + IDLE_TIMEOUT_MS + 1), true);
  });
});
