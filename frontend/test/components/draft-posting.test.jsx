import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** QCDAO-50 - save a posting as a draft and finish it later. */

const mocks = vi.hoisted(() => ({
  lastSaveArgs: null,
  deleted: [],
  uploader: {},
  drafts: [],
  published: [],
  saveShouldFail: false,
  resumed: null,
  resumeGate: null,
  anchoredRecord: null,
}));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: `0x${"a".repeat(40)}`, isConnected: true }),
}));

vi.mock("../../src/lib/firebase.js", () => ({
  db: {}, auth: null, functions: null, storage: {},
  isStorageConfigured: true, storageNeedsEmulator: false, app: {},
}));

vi.mock("../../src/lib/postings.js", () => ({
  POSTING_STATUS_DRAFT: "draft",
  newPostingId: () => "posting123",
  buildPostingDocument: (args) => ({ ...args.form, ownerId: args.ownerId }),
  findPosting: async () => {
    // Lets a test hold the load open and inspect the form mid-flight.
    if (mocks.resumeGate) await mocks.resumeGate;
    return mocks.resumed;
  },
  saveDraft: async (args) => {
    mocks.lastSaveArgs = args;
    if (mocks.saveShouldFail) {
      const failure = new Error("denied");
      failure.code = "permission-denied";
      throw failure;
    }
    mocks.drafts.push(args);
    return { id: args.postingId, ...args.form, updatedAt: new Date("2026-09-01T10:15:00Z") };
  },
  publishDraft: async (args) => {
    mocks.published.push({ ...args, via: "publishDraft" });
    return { id: args.postingId, ...args.form, amount: Number(args.form.amount), categories: args.form.categories, attachments: [], createdAt: new Date("2026-09-01T10:00:00Z"), expiresAt: new Date("2026-12-01T00:00:00Z") };
  },
  createPosting: async (args) => {
    mocks.published.push({ ...args, via: "createPosting" });
    return { id: args.postingId, ...args.form, amount: Number(args.form.amount), categories: args.form.categories, attachments: [], createdAt: new Date("2026-09-01T10:00:00Z"), expiresAt: new Date("2026-12-01T00:00:00Z") };
  },
}));

// The confirmation screen renders AuditReceipt, which runs the real postingAudit
// module and reaches back into the mocked postings.js. Stubbed out here: drafts
// have their own suite and audit anchoring has its own.
vi.mock("../../src/lib/postingAudit.js", () => ({
  postingAuditReceipt: (posting) => posting.audit ?? null,
  readPostingAudit: async () => ({ verified: true }),
  anchorPostingAudit: async (posting) => {
    // Keep the exact document that was hashed, so a rebuild is detectable.
    const { id, audit, ...record } = posting;
    mocks.anchoredRecord = record;
    return { status: "confirmed" };
  },
}));

vi.mock("../../src/lib/attachments.js", () => ({
  deleteAttachment: async ({ attachment }) => { mocks.deleted.push(attachment); },
}));
vi.mock("../../src/components/AttachmentUploader.jsx", () => ({
  // Captures onChange so a test can hand the form an uploaded file.
  AttachmentUploader: (props) => {
    mocks.uploader.onChange = props.onChange;
    return <div data-testid="uploader" />;
  },
}));
// Pulls in the real wagmi config at import time, which the bare wagmi mock breaks.
vi.mock("../../src/components/ConnectWalletModal.jsx", () => ({
  ConnectWalletModal: () => <div role="dialog">Reconnect wallet</div>,
}));
vi.mock("../../src/context/SessionContext.jsx", () => ({
  useSession: () => ({
    address: `0x${"a".repeat(40)}`,
    profile: { organisation: "Singapore Management University" },
    isSignedIn: true,
  }),
}));

const { default: CreatePostingPage } = await import("../../src/pages/CreatePostingPage.jsx");

const field = (id) => document.getElementById(id);
const saveDraftButton = () => screen.getByRole("button", { name: /save as draft/i });

beforeEach(() => {
  mocks.drafts = [];
  mocks.published = [];
  mocks.saveShouldFail = false;
  mocks.resumed = null;
  mocks.resumeGate = null;
  mocks.lastSaveArgs = null;
  mocks.deleted = [];
  mocks.uploader = {};
});
afterEach(cleanup);

