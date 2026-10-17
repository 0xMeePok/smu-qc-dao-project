import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResponsiveHeader } from "../../src/components/ResponsiveHeader.jsx";
import { getPermittedNavRoutes } from "../../src/config/routes.js";
import { ROLES } from "../../src/config/roles.js";
let media;
beforeEach(() => { media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }; window.matchMedia = vi.fn(() => media); });
afterEach(cleanup);
const props = { route: "discover", primaryRoutes: [{ key: "home", label: "Home" }, { key: "discover", label: "Discover" }], workspaceRoutes: [{ key: "proposals", label: "My Proposals" }], desktopWorkspaces: <button>Workspaces</button>, accountControls: <button>Sign Out</button>, onNavigate: vi.fn() };
it("opens and closes, dismisses outside, and returns focus on Escape", () => {
  render(<ResponsiveHeader {...props} />);
  const toggle = screen.getByRole("button", { name: "Open navigation menu" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle); expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false"); expect(document.activeElement).toBe(toggle);
  fireEvent.click(toggle); fireEvent.pointerDown(document.body);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
it("closes when navigating to the same page or a workspace", () => {
  render(<ResponsiveHeader {...props} />);
  const toggle = screen.getByRole("button", { name: "Open navigation menu" });
  fireEvent.click(toggle); fireEvent.click(screen.getByRole("button", { name: "Discover", exact: true }));
  expect(props.onNavigate).toHaveBeenCalledWith("discover"); expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle); fireEvent.click(screen.getByRole("button", { name: "My Proposals" }));
  expect(props.onNavigate).toHaveBeenCalledWith("proposals"); expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
it("closes when an account action opens another surface, such as the sign-in modal", () => {
  const signIn = vi.fn();
  render(<ResponsiveHeader {...props} accountControls={<><button type="button">Theme</button><button type="button" data-closes-menu onClick={signIn}>Sign in with email</button></>} />);
  const toggle = screen.getByRole("button", { name: "Open navigation menu" });
  fireEvent.click(toggle); fireEvent.click(screen.getByRole("button", { name: "Theme" }));
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Sign in with email" }));
  expect(signIn).toHaveBeenCalledTimes(1); expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
it("resets after browser navigation and when resizing to desktop", () => {
  const { rerender } = render(<ResponsiveHeader {...props} />);
  const toggle = screen.getByRole("button", { name: "Open navigation menu" });
  fireEvent.click(toggle); rerender(<ResponsiveHeader {...props} route="home" />);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle); media.matches = true;
  act(() => media.addEventListener.mock.calls[0][1]());
  expect(media.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
it("renders only routes permitted for guests", () => {
  render(<ResponsiveHeader {...props} primaryRoutes={getPermittedNavRoutes([ROLES.GUEST])} workspaceRoutes={[]} />);
  expect(screen.queryByText("My Proposals")).toBeNull();
  expect(screen.queryByText("Create Brief")).toBeNull();
  expect(screen.queryByText("Admin Audit")).toBeNull();
});
