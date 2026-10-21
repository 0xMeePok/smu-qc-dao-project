import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auditShouldFail: false,
  auditError: null,
  connectedAddress: `0x${"a".repeat(40)}`,
  signIn: vi.fn(async () => ({ ok: false, cancelled: true })),
  events: [],
  publications: [],
  resumed: null,
  saveDraft: vi.fn(),
  navigate: vi.fn(),
  uploader: { onPendingChange: null },
}));

vi.mock("../../src/context/WalletContext.jsx", () => ({
  useWallet: () => ({
    address: mocks.connectedAddress,
    isConnected: Boolean(mocks.connectedAddress),
  }),
}));

vi.mock("../../src/context/SessionContext.jsx", () => ({
  useSession: () => ({
    address: `0x${"a".repeat(40)}`,
    profile: { organisation: "Singapore Management University" },
  }),
  useSignIn: () => mocks.signIn,
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
    mocks.publications.push(args);
    return { id: args.opportunityId, ...args.record };
  },
  updateFundingOpportunity: vi.fn(),
  FUNDING_STATUS_DRAFT: "draft",
  saveFundingDraft: (...args) => mocks.saveDraft(...args),
  publishFundingDraft: async (args) => {
    mocks.events.push("firestore");
    mocks.publications.push(args);
    return { id: args.opportunityId, ...args.record };
  },
}));

vi.mock("../../src/lib/postings.js", () => ({ findPosting: async () => mocks.resumed }));

