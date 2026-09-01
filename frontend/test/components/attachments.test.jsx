import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * QCDAO-58 - posting attachments.
 *
 * Runs under vitest rather than node:test because lib/attachments.js reaches
 * lib/firebase.js, which reads import.meta.env - undefined under a bare node
 * runner. The Firebase Storage SDK is mocked so the upload state machine
 * (progress, cancel, failure, removal) can be driven deterministically; the rules
 * that actually enforce PDF-only and the size cap are tested for real against the
 * emulator in firebase/test/storage.rules.test.mjs.
 */

const mocks = vi.hoisted(() => ({
  tasks: [],
  deleted: [],
  deleteShouldFail: false,
  blob: null,
}));

// A stand-in for the UploadTask returned by uploadBytesResumable: records its
// observer so a test can drive progress, completion, cancellation or failure by
// hand instead of waiting on real network timing.
function makeTask(path) {
  const task = {
    path,
    observer: null,
    cancelled: false,
    on(_event, next, error, complete) {
      task.observer = { next, error, complete };
    },
    cancel() {
      task.cancelled = true;
      const failure = new Error("cancelled");
      failure.code = "storage/canceled";
      task.observer?.error(failure);
    },
    emitProgress(bytesTransferred, totalBytes) {
      task.observer?.next({ bytesTransferred, totalBytes });
    },
    finish() {
      task.observer?.complete();
    },
    fail(code) {
      const failure = new Error(code);
      failure.code = code;
      task.observer?.error(failure);
    },
  };
  return task;
}

vi.mock("firebase/storage", () => ({
  ref: (_storage, path) => ({ fullPath: path }),
  uploadBytesResumable: (reference) => {
    const task = makeTask(reference.fullPath);
    mocks.tasks.push(task);
    return task;
  },
  deleteObject: async (reference) => {
    if (mocks.deleteShouldFail) {
      const failure = new Error("denied");
      failure.code = "storage/unauthorized";
      throw failure;
    }
    mocks.deleted.push(reference.fullPath);
  },
  getBlob: async () => mocks.blob,
  connectStorageEmulator: vi.fn(),
  getStorage: vi.fn(),
}));

vi.mock("../../src/lib/firebase.js", () => ({
  storage: {},
  isStorageConfigured: true,
  storageNeedsEmulator: false,
  app: {},
  auth: null,
  db: null,
  functions: null,
}));

const {
  MAX_FILE_BYTES,
  MAX_FILES_PER_POSTING,
  attachmentPath,
  formatBytes,
  hasPdfSignature,
  messageForStorageError,
  safeDisplayName,
  toPostingRecord,
  validateFile,
  validateFileMetadata,
} = await import("../../src/lib/attachments.js");

const { AttachmentUploader } = await import("../../src/components/AttachmentUploader.jsx");

const OWNER = `0x${"a".repeat(40)}`;
const POSTING = "posting123";

function pdfFile(name = "spec.pdf", { size = 1024, valid = true } = {}) {
  const header = valid ? "%PDF-1.7\n" : "<html>not a pdf</html>";
  const padding = "x".repeat(Math.max(0, size - header.length));
  const file = new File([header + padding], name, { type: "application/pdf" });
  // jsdom computes size from content; override so a cap test does not need a
  // genuinely enormous buffer.
  Object.defineProperty(file, "size", { value: size });
  return file;
}

beforeEach(() => {
  mocks.tasks = [];
  mocks.deleted = [];
  mocks.deleteShouldFail = false;
  mocks.blob = null;
});

afterEach(cleanup);

describe("attachment validation", () => {
  it("[FUT-ATT-001] rejects a file that is not named .pdf", () => {
    const file = new File(["data"], "notes.docx", { type: "application/pdf" });
    expect(validateFileMetadata(file)).toMatch(/Only PDF files/);
  });

  it("[FUT-ATT-002] rejects a declared content type other than application/pdf", () => {
    const file = new File(["data"], "notes.pdf", { type: "text/html" });
    expect(validateFileMetadata(file)).toMatch(/text\/html/);
  });

  it("[FUT-ATT-003] tolerates an absent content type, which drag-and-drop can produce", () => {
    const file = new File(["%PDF-1.7"], "notes.pdf", { type: "" });
    expect(validateFileMetadata(file)).toBe(null);
  });

  it("[FUT-ATT-004] rejects a file over the per-file size cap", () => {
    const file = pdfFile("big.pdf", { size: MAX_FILE_BYTES + 1 });
    expect(validateFileMetadata(file)).toMatch(/limit is/);
  });

  it("[FUT-ATT-005] accepts a file exactly on the cap, so the boundary is inclusive", () => {
    const file = pdfFile("edge.pdf", { size: MAX_FILE_BYTES });
    expect(validateFileMetadata(file)).toBe(null);
  });

  it("[FUT-ATT-006] rejects an empty file", () => {
    const file = pdfFile("empty.pdf", { size: 0 });
    expect(validateFileMetadata(file)).toMatch(/empty/);
  });

  it("[FUT-ATT-007] refuses more attachments than a posting may carry", () => {
    const file = pdfFile();
    const error = validateFileMetadata(file, { existingCount: MAX_FILES_PER_POSTING });
    expect(error).toMatch(/at most/);
  });

  it("[FUT-ATT-008] rejects a non-PDF renamed to .pdf, by inspecting the leading bytes", async () => {
    const file = pdfFile("disguised.pdf", { valid: false });
    await expect(validateFile(file)).resolves.toMatch(/contents are not a PDF/);
  });

  it("[FUT-ATT-009] accepts a genuine PDF", async () => {
    await expect(validateFile(pdfFile())).resolves.toBe(null);
    await expect(hasPdfSignature(pdfFile())).resolves.toBe(true);
  });
});

