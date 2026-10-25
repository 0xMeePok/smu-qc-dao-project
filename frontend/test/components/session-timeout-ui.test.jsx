import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: {}, auth: {}, signIn: vi.fn() }));
vi.mock("../../src/context/SessionContext.jsx", () => ({ useSession: () => mocks.session }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => mocks.auth }));
import { Login } from "../../src/components/Login.jsx";
import { SignInWithEmail } from "../../src/components/SignInWithEmail.jsx";

beforeEach(() => {
  mocks.signIn.mockReset().mockResolvedValue({ ok: true });
  mocks.session = { signIn: mocks.signIn, signOutReason: "idle", error: "You were signed out after one hour of inactivity. Sign in again to continue.", isBusy: false, isSigningOut: false };
  mocks.auth = { isAuthenticated: false, roles: [], isLoading: false };
});
afterEach(cleanup);

it("shows one clear timeout notice on the sign-in card and keeps it out of the header", () => {
  render(<><header><SignInWithEmail /></header><Login redirectTarget="proposal/example?tab=funding" onNavigate={vi.fn()} /></>);
  expect(screen.getByRole("heading", { name: "Your session has expired" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("one hour of inactivity");
  expect(screen.getByRole("status").textContent).toContain("return to where you left off");
  expect(screen.getAllByText(/one hour of inactivity/)).toHaveLength(1);
  expect(within(screen.getByRole("banner")).queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Authentication Required")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  expect(mocks.signIn).toHaveBeenCalledOnce();
});

it("waits for logout to finish before allowing another sign-in", () => {
  mocks.session.isSigningOut = true;
  render(<Login onNavigate={vi.fn()} />);
  const signIn = screen.getByRole("button", { name: "Signing out…" });
  expect(signIn.disabled).toBe(true);
  fireEvent.click(signIn);
  expect(mocks.signIn).not.toHaveBeenCalled();
});

it("retains actual sign-in errors and the normal email sign-in button", () => {
  mocks.session.signOutReason = null;
  mocks.session.error = "Unable to sign in. Please try again.";
  render(<Login onNavigate={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "Platform Sign In" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe(mocks.session.error);
  expect(screen.getByRole("button", { name: "Sign in with email" })).toBeTruthy();
});

it.each([
  ["researcher", "proposal/example?tab=funding"],
  ["admin", "proposal/example?tab=funding"],
  ["admin", "admin?tab=escrows"],
  ["admin", "discover?type=business-problem"],
])("returns the %s to %s after authentication", (role, destination) => {
  mocks.auth.isAuthenticated = true;
  mocks.auth.roles = [role];
  const navigate = vi.fn();
  render(<Login redirectTarget={destination} onNavigate={navigate} />);
  expect(navigate).toHaveBeenCalledWith(destination);
});

it("uses the admin dashboard for a new sign-in without an interrupted destination", () => {
  mocks.auth.isAuthenticated = true;
  mocks.auth.roles = ["admin"];
  mocks.session.signOutReason = null;
  const navigate = vi.fn();
  render(<Login onNavigate={navigate} />);
  expect(navigate).toHaveBeenCalledWith("admin");
});
