import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditShouldFail: false,
  connectedAddress: `0x${"a".repeat(40)}`,
  events: [],
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({
    address: mocks.connectedAddress,
    isConnected: Boolean(mocks.connectedAddress),
  }),
}));

vi.mock("../../src/context/SessionContext.jsx", () => ({
  useSession: () => ({
    address: `0x${"a".repeat(40)}`,
    profile: { organisation: "Singapore Management University" },
  }),
}));

vi.mock("../../src/lib/fundingOpportunities.js", () => ({
  newFundingOpportunityId: () => "funding123",
  buildFundingOpportunityDocument: ({ ownerId, organisation, form }) => ({
    opportunityType: "open-funding",
    ownerId,
    organisation,
    ...form,
    tags: form.categories.map((category) => ({
      ai: "AI & machine learning",
      quantum: "Quantum",
    })[category] ?? category),
    amount: Number(form.amount),
    status: "submitted",
    expiresAt: new Date("2026-12-03T00:00:00Z"),
    createdAt: new Date("2026-09-04T00:00:00Z"),
  }),
  createFundingOpportunity: async (args) => {
    mocks.events.push("firestore");
    return { id: args.opportunityId, ...args.record };
  },
}));

vi.mock("../../src/lib/fundingOpportunityAudit.js", () => ({
  fundingOpportunityAuditReceipt: (opportunity) => opportunity.audit ?? null,
  readFundingOpportunityAudit: async () => ({ verified: true }),
  anchorFundingOpportunityAudit: async (_opportunity, options) => {
    mocks.events.push("audit");
    if (mocks.auditShouldFail) throw new Error("RPC unavailable");
    const audit = {
      schemaVersion: 1,
      chainId: 421614,
      entityId: `0x${"1".repeat(64)}`,
      contentHash: `0x${"2".repeat(64)}`,
      status: "confirmed",
      transactionHash: `0x${"3".repeat(64)}`,
      blockNumber: 123,
      attemptCount: 1,
      lastError: "",
    };
    options.onChange(audit);
    return audit;
  },
}));

vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({
  ConnectWalletModal: () => <div role="dialog">Reconnect wallet</div>,
}));

const { default: CreateFundingOpportunityPage } = await import(
  "../../src/pages/CreateFundingOpportunityPage.jsx"
);

function fillForm() {
  fireEvent.change(document.getElementById("title"), { target: { value: "Resilient supply chains" } });
  fireEvent.change(document.getElementById("fundingThesis"), {
    target: { value: "Fund research into resilient supply chains." },
  });
  fireEvent.change(document.getElementById("eligibilityNotes"), {
    target: { value: "Universities and research organisations may apply." },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Quantum/i }));
  fireEvent.change(document.getElementById("amount"), { target: { value: "250000" } });
}

beforeEach(() => {
  mocks.auditShouldFail = false;
  mocks.connectedAddress = `0x${"a".repeat(40)}`;
  mocks.events = [];
});
afterEach(cleanup);

describe("[QCDAO-51] create open funding", () => {
  it("generates discovery tags from selected technology areas", () => {
    render(<CreateFundingOpportunityPage onNavigate={() => {}} />);

    const currency = screen.getByRole("combobox", { name: "Currency" });
    expect(Array.from(currency.options, (option) => option.value)).toEqual([
      "USDT", "USDC", "XSGD",
    ]);
    expect(document.getElementById("tags")).toBeNull();
    const generated = screen.getByTestId("generated-tags");
    expect(generated.textContent).toContain("Select a technology area");

    const ai = screen.getByRole("checkbox", { name: /AI & machine learning/i });
    const quantum = screen.getByRole("checkbox", { name: /Quantum/i });
    fireEvent.click(ai);
    fireEvent.click(quantum);
    expect(generated.textContent).toContain("AI & machine learning");
    expect(generated.textContent).toContain("Quantum");

    fireEvent.click(ai);
    expect(generated.textContent).not.toContain("AI & machine learning");
    expect(generated.textContent).toContain("Quantum");
  });

  it("anchors on-chain before writing Firestore and renders the Funder receipt", async () => {
    render(<CreateFundingOpportunityPage onNavigate={() => {}} />);
    fillForm();
    fireEvent.submit(document.querySelector("form"));

    expect(await screen.findByText("Funding opportunity submitted")).toBeTruthy();
    expect(mocks.events).toEqual(["audit", "firestore"]);
    expect(screen.getAllByText("Open funding opportunity submitted")).toHaveLength(2);
    expect(screen.getByText("Funder")).toBeTruthy();
  });

  it("keeps the form and prevents the write when anchoring fails", async () => {
    mocks.auditShouldFail = true;
    render(<CreateFundingOpportunityPage onNavigate={() => {}} />);
    fillForm();
    fireEvent.submit(document.querySelector("form"));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("RPC unavailable"));
    expect(mocks.events).toEqual(["audit"]);
    expect(document.getElementById("title").value).toBe("Resilient supply chains");
    expect(screen.getByTestId("generated-tags").textContent).toContain("Quantum");
  });

  it("requires the signed-in wallet to be connected", async () => {
    mocks.connectedAddress = null;
    render(<CreateFundingOpportunityPage onNavigate={() => {}} />);
    fillForm();
    fireEvent.submit(document.querySelector("form"));

    expect((await screen.findByRole("dialog")).textContent).toContain("Reconnect wallet");
    expect(mocks.events).toEqual([]);
  });
});
