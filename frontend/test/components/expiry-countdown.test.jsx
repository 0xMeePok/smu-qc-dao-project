import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpiryCountdown } from "../../src/components/ExpiryCountdown.jsx";

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
    expect(screen.getByText("12d 04h 33m left")).toBeTruthy();
    expect(screen.getByText("2026-09-13 04:33:12 UTC")).toBeTruthy();
    expect(screen.getByLabelText(/Approaching deadline\. 12d 04h 33m left\. Closes 2026-09-13 04:33:12 UTC/)).toBeTruthy();
  });

  it("[FIT-OPD-020] refreshes the minute-level display once per minute", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-09-01T00:03:00Z")} />);
    expect(screen.getByText("0d 00h 03m left")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(60 * 1000); });
    expect(screen.getByText("0d 00h 02m left")).toBeTruthy();
  });

  it("[FIT-OPD-021] flips to Expired when the deadline passes while on screen", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-09-01T00:01:00Z")} />);
    expect(screen.getByText("0d 00h 01m left")).toBeTruthy();

    act(() => { vi.advanceTimersByTime(60 * 1000); });
    expect(screen.getByText("Expired")).toBeTruthy();
  });

  it("[FIT-OPD-022] starts expired for a posting that already closed", () => {
    render(<ExpiryCountdown expiresAt={new Date("2026-08-01T00:00:00Z")} />);
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("[FIT-OPD-131] exposes urgency without relying on colour", () => {
    const { container, rerender } = render(
      <ExpiryCountdown expiresAt={new Date("2026-09-15T00:00:00Z")} />,
    );
    expect(container.querySelector(".expiry-approaching")).toBeTruthy();
    expect(screen.getByText("Approaching deadline")).toBeTruthy();

    rerender(<ExpiryCountdown expiresAt={new Date("2026-09-03T00:00:00Z")} />);
    expect(container.querySelector(".expiry-critical")).toBeTruthy();
    expect(screen.getByText("Deadline imminent")).toBeTruthy();
  });

  it("[QCDAO-55] shows a closed status instead of a live countdown", () => {
    const { container } = render(
      <ExpiryCountdown expiresAt={new Date("2026-12-01T00:00:00Z")} status="expired" />,
    );
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByText(/left$/)).toBeNull();
    expect(container.querySelector(".expiry-expired")).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();

    render(<ExpiryCountdown expiresAt={new Date("2026-12-01T00:00:00Z")} status="cancelled" />);
    expect(screen.getByText("Withdrawn")).toBeTruthy();
    cleanup();

    render(<ExpiryCountdown expiresAt={new Date("2026-12-01T00:00:00Z")} status="in_review" />);
    expect(screen.getByText(/left$/)).toBeTruthy();
  });
});
