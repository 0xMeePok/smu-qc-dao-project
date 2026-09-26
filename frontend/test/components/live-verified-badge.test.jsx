import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LiveVerifiedBadge } from "../../src/components/LiveVerifiedBadge.jsx";

afterEach(cleanup);

const audit = { status: "pending", transactionHash: `0x${"3".repeat(64)}` };

it("uses a fresh chain match for a saved pending receipt", async () => {
  render(<LiveVerifiedBadge audit={audit} verificationKey="proposal-1" onVerify={async () => ({ verified: true })} />);
  expect(screen.queryByRole("button", { name: "On-chain verification: pending" })).toBeNull();
  expect(await screen.findByRole("button", { name: "On-chain verification: verified" })).toBeTruthy();
});

it("does not report pending or verified when the chain check is unavailable", async () => {
  render(<LiveVerifiedBadge audit={audit} verificationKey="proposal-2" onVerify={async () => { throw new Error("offline"); }} />);
  expect(await screen.findByText("Verification unavailable")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /On-chain verification: (pending|verified)/ })).toBeNull();
});

it("shows failed only when the chain check finds a mismatch", async () => {
  render(<LiveVerifiedBadge audit={audit} verificationKey="proposal-4" onVerify={async () => ({ verified: false })} />);
  expect(await screen.findByRole("button", { name: "On-chain verification: failed" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "On-chain verification: pending" })).toBeNull();
});

it("uses a trusted confirmed receipt without a new chain request", () => {
  const onVerify = vi.fn();
  render(<LiveVerifiedBadge audit={{ ...audit, status: "confirmed" }} verificationKey="proposal-3" onVerify={onVerify} />);
  expect(screen.getByRole("button", { name: "On-chain verification: verified" })).toBeTruthy();
  expect(onVerify).not.toHaveBeenCalled();
});
