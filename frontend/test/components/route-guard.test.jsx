import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteGuard } from "../../src/components/RouteGuard.jsx";
import { AuthProvider } from "../../src/context/AuthContext.jsx";
import { SessionContext } from "../../src/context/SessionContext.jsx";
import { getRouteConfig } from "../../src/config/routes.js";

afterEach(cleanup);

function renderGuard(session, onNavigate = vi.fn(), routeKey = "proposals") {
  const route = getRouteConfig(routeKey);
  render(
    <SessionContext.Provider value={session}>
      <AuthProvider>
        <RouteGuard
          targetRoute={routeKey}
          allowedRoles={route.allowedRoles}
          authRequired={route.authRequired}
          onNavigate={onNavigate}
        >
          <div>Protected proposals</div>
        </RouteGuard>
      </AuthProvider>
    </SessionContext.Provider>,
  );
  return onNavigate;
}

describe("real RouteGuard and AuthContext integration", () => {
  it("waits while a persisted session is restoring", () => {
    const navigate = renderGuard({ isLoading: true, isSignedIn: false, profile: null, address: null });
    expect(screen.getByRole("status").textContent).toContain("Restoring your session");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("redirects only after Firebase has resolved as signed out", async () => {
    const navigate = renderGuard({ isLoading: false, isSignedIn: false, profile: null, address: null });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("login?redirect=proposals"));
    expect(screen.queryByText("Protected proposals")).toBeNull();
  });

  it("renders a restored participant session through the actual guard", () => {
    renderGuard({
      isLoading: false,
      isSignedIn: true,
      address: `0x${"a".repeat(40)}`,
      profile: { fullName: "Ada", organisation: "SMU", role: 0 },
    });
    expect(screen.getByText("Protected proposals")).toBeTruthy();
  });

  it("admits an administrator to proposal detail for escrow administration", () => {
    const navigate = renderGuard({
      isLoading: false,
      isSignedIn: true,
      address: `0x${"a".repeat(40)}`,
      profile: { fullName: "Admin", role: 1 },
    }, vi.fn(), "proposal");

    expect(screen.getByText("Protected proposals")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Access Denied" })).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps administrator access to proposal detail separate from author editing", () => {
    renderGuard({
      isLoading: false,
      isSignedIn: true,
      address: `0x${"a".repeat(40)}`,
      profile: { fullName: "Admin", role: 1 },
    }, vi.fn(), "edit-proposal");

    expect(screen.getByRole("heading", { name: "Access Denied" })).toBeTruthy();
    expect(screen.queryByText("Protected proposals")).toBeNull();
  });

  it("keeps a suspended administrator out of proposal detail", async () => {
    const navigate = renderGuard({
      isLoading: false,
      isSignedIn: true,
      address: `0x${"a".repeat(40)}`,
      profile: { fullName: "Admin", role: 1, suspended: true },
    }, vi.fn(), "proposal");

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("login?redirect=proposal"));
    expect(screen.queryByText("Protected proposals")).toBeNull();
  });
});
