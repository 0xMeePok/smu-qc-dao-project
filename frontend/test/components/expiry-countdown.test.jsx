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
  it("[FIT-OPD-019] shows the remaining time and the exact UTC instant", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-09-13T04:33:12Z")} />);
    expect(screen.getByText("12d 04:33:12 left")).toBeTruthy();
    expect(screen.getByText("2026-09-13 04:33:12 UTC")).toBeTruthy();
  });

  it("[FIT-OPD-020] ticks down once per second", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-09-01T00:01:00Z")} />);
    expect(screen.getByText("00:01:00 left")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText("00:00:59 left")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByText("00:00:54 left")).toBeTruthy();
  });

  it("[FIT-OPD-021] flips to Expired when the deadline passes while on screen", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-09-01T00:00:03Z")} />);
    expect(screen.getByText("00:00:03 left")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText("Expired")).toBeTruthy();
  });

  it("[FIT-OPD-022] starts expired for a posting that already closed", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-08-01T00:00:00Z")} />);
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
