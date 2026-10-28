import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(mocks.exportSelected).toHaveBeenCalledWith({ proposalId: "proposal-b", acceptance: "accepted" });
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
    expect(mocks.exportSelected).toHaveBeenCalledWith({ startDate: "2020-01-01", endDate: latestCurrentDate(), acceptance: "accepted" });
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
    expect(mocks.exportSelected).toHaveBeenCalledWith({ proposalId: "proposal-a", acceptance: "all" });
  });
});
