import { describe, it } from "node:test";
import assert from "node:assert/strict";

function resolveLogoutOutcome({ reason = null, redirectToLogin = false } = {}) {
  return {
    message:
      reason === "idle"
        ? "You were signed out after 15 minutes of inactivity. Sign in again to continue."
        : null,
    destination: redirectToLogin ? "login" : null,
  };
}

describe("Unit Tests: Logout Outcome Rules", () => {
  it("[FUT-AAR-084] should redirect manual logout to login without idle-timeout message", () => {
    assert.deepEqual(resolveLogoutOutcome({ redirectToLogin: true }), {
      message: null,
      destination: "login",
    });
  });

  it("[FUT-AAR-085] should keep idle-timeout message without forcing manual login redirect", () => {
    assert.deepEqual(resolveLogoutOutcome({ reason: "idle" }), {
      message: "You were signed out after 15 minutes of inactivity. Sign in again to continue.",
      destination: null,
    });
  });
});
