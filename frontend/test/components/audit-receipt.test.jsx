import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditReceipt } from "../../src/components/AuditReceipt.jsx";

const HASH = `0x${"2".repeat(64)}`;
const TX = `0x${"3".repeat(64)}`;

function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    status: "confirmed",
    contentHash: HASH,
    transactionHash: TX,
    blockNumber: 123,
    attemptCount: 1,
    lastError: "",
    ...overrides,
  };
}

function renderReceipt(props = {}) {
  return render(<AuditReceipt
    audit={receipt()}
    eventLabel="Funded problem statement submitted"
    actorRole="Problem owner"
    firebaseReference="problems/posting123"
    onVerify={async () => ({
      verified: true,
      anchor: { anchor: { timestamp: 1_756_800_000n, actor: `0x${"a".repeat(40)}` } },
    })}
    {...props}
  />);
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  });
});
afterEach(cleanup);

describe("AuditReceipt", () => {
  it("[QCDAO-77] renders a legible receipt and explorer link", async () => {
    renderReceipt();
    expect(await screen.findByText("Verified on Arbitrum Sepolia")).toBeTruthy();
    expect(screen.getByText("Problem owner")).toBeTruthy();
    expect(screen.getByText("problems/posting123")).toBeTruthy();
    expect(screen.getByText(HASH)).toBeTruthy();
    const explorer = screen.getByRole("link", { name: /view transaction/i });
    expect(explorer.getAttribute("href")).toBe(`https://sepolia.arbiscan.io/tx/${TX}`);
  });

  it("[QCDAO-77] copies the verification hash", async () => {
    renderReceipt();
    fireEvent.click(screen.getByRole("button", { name: /copy verification hash/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(HASH));
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  });

  it("[QCDAO-78] reports a verified match and a prominent mismatch", async () => {
    const { rerender } = renderReceipt({ onVerify: async () => ({ verified: true }) });
    expect(await screen.findByText(/Verified match/)).toBeTruthy();

    rerender(<AuditReceipt
      audit={receipt()}
      eventLabel="Funded problem statement submitted"
      actorRole="Problem owner"
      firebaseReference="problems/posting123"
      onVerify={async () => ({ verified: false })}
    />);
    fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    expect(await screen.findByText(/Mismatch detected/)).toBeTruthy();
  });

  it("[QCDAO-79] distinguishes a failed verification layer and offers a capped retry", () => {
    const retry = vi.fn();
    renderReceipt({
      audit: receipt({
        status: "failed", transactionHash: "", blockNumber: 0,
        attemptCount: 2, lastError: "Testnet unavailable",
      }),
      onVerify: undefined,
      onRetry: retry,
    });
    expect(screen.getByText("Posting saved; verification needs attention")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Testnet unavailable");
    fireEvent.click(screen.getByRole("button", { name: /retry anchoring/i }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("reads the contract even when Firestore has only a failed legacy receipt", async () => {
    const verify = vi.fn(async () => {
      throw new Error("execution reverted: InvalidInput");
    });
    renderReceipt({
      audit: receipt({
        status: "failed", transactionHash: "", blockNumber: 0,
        lastError: "The wallet transaction was declined.",
      }),
      onVerify: verify,
    });

    expect(verify).toHaveBeenCalledOnce();
    expect(await screen.findByText(/No matching audit/)).toBeTruthy();
  });
});
