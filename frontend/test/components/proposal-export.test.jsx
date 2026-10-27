import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPORT_NOTICE } from "../../../firebase/functions/proposalExportNotice.js";

const mocks = vi.hoisted(() => ({
  exportSelected: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../../src/lib/proposalExport.js", () => ({ exportSelectedProposals: mocks.exportSelected }));
vi.mock("../../src/lib/attachments.js", () => ({ saveBlobAs: mocks.save }));

import { ProposalExportPanel } from "../../src/components/ProposalExportPanel.jsx";

const exported = {
  postingCount: 1,
  proposalCount: 1,
  commentCount: 2,
  document: { schemaVersion: 1, notice: EXPORT_NOTICE, postings: [{ id: "posting-a" }] },
  csv: "schemaVersion,commentBody\r\n1,Recommend\r\n",
};

afterEach(() => {
  cleanup();
  mocks.exportSelected.mockReset();
  mocks.save.mockReset();
});

describe("QCDAO-107 proposal export panel", () => {
  it("says that grading and distribution happen outside the platform", () => {
    render(<ProposalExportPanel />);
    expect(screen.getByText("Grading happens outside QC DAO")).toBeTruthy();
    expect(screen.getByText(EXPORT_NOTICE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download JSON and CSV" })).toBeTruthy();
  });

  it("asks for a posting id before calling the export", () => {
    render(<ProposalExportPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Download JSON and CSV" }));
    expect(screen.getByRole("alert").textContent).toMatch(/posting id/i);
    expect(mocks.exportSelected).not.toHaveBeenCalled();
  });

  it("downloads the JSON and CSV for one accepted posting", async () => {
    mocks.exportSelected.mockResolvedValue(exported);
    render(<ProposalExportPanel />);
    fireEvent.change(screen.getByLabelText("Posting id"), { target: { value: "posting-a" } });
    fireEvent.click(screen.getByRole("button", { name: "Download JSON and CSV" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/1 posting, 1 proposal and 2 comments/);
    expect(screen.getByRole("status").textContent).toMatch(/audit trail/);
    expect(mocks.exportSelected).toHaveBeenCalledWith({ postingId: "posting-a" });
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.save.mock.calls[0][1]).toBe("qcdao-selected-proposals-posting-a.json");
    expect(mocks.save.mock.calls[1][1]).toBe("qcdao-selected-proposals-posting-a.csv");
    expect(mocks.save.mock.calls[0][0].type).toBe("application/json");
    expect(mocks.save.mock.calls[0][0].size).toBeGreaterThan(0);
    expect(mocks.save.mock.calls[1][0].type).toContain("text/csv");
    expect(mocks.save.mock.calls[1][0].size).toBeGreaterThan(0);
  });

  it("exports every accepted posting in the chosen dates", async () => {
    mocks.exportSelected.mockResolvedValue({ ...exported, postingCount: 3, commentCount: 8 });
    render(<ProposalExportPanel />);
    fireEvent.click(screen.getByRole("radio", { name: "Accepted postings in a date range" }));
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("End date"), { target: { value: "2026-10-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Download JSON and CSV" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mocks.exportSelected).toHaveBeenCalledWith({ startDate: "2026-10-01", endDate: "2026-10-31" });
    expect(mocks.save.mock.calls[0][1]).toBe("qcdao-selected-proposals-2026-10-01_2026-10-31.json");
    expect(mocks.save.mock.calls[1][1]).toBe("qcdao-selected-proposals-2026-10-01_2026-10-31.csv");
  });

  it("shows the reason an export was refused and does not download a file", async () => {
    mocks.exportSelected.mockRejectedValue(new Error("Only an accepted posting can be exported. This posting has no accepted proposal."));
    render(<ProposalExportPanel />);
    fireEvent.change(screen.getByLabelText("Posting id"), { target: { value: "still-open" } });
    fireEvent.click(screen.getByRole("button", { name: "Download JSON and CSV" }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/no accepted proposal/);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
