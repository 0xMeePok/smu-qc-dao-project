import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPlatformStatus: vi.fn(),
  probeBrowserRpc: vi.fn(),
  probeFirebaseFromBrowser: vi.fn(),
}));
vi.mock("../../src/lib/platformStatus.js", () => mocks);

import { PlatformStatusPanel } from "../../src/components/PlatformStatusPanel.jsx";

const ADDRESS = "0x47dA28cAEf8021dD88fe18B80e367746e0036964";
const rpc = (overrides = {}) => ({
  status: "ok",
  endpoint: { provider: "alchemy", host: "arb-sepolia.g.alchemy.com", configured: true },
  chainId: 421614,
  blockNumber: "313895531",
  blockAgeSeconds: 1,
  latencyMs: 180,
  notes: [],
  issues: [],
  ...overrides,
});
const server = (overrides = {}) => ({
  checkedAt: "2026-09-29T05:00:00.000Z",
  serverRpc: rpc({ latencyMs: 95 }),
  contracts: [{
    name: "AuditRegistry", address: ADDRESS, status: "ok", bytecodePresent: true, abiResponds: true, issues: [],
    explorerUrl: `https://sepolia.arbiscan.io/address/${ADDRESS}#code`,
    deployment: { blockNumber: "308652359", deployedAt: "2026-09-14T02:09:29.344Z",
      verificationUrl: `https://sepolia.arbiscan.io/address/${ADDRESS}#code` },
  }],
  anchoring: { status: "ok", windowDays: 7, counts: { pending: 2, confirmed: 5, failed: 0, "waiting-wallet": 1 }, issues: [] },
  alchemy: { status: "ok", overall: { description: "All Systems Operational" }, pageUrl: "https://status.alchemy.com",
    components: [{ key: "arbitrum", name: "Arbitrum", rawStatus: "operational", status: "ok" },
      { key: "apSoutheast", name: "AP SE", rawStatus: "operational", status: "ok" }], issues: [] },
  firebase: { functions: { status: "ok" }, firestore: { status: "ok", latencyMs: 30, maintenanceActive: false, issues: [] } },
  ...overrides,
});
const firebaseClient = (overrides = {}) => ({
  status: "ok", latencyMs: 40, notes: [], issues: [],
  config: { appCheckConfigured: true, storageConfigured: true, usingEmulators: false },
  ...overrides,
});

function card(name) {
  return screen.getByRole("heading", { level: 4, name }).closest("article");
}

