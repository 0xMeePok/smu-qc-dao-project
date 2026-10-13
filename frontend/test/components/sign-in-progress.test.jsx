import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIGN_IN_STEPS, SignInProgressScreen, SLOW_AFTER_S, TIP_INTERVAL_MS } from "../../src/components/SignInProgress.jsx";
import { SIGN_IN_TIPS } from "../../src/config/signInTips.js";

const tips = [{ title: "First", text: "one" }, { title: "Second", text: "two" }, { title: "Third", text: "three" }];

describe("SignInProgress", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("shows the real step in progress, with earlier steps done", () => {
    render(<SignInProgressScreen step="session" tips={tips} random={() => 0} />);
    expect(screen.getByRole("dialog", { name: "Signing you in" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Securing your session… Please keep this tab open.");
    const steps = screen.getAllByRole("listitem");
    expect(steps.map((item) => item.className)).toEqual([
      "signin-progress-step is-done", "signin-progress-step is-active", "signin-progress-step is-pending",
    ]);
  });

  it("rotates tips on a timer and on request", () => {
    render(<SignInProgressScreen step="wallet" tips={tips} random={() => 0} />);
    expect((screen.getByText("First"))).toBeTruthy();
    act(() => { vi.advanceTimersByTime(TIP_INTERVAL_MS); });
    expect((screen.getByText("Second"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next tip" }));
    expect((screen.getByText("Third"))).toBeTruthy();
    act(() => { vi.advanceTimersByTime(TIP_INTERVAL_MS); });
    expect((screen.getByText("First"))).toBeTruthy();
  });

  it("counts the wait and reassures a member once it runs long", () => {
    render(<SignInProgressScreen step="profile" tips={tips} random={() => 0} />);
    expect((screen.getByText(/0s · This usually takes under 20 seconds/))).toBeTruthy();
    act(() => { vi.advanceTimersByTime(SLOW_AFTER_S * 1000); });
    expect((screen.getByText(new RegExp(`${SLOW_AFTER_S}s · Still working`)))).toBeTruthy();
  });

  it("ships a tip for every step of the app and names every sign-in step", () => {
    expect(SIGN_IN_TIPS.length).toBeGreaterThanOrEqual(10);
    for (const tip of SIGN_IN_TIPS) expect(tip.title && tip.text).toBeTruthy();
    expect(SIGN_IN_STEPS.map((item) => item.key)).toEqual(["wallet", "session", "profile"]);
  });
});
