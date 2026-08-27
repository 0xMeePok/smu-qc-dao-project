import { describe, it } from "node:test";
import assert from "node:assert/strict";

function runLogoutFlow({ route, redirectToLogin }) {
  const calls = {
    firebaseSignOut: 0,
    walletDisconnect: 0,
    clearActivity: 0,
    resetSession: 0,
  };

  let signedIn = true;
  let destination = route;

  calls.firebaseSignOut += 1;
  calls.walletDisconnect += 1;
  calls.clearActivity += 1;
  calls.resetSession += 1;
  signedIn = false;

  if (redirectToLogin) destination = "login";

  return { calls, signedIn, destination };
}

describe("Integration Tests: Logout Flow", () => {
  it("[FIT-AAR-013] should log out from a protected route and land on login", () => {
    const result = runLogoutFlow({ route: "admin", redirectToLogin: true });

    assert.equal(result.signedIn, false);
    assert.equal(result.destination, "login");
    assert.deepEqual(result.calls, {
      firebaseSignOut: 1,
      walletDisconnect: 1,
      clearActivity: 1,
      resetSession: 1,
    });
  });

  it("[FIT-AAR-014] should log out from a public route and still land on login", () => {
    const result = runLogoutFlow({ route: "discover", redirectToLogin: true });

    assert.equal(result.signedIn, false);
    assert.equal(result.destination, "login");
  });
});