describe("saving a draft", () => {
  it("[FIT-P50-01] saves with every mandatory field still empty", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.click(saveDraftButton());

    await waitFor(() => expect(mocks.drafts).toHaveLength(1));
    expect(mocks.drafts[0].form.title).toBe("");
    expect(mocks.drafts[0].form.categories).toEqual([]);
    // No validation errors: incompleteness is the whole point of a draft.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("[FIT-P50-02] saves whatever has been typed so far", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.change(field("title"), { target: { value: "Half-written idea" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Robotics/i }));
    fireEvent.click(saveDraftButton());

    await waitFor(() => expect(mocks.drafts).toHaveLength(1));
    expect(mocks.drafts[0].form.title).toBe("Half-written idea");
    expect(mocks.drafts[0].form.categories).toEqual(["robotics"]);
  });

  it("[FIT-P50-03] states when the draft was saved, in the global format", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    expect(screen.getByText(/not saved yet/i)).toBeTruthy();

    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(screen.getByText("2026-09-01 10:15:00 UTC")).toBeTruthy());
    expect(screen.getByText(/draft saved/i)).toBeTruthy();
  });

  it("[FIT-P50-04] reports a rejected save without losing the form", async () => {
    mocks.saveShouldFail = true;
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.change(field("title"), { target: { value: "Keep me" } });
    fireEvent.click(saveDraftButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(field("title").value).toBe("Keep me");
  });

  // Bug 2: the leave prompt navigated after persistDraft() regardless of outcome,
  // so a rejected save unmounted the form and lost the work it offered to keep.
  it("[FIT-P50-39] stays on the form when 'save and leave' is rejected", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.change(field("title"), { target: { value: "Precious" } });

    await act(async () => { window.location.hash = "#/discover"; });
    const saveAndLeave = await screen.findByRole("button", { name: /save as draft and leave/i });

    mocks.saveShouldFail = true;
    await act(async () => { fireEvent.click(saveAndLeave); });

    // The dialog staying open is the signal: dismissing it is what releases the
    // navigation, and the work must still be here to retry.
    expect(screen.queryByRole("button", { name: /save as draft and leave/i })).toBeTruthy();
    expect(field("title").value).toBe("Precious");
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
  });
});

describe("resuming a draft", () => {
  const stored = {
    id: "posting123",
    title: "Cold-chain route optimisation",
    businessContext: "Perishable deliveries.",
    summary: "Routing degrades under spikes.",
    currentApproach: "A nightly solver.",
    currentLimitations: "Runtime grows.",
    expectedOutcome: "Thirty minute window.",
    successCriteria: "Ten percent lower distance.",
    dataAvailability: "Two years of telemetry.",
    categories: ["ai", "robotics"],
    amount: 80000,
    currency: "USD",
    attachments: [],
    updatedAt: new Date("2026-09-01T10:15:00Z"),
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  };

  // Bug 5: the window was derived from now, not createdAt, so a 90-day draft
  // reopened weeks later snapped to 60 or 30 and the next save wrote that back.
  it("[FIT-P50-40] keeps the window the owner chose, not the time remaining", async () => {
    const created = new Date("2026-08-01T00:00:00Z");
    mocks.resumed = {
      ...stored,
      createdAt: created,
      // 90 days from creation, but only ~50 days remain as of "now".
      expiresAt: new Date(created.getTime() + 90 * 24 * 60 * 60 * 1000),
    };
    render(<CreatePostingPage postingId="posting123" onNavigate={() => {}} />);

    await waitFor(() => expect(field("title").value).toBe("Cold-chain route optimisation"));
    expect(field("expiryDays").value).toBe("90");
  });

  // Bug 6: the form was interactive while findPosting ran, so typing was
  // overwritten by the load and a save could run with draftExists still false.
  it("[FIT-P50-41] is inert until the draft has loaded", async () => {
    let release;
    mocks.resumed = stored;
    mocks.resumeGate = new Promise((resolve) => { release = resolve; });
    render(<CreatePostingPage postingId="posting123" onNavigate={() => {}} />);

    // One fieldset wraps every control, so disabling it disables them all in a
    // browser. jsdom does not cascade that to descendants, so assert the
    // fieldset itself - that is the mechanism - and that it contains the fields.
    const body = document.querySelector("fieldset.form-body");
    expect(body.disabled).toBe(true);
    expect(body.contains(field("title"))).toBe(true);
    expect(body.contains(saveDraftButton())).toBe(true);

    await act(async () => { release(); mocks.resumeGate = null; });
    await waitFor(() => expect(body.disabled).toBe(false));
    expect(field("title").value).toBe("Cold-chain route optimisation");
  });

  it("[FIT-P50-05] restores every previously entered field", async () => {
    mocks.resumed = stored;
    render(<CreatePostingPage postingId="posting123" onNavigate={() => {}} />);

    await waitFor(() => expect(field("title").value).toBe("Cold-chain route optimisation"));
    expect(field("businessContext").value).toBe("Perishable deliveries.");
    expect(field("summary").value).toBe("Routing degrades under spikes.");
    expect(field("currentApproach").value).toBe("A nightly solver.");
    expect(field("currentLimitations").value).toBe("Runtime grows.");
    expect(field("expectedOutcome").value).toBe("Thirty minute window.");
    expect(field("successCriteria").value).toBe("Ten percent lower distance.");
    expect(field("dataAvailability").value).toBe("Two years of telemetry.");
    expect(field("amount").value).toBe("80000");
    expect(field("currency").value).toBe("USD");
    expect(screen.getByRole("checkbox", { name: /AI & machine learning/i }).checked).toBe(true);
    expect(screen.getByRole("checkbox", { name: /Robotics/i }).checked).toBe(true);
  });

  it("[FIT-P50-06] shows when that draft was last saved", async () => {
    mocks.resumed = stored;
    render(<CreatePostingPage postingId="posting123" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("2026-09-01 10:15:00 UTC")).toBeTruthy());
  });

  it("[FIT-P50-07] publishes a resumed draft as an update, not a second record", async () => {
    // createPosting would create a duplicate; the draft already exists.
    mocks.resumed = stored;
    render(<CreatePostingPage postingId="posting123" onNavigate={() => {}} />);
    await waitFor(() => expect(field("title").value).toBe("Cold-chain route optimisation"));

    fireEvent.submit(document.querySelector("form"));
    await waitFor(() => expect(mocks.published).toHaveLength(1));
    expect(mocks.published[0].via).toBe("publishDraft");
    // The confirmation screen must actually render; it was crashing silently.
    await waitFor(() => expect(screen.getByText(/posting submitted/i)).toBeTruthy());
  });
});