beforeEach(() => {
  mocks.fetchPlatformStatus.mockResolvedValue(server());
  mocks.probeBrowserRpc.mockResolvedValue(rpc());
  mocks.probeFirebaseFromBrowser.mockResolvedValue(firebaseClient());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("[FIT-SXFPP-059] shows a checking state, then every card and a ready banner", async () => {
  render(<PlatformStatusPanel />);
  expect(screen.getByRole("status").textContent).toMatch(/Checking/);
  expect(screen.getByRole("button", { name: "Checking…" }).disabled).toBe(true);

  expect(await screen.findByText("Ready", { selector: ".status-banner strong" })).toBeTruthy();
  expect(screen.getByText("Every check passed.")).toBeTruthy();

  const serverCard = card("Server RPC");
  expect(within(serverCard).getByText("Healthy")).toBeTruthy();
  expect(within(serverCard).getByText("313,895,531")).toBeTruthy();
  expect(within(serverCard).getByText("95 ms")).toBeTruthy();
  expect(within(card("Browser RPC")).getByText("180 ms")).toBeTruthy();

  const contract = card("AuditRegistry (active)");
  expect(within(contract).getByText("308,652,359")).toBeTruthy();
  expect(within(contract).getByRole("link", { name: /View on Arbiscan/ }).getAttribute("href")).toContain(ADDRESS);

  const anchoring = card("Anchoring queue");
  expect(within(anchoring).getByText("Waiting for wallet")).toBeTruthy();
  expect(within(anchoring).getByText("5")).toBeTruthy();
  expect(within(anchoring).queryByRole("button", { name: /audit trail/ })).toBeNull();

  expect(within(card("Alchemy service")).getByText("All Systems Operational")).toBeTruthy();
  expect(within(card("Firebase")).getByText("Healthy · 30 ms")).toBeTruthy();
  expect(screen.getByText(/Last checked/)).toBeTruthy();
});

it("[FIT-SXFPP-060] re-runs every check on Re-check", async () => {
  render(<PlatformStatusPanel />);
  await screen.findByText("Ready", { selector: ".status-banner strong" });
  mocks.fetchPlatformStatus.mockResolvedValueOnce(server({
    anchoring: { status: "degraded", windowDays: 7, counts: { pending: 0, confirmed: 5, failed: 2, "waiting-wallet": 0 },
      issues: ["2 anchoring jobs failed in the last 7 days."] },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
  expect(await screen.findByText("Degraded", { selector: ".status-banner strong" })).toBeTruthy();
  expect(mocks.fetchPlatformStatus).toHaveBeenCalledTimes(2);
  expect(mocks.probeBrowserRpc).toHaveBeenCalledTimes(2);
  expect(mocks.probeFirebaseFromBrowser).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText(/2 anchoring jobs failed/).length).toBeGreaterThan(0);
});

it("[FIT-SXFPP-061] links failed anchoring jobs to the proposal audit trail", async () => {
  mocks.fetchPlatformStatus.mockResolvedValue(server({
    anchoring: { status: "degraded", windowDays: 7, counts: { pending: 0, confirmed: 1, failed: 1, "waiting-wallet": 0 },
      issues: ["1 anchoring job failed in the last 7 days."] },
  }));
  const onOpenAuditTrail = vi.fn();
  render(<PlatformStatusPanel onOpenAuditTrail={onOpenAuditTrail} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open proposal audit trail" }));
  expect(onOpenAuditTrail).toHaveBeenCalled();
});

it("[FIT-SXFPP-062] keeps browser checks visible when the status function fails", async () => {
  mocks.fetchPlatformStatus.mockRejectedValue(Object.assign(new Error("Administrator privilege required."), { code: "functions/permission-denied" }));
  render(<PlatformStatusPanel />);
  expect(await screen.findByText("Not ready")).toBeTruthy();
  expect(screen.getAllByText(/Cloud Functions: Administrator privilege required\./).length).toBeGreaterThan(0);
  expect(within(card("Browser RPC")).getByText("Healthy")).toBeTruthy();
  expect(within(card("Server RPC")).getByText("Unknown")).toBeTruthy();
  expect(within(card("Firebase")).getByText("Down", { selector: ".status-pill" })).toBeTruthy();
  expect(within(card("Firebase")).getByText("Down", { selector: "dd" })).toBeTruthy();
});

it("[FIT-SXFPP-063] is not ready when only the browser RPC fails, and shows the emulator badge", async () => {
  mocks.probeBrowserRpc.mockResolvedValue(rpc({ status: "down", blockNumber: undefined, latencyMs: 5000,
    issues: ["RPC unreachable from this browser: Failed to fetch"] }));
  mocks.probeFirebaseFromBrowser.mockResolvedValue(firebaseClient({
    config: { appCheckConfigured: false, storageConfigured: true, usingEmulators: true },
    notes: ["Emulator mode: Auth, Firestore, Functions and Storage are local emulators."],
  }));
  render(<PlatformStatusPanel />);
  expect(await screen.findByText("Not ready")).toBeTruthy();
  expect(screen.getAllByText(/Browser RPC: RPC unreachable/).length).toBeGreaterThan(0);
  expect(within(card("Server RPC")).getByText("Healthy")).toBeTruthy();
  expect(within(card("Firebase")).getByText("Emulator mode")).toBeTruthy();
});

it("[FIT-SXFPP-064] never renders an RPC key", async () => {
  mocks.probeBrowserRpc.mockResolvedValue(rpc({ status: "down", issues: ["RPC unreachable from this browser: HTTP request failed."] }));
  const { container } = render(<PlatformStatusPanel />);
  await screen.findByText("Not ready");
  await waitFor(() => expect(container.textContent).not.toMatch(/\/v2\//));
});
