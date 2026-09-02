import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** QCDAO-48 - the funded problem statement form. */

const mocks = vi.hoisted(() => ({
  created: [],
  createShouldFail: false,
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
      attachments: [],
      createdAt: new Date("2026-09-01T00:00:00Z"),
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    };
  },
}));

vi.mock("../../src/lib/attachments.js", () => ({
  deleteAttachment: async () => {},
}));

// Kept out of the way: attachment behaviour has its own suite.
vi.mock("../../src/components/AttachmentUploader.jsx", () => ({
  AttachmentUploader: () => <div data-testid="uploader" />,
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

beforeEach(() => {
  mocks.created = [];
  mocks.createShouldFail = false;
});
afterEach(cleanup);

describe("funding amount input", () => {
  it("[FIT-P48-20] is not a steppable number input", () => {
    // Regression. As type="number" the field stepped its own value on ArrowUp and
    // ArrowDown and on scroll-wheel, so 1000000 silently became 999997 after three
    // arrow presses. A funding figure must never move without being typed.
    render(<CreatePostingPage onNavigate={() => {}} />);
    expect(amountInput().getAttribute("type")).toBe("text");
    expect(amountInput().getAttribute("type")).not.toBe("number");
    expect(amountInput().getAttribute("inputmode")).toBe("numeric");
  });

  it("[FIT-P48-21] does not change value when arrow keys are pressed", () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.change(amountInput(), { target: { value: "1000000" } });

    for (let i = 0; i < 3; i++) {
      fireEvent.keyDown(amountInput(), { key: "ArrowDown", code: "ArrowDown" });
    }
    expect(amountInput().value).toBe("1000000");
  });

  it("[FIT-P48-22] does not change value on scroll wheel", () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.change(amountInput(), { target: { value: "1000000" } });
    fireEvent.wheel(amountInput(), { deltaY: 100 });
    expect(amountInput().value).toBe("1000000");
  });

  it("[FIT-P48-23] strips separators and letters so the stored number is exact", () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.change(amountInput(), { target: { value: "1,000,000" } });
    // Without stripping, Number("1,000,000") is NaN.
    expect(amountInput().value).toBe("1000000");

    fireEvent.change(amountInput(), { target: { value: "80000abc" } });
    expect(amountInput().value).toBe("80000");
  });

  it("[FIT-P48-24] submits exactly the figure that was typed", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fillRequired();
    fireEvent.submit(document.querySelector("form"));

    await waitFor(() => expect(mocks.created).toHaveLength(1));
    expect(mocks.created[0].form.amount).toBe("1000000");
  });
});

describe("no data loss on a failed submit", () => {
  it("[FIT-P48-25] keeps every field when the write is rejected", async () => {
    // Explicit story requirement. Someone who has spent ten minutes writing a
    // problem statement must not lose it because the server said no.
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

  it("[FIT-P48-26] keeps every field when validation fails", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fillRequired();
    // Clear one required field only; everything else must survive.
    fireEvent.change(document.getElementById("summary"), { target: { value: "" } });
    fireEvent.submit(document.querySelector("form"));

    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(document.getElementById("title").value).toBe("Cold-chain route optimisation");
    expect(amountInput().value).toBe("1000000");
    expect(mocks.created).toHaveLength(0);
  });
});
