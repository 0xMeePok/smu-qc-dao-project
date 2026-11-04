import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPORT_NOTICE, latestCurrentDate } from "../../../firebase/functions/proposalExportNotice.js";

const mocks = vi.hoisted(() => ({
  exportSelected: vi.fn(),
  list: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../../src/lib/proposalExport.js", () => ({
  exportSelectedProposals: mocks.exportSelected,
  listExportableProposals: mocks.list,
}));
vi.mock("../../src/lib/attachments.js", () => ({ saveBlobAs: mocks.save }));

import { ProposalExportPanel } from "../../src/components/ProposalExportPanel.jsx";

const proposals = [
  { id: "proposal-a", title: "Annealing study", status: "submitted", workflowStatus: "submitted", workflowLabel: "Submitted", accepted: false, problemTitle: "Routing study" },
  { id: "proposal-b", title: "Cold chain", status: "accepted", workflowStatus: "accepted", workflowLabel: "Accepted", accepted: true, problemTitle: "Grant call" },
];

const exported = {
  postingCount: 1,
  proposalCount: 1,
  commentCount: 2,
  document: { schemaVersion: 2, notice: EXPORT_NOTICE, postings: [{ id: "posting-a" }] },
  csv: "schemaVersion,commentBody\r\n2,Recommend\r\n",
};

afterEach(() => {
  cleanup();
  mocks.exportSelected.mockReset();
  mocks.list.mockReset();
  mocks.save.mockReset();
});

describe("QCDAO-107 proposal export panel", () => {
  it("says that grading and distribution happen outside the platform", async () => {
    mocks.list.mockResolvedValue({ proposals: [] });
    render(<ProposalExportPanel />);
    expect(screen.getByText("Grading happens outside QC DAO")).toBeTruthy();
    expect(screen.getByText(EXPORT_NOTICE)).toBeTruthy();
    expect(await screen.findByRole("option", { name: "Choose a proposal" })).toBeTruthy();
  });

  it("asks for a proposal before calling the export", async () => {
    mocks.list.mockResolvedValue({ proposals });
    render(<ProposalExportPanel />);
    expect(await screen.findByRole("option", { name: "Cold chain — Accepted · Grant call" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Annealing study — Submitted · Routing study" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download JSON and CSV" }));
    expect(screen.getByRole("alert").textContent).toMatch(/choose a proposal/i);
    expect(mocks.exportSelected).not.toHaveBeenCalled();
  });

  it("downloads the JSON and CSV for the proposal chosen in the dropdown", async () => {
    mocks.list.mockResolvedValue({ proposals });
    mocks.exportSelected.mockResolvedValue(exported);
    render(<ProposalExportPanel />);
    await screen.findByRole("option", { name: "Cold chain — Accepted · Grant call" });
    fireEvent.change(screen.getByLabelText("Proposal"), { target: { value: "proposal-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Download JSON and CSV" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mocks.exportSelected).toHaveBeenCalledWith({ proposalId: "proposal-b", acceptance: "accepted" }, expect.objectContaining({ signal: expect.any(AbortSignal), onPart: expect.any(Function), onProgress: expect.any(Function) }));
    expect(mocks.save.mock.calls[0][1]).toBe("qcdao-proposals-proposal-b.json");
    expect(mocks.save.mock.calls[1][1]).toBe("qcdao-proposals-proposal-b.csv");
  });

  it("caps the end date at the latest current date and exports the chosen range", async () => {
    mocks.list.mockResolvedValue({ proposals: [] });
    mocks.exportSelected.mockResolvedValue({ ...exported, postingCount: 3, commentCount: 8 });
    render(<ProposalExportPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "Proposals in a date range" }));
    const end = screen.getByLabelText("End date");
    expect(end.max).toBe(latestCurrentDate());
    expect(screen.getByLabelText("Start date").max).toBe(latestCurrentDate());
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2020-01-01" } });
    fireEvent.change(end, { target: { value: latestCurrentDate() } });
    fireEvent.click(screen.getByRole("button", { name: "Download JSON and CSV" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mocks.exportSelected).toHaveBeenCalledWith({ startDate: "2020-01-01", endDate: latestCurrentDate(), acceptance: "accepted" }, expect.any(Object));
  });

  it("shows the reason an export was refused and does not download a file", async () => {
    mocks.list.mockResolvedValue({ proposals });
    mocks.exportSelected.mockRejectedValue(new Error("Draft proposals are not exported."));
    render(<ProposalExportPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "Accepted and not accepted" }));
    await screen.findByRole("option", { name: "Annealing study — Submitted · Routing study" });
    fireEvent.change(screen.getByLabelText("Proposal"), { target: { value: "proposal-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Download JSON and CSV" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/Draft proposals/);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.exportSelected).toHaveBeenCalledWith({ proposalId: "proposal-a", acceptance: "all" }, expect.any(Object));
  });
});


describe("proposal export progress and numbered files", () => {
  async function start() {
    mocks.list.mockResolvedValue({ proposals });
    const view = render(<ProposalExportPanel />);
    await screen.findByRole("option", { name: "Cold chain — Accepted · Grant call" });
    fireEvent.change(screen.getByLabelText("Proposal"), { target: { value: "proposal-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Download JSON and CSV" }));
    return view;
  }
  it("shows comment progress and allows the running export to stop", async () => {
    mocks.exportSelected.mockImplementation((_, { signal, onProgress }) => {
      onProgress({ commentCount: 1001 });
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Export stopped.", "AbortError")), { once: true }));
    });
    await start();
    expect(screen.getByRole("status").textContent).toMatch(/1001 comments/);
    fireEvent.click(screen.getByRole("button", { name: "Stop export" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Export stopped/);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("downloads each numbered pair immediately and only creates a completion manifest on success", async () => {
    mocks.exportSelected.mockImplementation(async (_, { onPart }) => {
      onPart({ document: exported.document, csv: exported.csv, exportId: "session-a", partNumber: 1 });
      onPart({ document: exported.document, csv: exported.csv, exportId: "session-a", partNumber: 2 });
      return { ...exported, document: undefined, csv: undefined, multipart: true, manifest: { exportId: "session-a", auditId: "audit-a", partCount: 2, status: "complete" } };
    });
    await start();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(5));
    expect(mocks.save.mock.calls.map(([, name]) => name)).toEqual([
      "qcdao-proposals-session-a-part1.json", "qcdao-proposals-session-a-part1.csv",
      "qcdao-proposals-session-a-part2.json", "qcdao-proposals-session-a-part2.csv",
      "qcdao-proposals-session-a-complete.manifest.json",
    ]);
    expect(screen.getByRole("status").textContent).toMatch(/2 numbered parts and the completion manifest/);
  });
  it("labels already downloaded parts incomplete after a late failure and shows no success", async () => {
    mocks.exportSelected.mockImplementation(async (_, { onPart }) => {
      onPart({ document: exported.document, csv: exported.csv, exportId: "session-a", partNumber: 1 });
      throw new Error("Access changed.");
    });
    await start();
    expect((await screen.findByRole("alert")).textContent).toMatch(/downloaded parts are incomplete.*No completion manifest/);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("aborts on unmount and never downloads a late result", async () => {
    let resolve;
    mocks.exportSelected.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = await start();
    const signal = mocks.exportSelected.mock.calls[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    resolve(exported);
    await Promise.resolve();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
