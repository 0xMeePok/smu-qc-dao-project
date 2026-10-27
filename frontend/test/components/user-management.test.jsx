import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleChangeModal } from "../../src/components/RoleChangeModal.jsx";
import { UserManagementTable } from "../../src/components/UserManagementTable.jsx";

const updateUserRole = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/admin.js", () => ({ updateUserRole }));

afterEach(() => {
  cleanup();
  updateUserRole.mockReset();
});

const ADMIN = "0x1111111111111111111111111111111111111111";
const MEMBER = "0x2222222222222222222222222222222222222222";

function renderDirectory() {
  const users = [
    { address: ADMIN, fullName: "Ada Admin", email: "ada@example.com", organisation: "SMU", role: 1 },
    { address: MEMBER, fullName: "Bea Member", email: "bea@example.com", organisation: "SMU", role: 0 },
  ];
  render(
    <UserManagementTable
      users={users}
      loading={false}
      isFetching={false}
      error=""
      search=""
      onSearchChange={() => {}}
      roleFilter={null}
      onRoleFilterChange={() => {}}
      orgFilter=""
      onOrgFilterChange={() => {}}
      page={1}
      totalPages={1}
      onPageChange={() => {}}
      totalUsers={2}
      onChangeRole={() => {}}
      onToggleSuspend={() => {}}
      onRefresh={() => {}}
      currentAdminAddress={ADMIN}
    />,
  );
}

describe("User directory role actions", () => {
  it("[FUT-OPD-280] offers Change Role on another member and not on the signed-in administrator", () => {
    renderDirectory();

    const ownRow = screen.getByText("Ada Admin").closest("tr");
    const memberRow = screen.getByText("Bea Member").closest("tr");
    expect(within(ownRow).getByText("You")).toBeTruthy();
    expect(within(ownRow).queryByRole("button", { name: "Change Role" })).toBeNull();
    expect(within(memberRow).getByRole("button", { name: "Change Role" })).toBeTruthy();
  });

  it("[FUT-OPD-281] does not write a role change when the reason is too short", () => {
    render(
      <RoleChangeModal
        targetUser={{ address: MEMBER, fullName: "Bea Member", role: 0 }}
        onClose={() => {}}
        onSuccess={() => {}}
      />,
    );

    fireEvent.change(screen.getByLabelText(/Reason for Role Change/), { target: { value: "no" } });
    fireEvent.click(screen.getByRole("button", { name: "Review & Confirm" }));

    expect(screen.getByRole("alert").textContent).toMatch(/at least 5 characters/);
    expect(updateUserRole).not.toHaveBeenCalled();
  });
});