vi.mock("../../src/lib/fundingOpportunityAudit.js", () => ({
  fundingOpportunityAuditReceipt: (opportunity) => opportunity.audit ?? null,
  readFundingOpportunityAudit: async () => ({ verified: true }),
  receiptForWrite: (audit) => audit && audit.status === "confirmed" ? { ...audit, status: "pending" } : audit,
  anchorFundingOpportunityAudit: async (_opportunity, options) => {
    mocks.events.push("audit");
    if (mocks.auditError) throw mocks.auditError;
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

vi.mock("../../src/components/AttachmentUploader.jsx", () => ({
  AttachmentUploader: ({ onPendingChange }) => {
    mocks.uploader.onPendingChange = onPendingChange;
    return <div data-testid="uploader" />;
  },
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
  mocks.auditError = null;
  mocks.connectedAddress = `0x${"a".repeat(40)}`;
  mocks.events = [];
  mocks.publications = [];
  mocks.resumed = null;
  mocks.navigate.mockReset();
  mocks.uploader.onPendingChange = null;
  mocks.saveDraft.mockReset().mockResolvedValue({ id: "funding123", status: "draft", updatedAt: new Date("2026-09-08T10:00:00Z") });
});
afterEach(cleanup);

describe("[QCDAO-51] create open funding", () => {
  it("removes the validation summary after every reported field is corrected", () => {
    render(<CreateFundingOpportunityPage onNavigate={() => {}} />);
    fireEvent.submit(document.querySelector("form"));
    expect(screen.getByText(/field\(s\) need attention/)).toBeTruthy();
    fillForm();
    expect(screen.queryByText(/field\(s\) need attention/)).toBeNull();
  });
  it("generates discovery tags from selected technology areas", () => {
    render(<CreateFundingOpportunityPage onNavigate={() => {}} />);

    const currency = screen.getByRole("combobox", { name: "Currency" });
    fireEvent.click(currency);
    expect(Array.from(screen.getByRole("listbox").querySelectorAll('[role="option"]'), (option) => option.getAttribute("aria-label"))).toEqual([
      "USDT", "USDC", "XSGD",
    ]);
    fireEvent.keyDown(currency, { key: "Escape" });
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
    expect(mocks.publications.at(-1).audit.transactionHash).toBe(`0x${"3".repeat(64)}`);
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
    mocks.signIn.mockClear();
    render(<CreateFundingOpportunityPage onNavigate={() => {}} />);
    fillForm();
    fireEvent.submit(document.querySelector("form"));

    // Privy's login modal opens through the session's sign-in.
    await waitFor(() => expect(mocks.signIn).toHaveBeenCalledOnce());
    expect(mocks.events).toEqual([]);
  });

  it("preserves open funding input after a wallet decline and publishes once on retry", async () => {
    mocks.auditError = { message: "Provider refused the request", data: { originalError: { code: 4001 } } };
    render(<CreateFundingOpportunityPage onNavigate={() => {}} />);
    fillForm();
    fireEvent.submit(document.querySelector("form"));

    expect((await screen.findByRole("alert")).textContent).toMatch(/wallet transaction was declined/i);
    expect(mocks.publications).toHaveLength(0);
    expect(mocks.events).toEqual(["audit"]);
    expect(document.getElementById("title").value).toBe("Resilient supply chains");
    expect(document.getElementById("fundingThesis").value).toBe("Fund research into resilient supply chains.");
    expect(document.getElementById("amount").value).toBe("250000");
    expect(screen.getByRole("checkbox", { name: /Quantum/i }).checked).toBe(true);

    mocks.auditError = null;
    fireEvent.submit(document.querySelector("form"));

    expect(await screen.findByText("Funding opportunity submitted")).toBeTruthy();
    expect(mocks.events).toEqual(["audit", "audit", "firestore"]);
    expect(mocks.publications).toHaveLength(1);
    expect(mocks.publications[0].record).toMatchObject({ title: "Resilient supply chains", amount: 250000, categories: ["quantum"] });
    expect(screen.queryByText(/wallet transaction was declined/i)).toBeNull();
  });
});

describe("QCDAO-57 open-funding drafts", () => {
  const start = async (props = {}) => {
    render(<CreateFundingOpportunityPage onNavigate={mocks.navigate} {...props} />);
    await screen.findByRole("button", { name: "Save as draft" });
  };
  const typeTitle = (value) =>
    fireEvent.change(screen.getByLabelText("Title"), { target: { value } });

  it("saves an unfinished funding form without demanding the missing fields", async () => {
    await start();
    typeTitle("Open call, first pass");
    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(1));
    const [call] = mocks.saveDraft.mock.calls[0];
    expect(call.form.title).toBe("Open call, first pass");
    expect(call.exists).toBe(false);
    // Nothing was anchored or published: a draft is private and unverified.
    expect(mocks.events).toEqual([]);
    expect(await screen.findByText(/Draft saved/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save as draft" }));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalledTimes(2));
    expect(mocks.saveDraft.mock.calls[1][0].exists).toBe(true);
  });

  it("offers to save when leaving with unsaved work", async () => {
    await start();
    typeTitle("Half an idea");
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.getByText(/save this as a draft/i)).toBeTruthy();
    expect(screen.getByText(/pick it up from My Problems later/i)).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("says nothing when the form was never touched", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("discover"));
  });

  it("saves then leaves, and stays put if the save fails", async () => {
    mocks.saveDraft.mockRejectedValueOnce(new Error("Network unavailable"));
    await start();
    typeTitle("Half an idea");
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save as draft and leave" }));
    await waitFor(() => expect(mocks.saveDraft).toHaveBeenCalled());
    // Leaving on a rejected save would discard the work the prompt offered to keep.
    expect(mocks.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save as draft and leave" }));
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("discover"));
  });

  it("does not save a draft while an attachment is still uploading", async () => {
    await start();
    await waitFor(() => expect(typeof mocks.uploader.onPendingChange).toBe("function"));
    await act(async () => { mocks.uploader.onPendingChange(1); });
    const save = screen.getByRole("button", { name: "Save as draft" });
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });

  it("resumes a saved draft and publishes it in place", async () => {
    mocks.resumed = {
      id: "funding-draft-1", opportunityType: "open-funding", status: "draft",
      title: "Open call, first pass", fundingThesis: "Fund resilient supply chains.",
      eligibilityNotes: "Universities may apply.", categories: ["quantum"],
      amount: 250000, currency: "USDC", updatedAt: new Date("2026-09-08T10:00:00Z"),
    };
    await start({ resumeId: "funding-draft-1" });
    await waitFor(() => expect(screen.getByLabelText("Title").value).toBe("Open call, first pass"));
    expect(screen.getByText(/Draft saved/)).toBeTruthy();
    // Resuming and changing nothing is not unsaved work.
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
  });
});
