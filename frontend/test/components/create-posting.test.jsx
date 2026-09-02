import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** QCDAO-48 - the funded problem statement form. */

const mocks = vi.hoisted(() => ({
  created: [],
  createShouldFail: false,
  auditCalls: [],
  auditShouldFail: false,
  deleted: [],
  uploader: {
    onChange: null,
    onPendingChange: null,
  },
}));

vi.mock("../../src/lib/firebase.js", () => ({
  db: {}, auth: null, functions: null, storage: {},
  isStorageConfigured: true, storageNeedsEmulator: false, app: {},
}));

vi.mock("../../src/lib/postings.js", () => ({
  newPostingId: () => "posting123",
  createPosting: async (args) => {
    if (mocks.createShouldFail) {
      const failure = new Error("denied");
      failure.code = "permission-denied";
      throw failure;
    }
    mocks.created.push(args);
    return {
      id: "posting123",
      ...args.form,
      amount: Number(args.form.amount),
      organisation: args.organisation,
      categories: args.form.categories,
      attachments: args.attachments ?? [],
      createdAt: new Date("2026-09-01T00:00:00Z"),
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    };
  },
}));

vi.mock("../../src/lib/attachments.js", () => ({
  deleteAttachment: async (item) => {
    mocks.deleted.push(item);
  },
}));

vi.mock("../../src/lib/postingAudit.js", () => ({
  anchorPostingAudit: async (posting, options) => {
    mocks.auditCalls.push({ posting, account: options.account });
    const audit = {
      schemaVersion: 1,
      chainId: 421614,
      contractAddress: `0x${"c".repeat(40)}`,
      entityId: `0x${"1".repeat(64)}`,
      contentHash: `0x${"2".repeat(64)}`,
      status: mocks.auditShouldFail ? "failed" : "confirmed",
      transactionHash: mocks.auditShouldFail ? "" : `0x${"3".repeat(64)}`,
      blockNumber: mocks.auditShouldFail ? 0 : 123,
      attemptCount: 1,
      lastError: mocks.auditShouldFail ? "Testnet unavailable" : "",
    };
    options.onChange(audit);
    if (mocks.auditShouldFail) throw new Error("RPC unavailable");
    return audit;
  },
}));

// Controllable stand-in: attachment behaviour has its own suite. These tests
// drive pending/completed state through the callbacks the real uploader fires.
vi.mock("../../src/components/AttachmentUploader.jsx", () => ({
  AttachmentUploader: ({ onChange, onPendingChange }) => {
    mocks.uploader.onChange = onChange;
    mocks.uploader.onPendingChange = onPendingChange;
    return <div data-testid="uploader" />;
  },
}));

vi.mock("../../src/context/SessionContext.jsx", () => ({
  useSession: () => ({
    address: `0x${"a".repeat(40)}`,
    profile: { organisation: "Singapore Management University" },
    isSignedIn: true,
  }),
}));

const { default: CreatePostingPage } = await import("../../src/pages/CreatePostingPage.jsx");

function amountInput() {
  return document.getElementById("amount");
}

function fillRequired() {
  const text = {
    title: "Cold-chain route optimisation",
    businessContext: "Perishable deliveries across a dense urban network.",
    summary: "Vehicle routing degrades badly under demand spikes.",
    currentApproach: "A nightly heuristic solver.",
    currentLimitations: "Runtime grows past the delivery window.",
    expectedOutcome: "A schedule inside a thirty minute window.",
    successCriteria: "Ten percent lower distance at equal service level.",
    dataAvailability: "Two years of anonymised telemetry.",
  };
  for (const [id, value] of Object.entries(text)) {
    fireEvent.change(document.getElementById(id), { target: { value } });
  }
  fireEvent.click(screen.getByRole("checkbox", { name: /AI & machine learning/i }));
  fireEvent.change(amountInput(), { target: { value: "1000000" } });
}

const DRAFT_ATTACHMENT = {
  id: "att1",
  name: "spec.pdf",
  size: 1024,
  contentType: "application/pdf",
  path: `problems/0x${"a".repeat(40)}/posting123/att1.pdf`,
};

beforeEach(() => {
  mocks.created = [];
  mocks.createShouldFail = false;
  mocks.auditCalls = [];
  mocks.auditShouldFail = false;
  mocks.deleted = [];
  mocks.uploader.onChange = null;
  mocks.uploader.onPendingChange = null;
});
afterEach(cleanup);