describe("publishing", () => {
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
      fireEvent.change(field(id), { target: { value } });
    }
    fireEvent.click(screen.getByRole("checkbox", { name: /AI & machine learning/i }));
    fireEvent.change(field("amount"), { target: { value: "80000" } });
  }

  it("[FIT-P50-08] applies full validation at publish, not at save", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);

    // Saving an empty form is fine.
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(1));

    // Publishing the same empty form is not.
    fireEvent.submit(document.querySelector("form"));
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    expect(mocks.published).toHaveLength(0);
  });

  it("[FIT-P50-09] publishes a saved draft through publishDraft", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(1));

    fillRequired();
    fireEvent.submit(document.querySelector("form"));
    await waitFor(() => expect(mocks.published).toHaveLength(1));
    expect(mocks.published[0].via).toBe("publishDraft");
    await waitFor(() => expect(screen.getByText(/posting submitted/i)).toBeTruthy());
  });

  // Bug 1: startAnother minted a new id but left draftExists set, so the next
  // submit went down publishDraft() against a document that does not exist.
  it("[FIT-P50-42] posting another problem creates, it does not publish a draft", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(1));

    fillRequired();
    fireEvent.submit(document.querySelector("form"));
    await waitFor(() => expect(mocks.published).toHaveLength(1));
    expect(mocks.published[0].via).toBe("publishDraft");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /post another problem/i }));
    });
    expect(screen.getByText(/not saved yet/i)).toBeTruthy();

    fillRequired();
    fireEvent.submit(document.querySelector("form"));
    await waitFor(() => expect(mocks.published).toHaveLength(2));
    expect(mocks.published[1].via).toBe("createPosting");
  });

  // The contract is authoritative for the audit, so publishing a draft must anchor
  // on-chain WITHOUT writing the receipt into Firestore - same as a direct submit.
  it("[FIT-P50-37] anchors on publish without persisting the receipt", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(1));

    fillRequired();
    fireEvent.submit(document.querySelector("form"));
    await waitFor(() => expect(mocks.published).toHaveLength(1));
    expect(mocks.published[0].via).toBe("publishDraft");
    expect(mocks.published[0].audit).toBeUndefined();
    // The anchored record IS reused - rebuilding it would derive a fresh
    // expiresAt that no longer matches the confirmed hash - but the receipt
    // itself still must not be written into Firestore.
    expect(mocks.published[0].record).toBeDefined();
    expect(mocks.published[0].record.audit).toBeUndefined();
  });

  // Bug 4: publishDraft used to rebuild the document from `now`, so expiresAt
  // drifted from the value that was hashed and anchored.
  it("[FIT-P50-38] publishes the exact document that was anchored", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(1));

    fillRequired();
    fireEvent.submit(document.querySelector("form"));
    await waitFor(() => expect(mocks.published).toHaveLength(1));
    expect(mocks.published[0].record).toEqual(mocks.anchoredRecord);
  });

  it("[FIT-P50-10] creates outright when the form was never saved", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fillRequired();
    fireEvent.submit(document.querySelector("form"));

    await waitFor(() => expect(mocks.published).toHaveLength(1));
    expect(mocks.published[0].via).toBe("createPosting");
    await waitFor(() => expect(screen.getByText(/posting submitted/i)).toBeTruthy());
  });
});

