import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  uid: `0x${"b".repeat(40)}`, emulator: false, appCheck: {},
  getIdToken: vi.fn(), getAppCheckToken: vi.fn(), getBlob: vi.fn(), fetch: vi.fn(),
}));
vi.mock("firebase/storage", () => ({
  ref: (_storage, path) => ({ fullPath: path }), getBlob: (...args) => state.getBlob(...args),
  uploadBytesResumable: vi.fn(),
}));
vi.mock("firebase/functions", () => ({ httpsCallable: vi.fn() }));
vi.mock("firebase/app-check", () => ({ getToken: (...args) => state.getAppCheckToken(...args) }));
vi.mock("../../src/lib/firebase.js", () => ({
  storage: {}, isStorageConfigured: true, storageNeedsEmulator: false,
  auth: { get currentUser() { return state.uid ? { uid: state.uid, getIdToken: state.getIdToken } : null; } },
  get appCheck() { return state.appCheck; }, get isUsingEmulators() { return state.emulator; },
  functions: { app: { options: { projectId: "qc-dao-demo" } } }, FUNCTIONS_REGION: "asia-southeast1",
}));

import { downloadAttachment, sha256Blob } from "../../src/lib/attachments.js";
const AUTHOR = `0x${"a".repeat(40)}`;
const args = { attachment: { id: "support01" }, ownerId: AUTHOR, problemId: "proposal1", scope: "proposals" };
beforeEach(() => {
  state.uid = `0x${"b".repeat(40)}`; state.emulator = false; state.appCheck = {};
  state.getIdToken.mockReset().mockResolvedValue("identity");
  state.getAppCheckToken.mockReset().mockResolvedValue({ token: "attestation" });
  state.getBlob.mockReset().mockResolvedValue(new Blob(["%PDF-direct"]));
  state.fetch.mockReset().mockResolvedValue({ ok: true, blob: async () => new Blob(["%PDF-proxy"]) });
  vi.stubGlobal("fetch", state.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("proposal PDF download authorization transport", () => {
  it("sends ID and App Check headers to the raw production endpoint for a non-author", async () => {
    const blob = await downloadAttachment(args);
    expect(blob.size).toBe(10);
    expect(state.fetch).toHaveBeenCalledWith(
      "https://asia-southeast1-qc-dao-demo.cloudfunctions.net/downloadProposalAttachment?proposalId=proposal1&attachmentId=support01",
      { method: "GET", headers: { Authorization: "Bearer identity", "X-Firebase-AppCheck": "attestation" },
        cache: "no-store", credentials: "omit", redirect: "error" },
    );
    expect(state.getBlob).not.toHaveBeenCalled();
  });

  it("keeps author pre-save preview and posting downloads on authenticated Storage", async () => {
    state.uid = AUTHOR;
    await downloadAttachment(args);
    expect(state.getBlob).toHaveBeenCalledWith({ fullPath: `proposals/${AUTHOR}/proposal1/support01.pdf` });
    state.uid = `0x${"b".repeat(40)}`;
    await downloadAttachment({ ...args, scope: "problems" });
    expect(state.getBlob).toHaveBeenLastCalledWith({ fullPath: `problems/${AUTHOR}/proposal1/support01.pdf` });
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it("uses the emulator endpoint and bypasses only emulator attestation", async () => {
    state.emulator = true; state.appCheck = null;
    await downloadAttachment(args);
    expect(state.fetch.mock.calls[0][0]).toBe(
      "http://127.0.0.1:5001/qc-dao-demo/asia-southeast1/downloadProposalAttachment?proposalId=proposal1&attachmentId=support01",
    );
    expect(state.fetch.mock.calls[0][1].headers).toEqual({ Authorization: "Bearer identity" });
    expect(state.getAppCheckToken).not.toHaveBeenCalled();
  });

  it("fails closed without a user or production App Check", async () => {
    state.uid = null;
    await expect(downloadAttachment(args)).rejects.toMatchObject({ code: "storage/unauthenticated" });
    state.uid = `0x${"b".repeat(40)}`; state.appCheck = null;
    await expect(downloadAttachment(args)).rejects.toMatchObject({ code: "storage/unauthorized" });
    expect(state.fetch).not.toHaveBeenCalled(); expect(state.getBlob).not.toHaveBeenCalled();
  });

  it.each([[401, "storage/unauthenticated"], [403, "storage/unauthorized"], [404, "storage/object-not-found"],
    [500, "storage/download-failed"]])("maps HTTP %s without falling back to direct Storage", async (status, code) => {
    state.fetch.mockResolvedValue({ ok: false, status });
    await expect(downloadAttachment(args)).rejects.toMatchObject({ code });
    expect(state.getBlob).not.toHaveBeenCalled();
  });

  it("retains digest verification for proxy bytes", async () => {
    const blob = new Blob(["%PDF-matching"]);
    state.fetch.mockResolvedValue({ ok: true, blob: async () => blob });
    await expect(downloadAttachment({ ...args, attachment: { id: "support01", sha256: await sha256Blob(blob) } })).resolves.toBe(blob);
    await expect(downloadAttachment({ ...args, attachment: { id: "support01", sha256: `0x${"1".repeat(64)}` } }))
      .rejects.toMatchObject({ code: "storage/integrity-check-failed" });
  });
});