describe("funding amount input", () => {
  it("[FIT-OPD-013] is not a steppable number input", () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    expect(amountInput().getAttribute("type")).toBe("text");
    expect(amountInput().getAttribute("type")).not.toBe("number");
    expect(amountInput().getAttribute("inputmode")).toBe("numeric");
  });

  it("[FIT-OPD-014] strips separators and letters so the stored number is exact", () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.change(amountInput(), { target: { value: "1,000,000" } });
    expect(amountInput().value).toBe("1000000");

    fireEvent.change(amountInput(), { target: { value: "80000abc" } });
    expect(amountInput().value).toBe("80000");
  });

  it("[FIT-OPD-015] submits exactly the figure that was typed", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fillRequired();
    fireEvent.submit(document.querySelector("form"));

    await waitFor(() => expect(mocks.created).toHaveLength(1));
    expect(mocks.created[0].form.amount).toBe("1000000");
  });
});

describe("no data loss on a failed submit", () => {
  it("[FIT-OPD-016] keeps every field when the write is rejected", async () => {
    mocks.createShouldFail = true;
    render(<CreatePostingPage onNavigate={() => {}} />);
    fillRequired();
    fireEvent.submit(document.querySelector("form"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    expect(document.getElementById("title").value).toBe("Cold-chain route optimisation");
    expect(document.getElementById("summary").value)
      .toBe("Vehicle routing degrades badly under demand spikes.");
    expect(amountInput().value).toBe("1000000");
    expect(screen.getByRole("checkbox", { name: /AI & machine learning/i }).checked).toBe(true);
  });
});

describe("asynchronous AuditRegistry integration", () => {
  it("[QCDAO-75..79] publishes first and exposes the confirmed audit receipt", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fillRequired();
    fireEvent.submit(document.querySelector("form"));

    expect(await screen.findByText("Cold-chain route optimisation")).toBeTruthy();
    await waitFor(() => expect(mocks.auditCalls).toHaveLength(1));
    expect(mocks.auditCalls[0].account).toBe(`0x${"a".repeat(40)}`);
    expect(await screen.findByText("Verified on Arbitrum Sepolia")).toBeTruthy();
    expect(screen.getAllByText("Funded problem statement submitted")).toHaveLength(2);
  });

  it("[QCDAO-79] keeps the posting live when anchoring fails", async () => {
    mocks.auditShouldFail = true;
    render(<CreatePostingPage onNavigate={() => {}} />);
    fillRequired();
    fireEvent.submit(document.querySelector("form"));

    expect(await screen.findByText("Cold-chain route optimisation")).toBeTruthy();
    expect(await screen.findByText("Posting saved; verification needs attention")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Testnet unavailable");
    expect(screen.queryByText(/Nothing you typed has been lost/)).toBeNull();
  });
});

describe("submit while an attachment is still uploading", () => {
  it("[FIT-OPD-017] keeps submit disabled and does not publish until every upload settles", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fillRequired();

    await waitFor(() => expect(typeof mocks.uploader.onPendingChange).toBe("function"));
    await act(async () => { mocks.uploader.onPendingChange(1); });

    const submit = screen.getByRole("button", { name: /submit problem statement/i });
    expect(submit.disabled).toBe(true);

    fireEvent.submit(document.querySelector("form"));
    expect(mocks.created).toHaveLength(0);

    await act(async () => {
      mocks.uploader.onPendingChange(0);
      mocks.uploader.onChange([DRAFT_ATTACHMENT]);
    });

    expect(submit.disabled).toBe(false);
    fireEvent.submit(document.querySelector("form"));

    await waitFor(() => expect(mocks.created).toHaveLength(1));
    expect(mocks.created[0].attachments).toEqual([DRAFT_ATTACHMENT]);
  });
});

describe("cancel abandons completed draft attachments", () => {
  it("[FIT-OPD-018] deletes completed uploads before leaving the form", async () => {
    const onNavigate = vi.fn();
    render(<CreatePostingPage onNavigate={onNavigate} />);

    await waitFor(() => expect(typeof mocks.uploader.onChange).toBe("function"));
    await act(async () => { mocks.uploader.onChange([DRAFT_ATTACHMENT]); });

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("discover"));
    expect(mocks.deleted).toEqual([DRAFT_ATTACHMENT]);
  });
});
