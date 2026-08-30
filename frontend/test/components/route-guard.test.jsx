import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RouteGuard } from "../../src/components/RouteGuard.jsx";
import { AuthProvider } from "../../src/context/AuthContext.jsx";
import { SessionContext } from "../../src/context/SessionContext.jsx";
import { ROLES } from "../../src/config/roles.js";

function renderGuard(session, onNavigate = vi.fn()) {
  render(
    <SessionContext.Provider value={session}>
      <AuthProvider>
        <RouteGuard
          targetRoute="proposals"
          allowedRoles={[ROLES.RESEARCHER]}
          authRequired
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
});
