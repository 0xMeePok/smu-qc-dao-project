import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../../src/components/Modal.jsx";
import { OpportunityTypeSwitch } from "../../src/components/OpportunityTypeSwitch.jsx";
import { DiscoverySearchRow, DiscoveryTable } from "../../src/components/DiscoveryControls.jsx";
import { UserManagementTable } from "../../src/components/UserManagementTable.jsx";

afterEach(cleanup);

async function expectAccessible(node) {
  const results = await axe.run(node, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  const details = results.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${violation.help} (${node.target.join(" ")})`),
  );
  expect(details).toEqual([]);
}

describe("QA pass: names, states and responsive markup", () => {
  it("names a dialog after its heading when no labelledBy is given", async () => {
    render(
      <Modal onDismiss={() => {}}>
        <h2>Suspend account</h2>
        <button type="button">Confirm</button>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "Suspend account" });
    await expectAccessible(dialog);
  });

  it("gives opportunity type cards a name, a description and a pressed state", async () => {
    const onNavigate = vi.fn();
    const { container } = render(<OpportunityTypeSwitch activeType="business-problem" onNavigate={onNavigate} />);
    const group = screen.getByRole("group", { name: "Opportunity type" });
    const current = within(group).getByRole("button", { name: "Business problem", pressed: true });
    expect(current.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Start with a defined challenge.").id).toBe(current.getAttribute("aria-describedby"));
    const other = within(group).getByRole("button", { name: "Open funding", pressed: false });
    fireEvent.click(other);
    expect(onNavigate).toHaveBeenCalledWith("create/open-funding");
    expect(current.className).toBe("selected");
    await expectAccessible(container);
  });

  it("labels each discovery cell so rows can stack on narrow screens", async () => {
    const { container } = render(
      <DiscoveryTable
        rows={[{ id: "a", title: "Warehouse routing", amount: "USDT 5,000", count: 2 }]}
        columns={[
          { key: "title", label: "Title", render: (row) => <button className="opportunity-table-link" type="button">{row.title}</button> },
          { key: "funding", label: "Funding", numeric: true, render: (row) => row.amount },
          { key: "proposals", label: "Proposals", numeric: true, render: (row) => row.count },
        ]}
      />,
    );
    const cells = [...container.querySelectorAll("tbody td")];
    expect(cells.map((cell) => cell.dataset.label)).toEqual(["Title", "Funding", "Proposals"]);
    expect(cells[1].className).toContain("numeric");
    expect(screen.getByRole("columnheader", { name: "Funding" })).toBeTruthy();
    await expectAccessible(container);
  });

  it("uses the short search label as the placeholder on narrow screens", () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    try {
      render(<DiscoverySearchRow query="" onQueryChange={() => {}} searchLabel="Search opportunities" placeholder="Search title, description or tags" filtersOpen={false} onToggleFilters={() => {}} filterCount={0} panelId="p" />);
      expect(screen.getByRole("searchbox", { name: "Search opportunities" }).getAttribute("placeholder")).toBe("Search opportunities");
    } finally {
      window.matchMedia = original;
    }
  });

  it("shows role names without internal codes and lets emails break before @", async () => {
    const users = [
      { address: "0x1111111111111111111111111111111111111111", fullName: "Ashy Chung", email: "ashy.chung@gmail.com", organisation: "SMU", role: 0 },
      { address: "0x2222222222222222222222222222222222222222", fullName: "QA Three", email: "limjunwei42+qa3@gmail.com", organisation: "QA", role: 2, suspended: true },
    ];
    const { container } = render(
      <UserManagementTable users={users} loading={false} isFetching={false} error="" search="" onSearchChange={() => {}}
        roleFilter={null} onRoleFilterChange={() => {}} orgFilter="" onOrgFilterChange={() => {}} page={1} totalPages={1}
        onPageChange={() => {}} totalUsers={2} onChangeRole={() => {}} onToggleSuspend={() => {}} onRefresh={() => {}} currentAdminAddress="" />,
    );
    const options = [...screen.getByLabelText("Filter by Role").options].map((option) => option.textContent);
    expect(options).toEqual(["All Roles", "Standard users", "Assigned evaluators", "Administrators"]);
    expect(options.some((label) => /\(\d\)/.test(label))).toBe(false);
    const email = screen.getByText((_, node) => node?.classList?.contains("user-email") && node.textContent === "ashy.chung@gmail.com");
    expect(email.innerHTML).toBe("ashy.chung<wbr>@gmail.com");
    const row = email.closest("tr");
    expect([...row.querySelectorAll("td[data-label]")].map((cell) => cell.dataset.label)).toEqual(["Organisation", "Role", "Status", "Actions"]);
    expect(within(row).getByRole("button", { name: "Change Role" })).toBeTruthy();
    await expectAccessible(container);
  });
});