describe("existence flag on save", () => {
  it("[FIT-P50-22] creates on the first save and updates on the second", async () => {
    // saveDraft must not read the record to find out. The read rule dereferences
    // resource.data, so a get on a posting that does not exist yet is DENIED -
    // which surfaced to the user as "rejected by our security rules".
    render(<CreatePostingPage onNavigate={() => {}} />);

    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(1));
    expect(mocks.lastSaveArgs.exists).toBe(false);

    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(2));
    expect(mocks.lastSaveArgs.exists).toBe(true);
  });

  it("[FIT-P50-23] updates when a draft was resumed", async () => {
    mocks.resumed = { id: "posting123", title: "Resumed", categories: [], attachments: [], updatedAt: new Date() };
    render(<CreatePostingPage postingId="posting123" onNavigate={() => {}} />);
    await waitFor(() => expect(field("title").value).toBe("Resumed"));

    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(1));
    expect(mocks.lastSaveArgs.exists).toBe(true);
  });
});

describe("leaving with unsaved work", () => {
  it("[FIT-P50-24] leaves immediately when nothing has been entered", async () => {
    const onNavigate = vi.fn();
    render(<CreatePostingPage onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("discover"));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
  });

  it("[FIT-P50-25] prompts when anything has been typed", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.change(field("title"), { target: { value: "Half an idea" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(screen.getByText(/save this as a draft/i)).toBeTruthy();
  });

  it("[FIT-P50-26] prompts when only a category was picked", async () => {
    // Selecting a technology area is work too, even with no text entered.
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Robotics/i }));
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(screen.getByText(/save this as a draft/i)).toBeTruthy();
  });

  it("[FIT-P50-27] saves then leaves when asked to", async () => {
    const onNavigate = vi.fn();
    render(<CreatePostingPage onNavigate={onNavigate} />);
    fireEvent.change(field("title"), { target: { value: "Keep this" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(screen.getByText(/save as draft and leave/i));

    await waitFor(() => expect(mocks.drafts).toHaveLength(1));
    expect(mocks.drafts[0].form.title).toBe("Keep this");
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("discover"));
    // Exactly ONE write. A second persistDraft still sees draftExists false from
    // its closure, re-issues setDoc, and Firestore rejects it for moving
    // createdAt - so the leave fails on the very first unsaved draft.
    expect(mocks.drafts).toHaveLength(1);
  });

  it("[FIT-P50-28] leaves without saving when told to discard", async () => {
    const onNavigate = vi.fn();
    render(<CreatePostingPage onNavigate={onNavigate} />);
    fireEvent.change(field("title"), { target: { value: "Throw away" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(screen.getByText(/^discard/i));

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("discover"));
    expect(mocks.drafts).toHaveLength(0);
  });

  it("[FIT-P50-29] stays put when the prompt is dismissed", async () => {
    const onNavigate = vi.fn();
    render(<CreatePostingPage onNavigate={onNavigate} />);
    fireEvent.change(field("title"), { target: { value: "Still working" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(screen.getByText(/keep editing/i));

    await waitFor(() => expect(screen.queryByText(/save this as a draft/i)).toBeNull());
    expect(onNavigate).not.toHaveBeenCalled();
    expect(field("title").value).toBe("Still working");
  });
});

describe("prompting only for unsaved work", () => {
  it("[FIT-P50-30] does not prompt again after the draft was just saved", async () => {
    // Saving makes the form clean. Being asked to save what was already saved is
    // the bug this covers.
    const onNavigate = vi.fn();
    render(<CreatePostingPage onNavigate={onNavigate} />);
    fireEvent.change(field("title"), { target: { value: "Saved already" } });

    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("discover"));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
  });

  it("[FIT-P50-31] prompts again once something changes after the save", async () => {
    render(<CreatePostingPage onNavigate={() => {}} />);
    fireEvent.change(field("title"), { target: { value: "First" } });
    fireEvent.click(saveDraftButton());
    await waitFor(() => expect(mocks.drafts).toHaveLength(1));

    fireEvent.change(field("title"), { target: { value: "Changed after saving" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.getByText(/save this as a draft/i)).toBeTruthy();
  });

  it("[FIT-P50-32] does not prompt when a resumed draft is left untouched", async () => {
    const onNavigate = vi.fn();
    mocks.resumed = {
      id: "posting123", title: "Untouched", summary: "As saved",
      categories: ["ai"], amount: 500, currency: "SGD",
      attachments: [], updatedAt: new Date("2026-09-01T10:15:00Z"),
    };
    render(<CreatePostingPage postingId="posting123" onNavigate={onNavigate} />);
    await waitFor(() => expect(field("title").value).toBe("Untouched"));

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith("discover"));
    expect(screen.queryByText(/save this as a draft/i)).toBeNull();
  });

  it("[FIT-P50-33] prompts when a resumed draft is edited", async () => {
    mocks.resumed = {
      id: "posting123", title: "Untouched", summary: "As saved",
      categories: ["ai"], amount: 500, currency: "SGD",
      attachments: [], updatedAt: new Date("2026-09-01T10:15:00Z"),
    };
    render(<CreatePostingPage postingId="posting123" onNavigate={() => {}} />);
    await waitFor(() => expect(field("title").value).toBe("Untouched"));

    fireEvent.change(field("summary"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(screen.getByText(/save this as a draft/i)).toBeTruthy();
  });
});

describe("discarding rolls back to the last save", () => {
  const SAVED_FILE = { id: "saved1", name: "kept.pdf", size: 10, contentType: "application/pdf" };
  const NEW_FILE = { id: "new1", name: "unsaved.pdf", size: 10, contentType: "application/pdf" };

  it("[FIT-P50-34] keeps files the saved draft references", async () => {
    // Deleting these would gut the very draft the user chose to keep.
    mocks.resumed = {
      id: "posting123", title: "Has a file", categories: [],
      attachments: [SAVED_FILE], updatedAt: new Date("2026-09-01T10:15:00Z"),
    };
    render(<CreatePostingPage postingId="posting123" onNavigate={() => {}} />);
    await waitFor(() => expect(field("title").value).toBe("Has a file"));

    fireEvent.change(field("summary"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(screen.getByText(/^discard/i));

    await waitFor(() => expect(mocks.deleted).toEqual([]));
  });

  it("[FIT-P50-35] removes only files added since the last save", async () => {
    mocks.resumed = {
      id: "posting123", title: "Has a file", categories: [],
      attachments: [SAVED_FILE], updatedAt: new Date("2026-09-01T10:15:00Z"),
    };
    render(<CreatePostingPage postingId="posting123" onNavigate={() => {}} />);
    await waitFor(() => expect(field("title").value).toBe("Has a file"));

    await act(async () => { mocks.uploader.onChange([SAVED_FILE, NEW_FILE]); });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(screen.getByText(/^discard/i));

    await waitFor(() => expect(mocks.deleted).toEqual([NEW_FILE]));
  });

  it("[FIT-P50-36] removes everything when no draft was ever saved", async () => {
    // Nothing was persisted, so nothing should linger in My Problems either.
    render(<CreatePostingPage onNavigate={() => {}} />);
    await waitFor(() => expect(typeof mocks.uploader.onChange).toBe("function"));
    await act(async () => { mocks.uploader.onChange([NEW_FILE]); });

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    fireEvent.click(screen.getByText(/^discard/i));

    await waitFor(() => expect(mocks.deleted).toEqual([NEW_FILE]));
    expect(mocks.drafts).toHaveLength(0);
  });
});
