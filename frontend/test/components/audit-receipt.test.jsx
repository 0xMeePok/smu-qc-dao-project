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
  it("offers a start action for a queued receipt after a wallet disconnect", () => {
    const start = vi.fn();
    renderReceipt({ audit: receipt({ status: "queued", transactionHash: "", attemptCount: 0 }), onVerify: undefined, onRetry: start });
    fireEvent.click(screen.getByRole("button", { name: "Start verification" }));
    expect(start).toHaveBeenCalledOnce();
  });

  it("offers a resume action for a pending receipt", () => {
    const resume = vi.fn();
    renderReceipt({ audit: receipt({ status: "pending" }), onVerify: undefined, onRetry: resume });
    fireEvent.click(screen.getByRole("button", { name: "Resume verification" }));
    expect(resume).toHaveBeenCalledOnce();
  });

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
    expect(screen.getByRole("alert").textContent).toContain("does not match the version recorded in the smart contract on Arbitrum Sepolia");
    expect(screen.getByRole("alert").textContent).toContain("Contact the submission owner or an administrator");
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

  it("allows checking a failed legacy receipt without mislabelling it a mismatch", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: /check again/i }));
    await waitFor(() => expect(verify).toHaveBeenCalledOnce());
    expect(await screen.findByText(/No matching audit/)).toBeTruthy();
  });
});

it.each([
  [Object.assign(new Error("FirebaseError: private request details"), { code: "permission-denied" }), /Sign in with an authorised account/],
  [new Error("This proposal is no longer available or you do not have access."), /Refresh the page or contact an administrator/],
  [new Error("Only canonical audit hash scheme 1 is supported."), /unsupported verification format/],
  [new Error("AuditRegistry is not configured."), /verification service is not configured/],
  [new Error("HTTP request failed: private RPC URL; Request Arguments: 0x123"), /Check your connection and select Check again/],
  [new Error("Contract call reverted for an unknown reason"), /No match or mismatch has been established/],
])("shows actionable verification errors without raw service details: %s", async (error, expected) => {
  renderReceipt({ onVerify: async () => { throw error; } });
  expect(await screen.findByText(expected)).toBeTruthy();
  expect(screen.queryByText("Verified on Arbitrum Sepolia")).toBeNull();
  expect(screen.queryByText(/private request details|private RPC URL|Request Arguments/)).toBeNull();
});

it("does not claim a pending transaction is confirmed when no audit is found", async () => {
  renderReceipt({ audit: receipt({ status: "pending" }), onVerify: async () => { throw new Error("InvalidInput"); } });
  expect(await screen.findByText(/transaction may still be waiting for confirmation/)).toBeTruthy();
  expect(screen.queryByText("Verified on Arbitrum Sepolia")).toBeNull();
});

it("explains a clipboard failure and allows resuming a known transaction at the attempt cap", async () => {
  navigator.clipboard.writeText.mockRejectedValue(new Error("Denied"));
  renderReceipt({ audit: receipt({ status: "pending", attemptCount: 3 }), onVerify: undefined, onRetry: vi.fn() });
  fireEvent.click(screen.getByRole("button", { name: /copy transaction reference/i }));
  expect(await screen.findByText(/Copy unavailable/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Resume verification" })).toBeTruthy();
});