describe("attachment naming and paths", () => {
  it("[FUT-ATT-010] builds the storage path the security rules expect", () => {
    const path = attachmentPath({ ownerId: OWNER.toUpperCase(), problemId: POSTING, attachmentId: "abc123xy" });
    // Lowercased: request.auth.uid is always the lowercase address, and
    // storage.rules compares it to the path segment directly.
    expect(path).toBe(`problems/${OWNER}/${POSTING}/abc123xy.pdf`);
  });

  it("[FUT-ATT-011] strips directory components from a supplied filename", () => {
    expect(safeDisplayName("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(safeDisplayName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
  });

  it("[FUT-ATT-012] keeps ordinary punctuation in a display name", () => {
    expect(safeDisplayName("Q3 report (final).pdf")).toBe("Q3 report (final).pdf");
  });

  it("[FUT-ATT-013] removes control characters that could corrupt rendered output", () => {
    expect(safeDisplayName("re\u0000port\u001b.pdf")).toBe("report.pdf");
  });

  it("[FUT-ATT-013b] removes bidi overrides used to disguise a filename", () => {
    // U+202E reverses how everything after it is DISPLAYED, so this string renders
    // as "reportexe.pdf" while the real name ends in .exe. The name is only ever
    // shown, never executed, but someone deciding whether to open a file should see
    // what it is actually called.
    const spoofed = "report\u202Efdp.exe";
    expect(safeDisplayName(spoofed)).toBe("reportfdp.exe");
    expect(safeDisplayName(spoofed)).not.toContain("\u202E");
  });

  it("[FUT-ATT-014] caps an absurdly long name", () => {
    expect(safeDisplayName(`${"a".repeat(500)}.pdf`).length).toBeLessThanOrEqual(200);
  });

  it("[FUT-ATT-015] formats sizes for display", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("[FUT-ATT-016] narrows an attachment to the fields the posting record allows", () => {
    const record = toPostingRecord({
      id: "abc123xy", name: "a.pdf", size: 10, contentType: "application/pdf",
      path: "problems/x/y/abc123xy.pdf", cancel: () => {}, secret: "leak",
    });
    expect(Object.keys(record).sort()).toEqual(["contentType", "id", "name", "path", "size"]);
  });

  it("[FUT-ATT-017] maps a storage permission failure to actionable language", () => {
    expect(messageForStorageError({ code: "storage/unauthorized" })).toMatch(/permission/);
  });
});

describe("localhost pointed at the production bucket", () => {
  it("[FUT-ATT-027] refuses with a message naming the fix, not a bare CORS error", async () => {
    // storage.cors.json deliberately excludes localhost, so this combination can
    // only ever fail. Failing early with instructions beats failing later with a
    // browser CORS message that names no cause - especially since sign-in,
    // Firestore and functions all keep working, so only attachments break.
    vi.resetModules();
    vi.doMock("../../src/lib/firebase.js", () => ({
      storage: {},
      isStorageConfigured: true,
      storageNeedsEmulator: true,
      app: {}, auth: null, db: null, functions: null,
    }));

    const isolated = await import("../../src/lib/attachments.js");
    expect(() => isolated.uploadAttachment({
      file: pdfFile(),
      ownerId: OWNER,
      problemId: POSTING,
    })).toThrow(/VITE_FIREBASE_USE_EMULATORS=true/);

    vi.doUnmock("../../src/lib/firebase.js");
    vi.resetModules();
  });
});

describe("AttachmentUploader", () => {
  function Harness({ initial = [], onChangeSpy }) {
    const [value, setValue] = React.useState(initial);
    return (
      <AttachmentUploader
        ownerId={OWNER}
        problemId={POSTING}
        value={value}
        onChange={(next) => {
          onChangeSpy?.(next);
          setValue(next);
        }}
      />
    );
  }

  async function selectFiles(files) {
    const input = document.getElementById("attachment-input");
    await act(async () => {
      fireEvent.change(input, { target: { files } });
    });
  }

  it("[FIT-ATT-018] reports upload progress while the transfer runs", async () => {
    render(<Harness />);
    await selectFiles([pdfFile("spec.pdf")]);
    await waitFor(() => expect(mocks.tasks).toHaveLength(1));

    await act(async () => { mocks.tasks[0].emitProgress(50, 100); });
    expect(screen.getByText(/uploading 50%/)).toBeTruthy();

    await act(async () => { mocks.tasks[0].emitProgress(100, 100); });
    expect(screen.getByText(/uploading 100%/)).toBeTruthy();
  });

  it("[FIT-ATT-019] commits the attachment to the posting only once the upload completes", async () => {
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await selectFiles([pdfFile("spec.pdf")]);
    await waitFor(() => expect(mocks.tasks).toHaveLength(1));

    // Mid-flight: nothing has been handed to the posting record yet.
    await act(async () => { mocks.tasks[0].emitProgress(60, 100); });
    expect(onChangeSpy).not.toHaveBeenCalled();

    await act(async () => { mocks.tasks[0].finish(); });
    await waitFor(() => expect(onChangeSpy).toHaveBeenCalledTimes(1));
    expect(onChangeSpy.mock.calls[0][0]).toHaveLength(1);
    expect(screen.getByText("· attached", { exact: false })).toBeTruthy();
  });

  it("[FIT-ATT-020] cancelling an in-flight upload aborts it and stores nothing", async () => {
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    await selectFiles([pdfFile("spec.pdf")]);
    await waitFor(() => expect(mocks.tasks).toHaveLength(1));

    await act(async () => { fireEvent.click(screen.getByText("Cancel")); });

    expect(mocks.tasks[0].cancelled).toBe(true);
    await waitFor(() => expect(screen.queryByText(/uploading/)).toBeNull());
    expect(onChangeSpy).not.toHaveBeenCalled();
    // A cancel is a user action, so it must not surface as an error.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("[FIT-ATT-021] surfaces a genuine upload failure as an error", async () => {
    render(<Harness />);
    await selectFiles([pdfFile("spec.pdf")]);
    await waitFor(() => expect(mocks.tasks).toHaveLength(1));

    await act(async () => { mocks.tasks[0].fail("storage/unauthorized"); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/permission/));
  });

  it("[FIT-ATT-022] removing before publish deletes the stored object, not just the row", async () => {
    const attachment = {
      id: "abc123xy",
      name: "spec.pdf",
      size: 2048,
      contentType: "application/pdf",
      path: `problems/${OWNER}/${POSTING}/abc123xy.pdf`,
    };
    render(<Harness initial={[attachment]} />);

    await act(async () => { fireEvent.click(screen.getByText("Remove")); });

    await waitFor(() => expect(mocks.deleted).toEqual([attachment.path]));
    expect(screen.queryByText("spec.pdf")).toBeNull();
  });

  it("[FIT-ATT-023] restores the row when the delete is refused", async () => {
    mocks.deleteShouldFail = true;
    const attachment = {
      id: "abc123xy",
      name: "spec.pdf",
      size: 2048,
      contentType: "application/pdf",
      path: `problems/${OWNER}/${POSTING}/abc123xy.pdf`,
    };
    render(<Harness initial={[attachment]} />);

    await act(async () => { fireEvent.click(screen.getByText("Remove")); });

    // The row must come back: claiming a file is gone while it is still in the
    // bucket would leave the posting record and Storage permanently disagreeing.
    await waitFor(() => expect(screen.getByText("spec.pdf")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/permission/);
  });

  it("[FIT-ATT-024] keeps both files when two uploads finish at the same time", async () => {
    // Regression test. Each completion handler is created when its own upload
    // starts, so reading `value` from that closure means two simultaneous
    // completions both build their new list from the same stale array and the
    // second overwrites the first. The component reads a ref instead.
    render(<Harness />);
    await selectFiles([pdfFile("one.pdf"), pdfFile("two.pdf")]);
    await waitFor(() => expect(mocks.tasks).toHaveLength(2));

    await act(async () => {
      mocks.tasks[0].finish();
      mocks.tasks[1].finish();
    });

    await waitFor(() => {
      expect(screen.getByText("one.pdf")).toBeTruthy();
      expect(screen.getByText("two.pdf")).toBeTruthy();
    });
  });

  it("[FIT-ATT-025] refuses a selection that would exceed the per-posting limit", async () => {
    const existing = Array.from({ length: MAX_FILES_PER_POSTING }, (_, index) => ({
      id: `existing${index}`,
      name: `file${index}.pdf`,
      size: 1024,
      contentType: "application/pdf",
      path: `problems/${OWNER}/${POSTING}/existing${index}.pdf`,
    }));
    render(<Harness initial={existing} />);

    await selectFiles([pdfFile("extra.pdf")]);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/at most/));
    expect(mocks.tasks).toHaveLength(0);
  });

  it("[FIT-ATT-026] rejects a disguised file without starting an upload", async () => {
    render(<Harness />);
    await selectFiles([pdfFile("disguised.pdf", { valid: false })]);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not a PDF/));
    expect(mocks.tasks).toHaveLength(0);
  });
});
