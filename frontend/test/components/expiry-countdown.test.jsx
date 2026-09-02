import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpiryCountdown } from "../../src/components/ExpiryCountdown.jsx";

/** QCDAO-48 - the live countdown on a posting's expiry. */

const NOW = new Date("2026-09-01T00:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("ExpiryCountdown", () => {
  it("[FIT-DT-17] shows the remaining time and the exact UTC instant", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-09-13T04:33:12Z")} />);
    expect(screen.getByText("12d 04:33:12 left")).toBeTruthy();
    // The absolute instant sits alongside it: the countdown answers "have I got
    // time", the timestamp answers "by exactly when", in any time zone.
    expect(screen.getByText("2026-09-13 04:33:12 UTC")).toBeTruthy();
  });

  it("[FIT-DT-18] ticks down once per second", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-09-01T00:01:00Z")} />);
    expect(screen.getByText("00:01:00 left")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("00:00:59 left")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText("00:00:54 left")).toBeTruthy();
  });

  it("[FIT-DT-19] flips to Expired when the deadline passes while on screen", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-09-01T00:00:03Z")} />);
    expect(screen.getByText("00:00:03 left")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText("Expired")).toBeTruthy();
  });

  it("[FIT-DT-20] stops the timer once expired, rather than ticking forever", () => {
    // A dead posting left on screen must not keep a 1s interval alive.
    render(<ExpiryCountdown expiresAt={new Date("2026-09-01T00:00:01Z")} />);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("[FIT-DT-21] starts expired for a posting that already closed", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-08-01T00:00:00Z")} />);
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("[FIT-DT-22] clears its interval on unmount", () => {
    const view = render(<ExpiryCountdown expiresAt={new Date("2026-12-01T00:00:00Z")} />);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("[FIT-DT-23] renders a placeholder for a missing expiry", () => {
    render(<ExpiryCountdown expiresAt={null} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});
