import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: {},
  fetchAdminUsers: vi.fn(),
  listModerationQueue: vi.fn(),
}));

vi.mock("../../src/context/SessionContext.jsx", () => ({ useSession: () => mocks.session }));
vi.mock("../../src/lib/chain.js", () => ({ shortenAddress: (address) => address }));
vi.mock("../../src/lib/admin.js", () => ({ fetchAdminUsers: mocks.fetchAdminUsers }));
vi.mock("../../src/lib/moderation.js", () => ({ listModerationQueue: mocks.listModerationQueue }));
vi.mock("../../src/components/UserManagementTable.jsx", () => ({
  UserManagementTable: () => <div data-testid="users-panel">User directory</div>,
}));
vi.mock("../../src/components/RoleChangeModal.jsx", () => ({ RoleChangeModal: () => null }));
vi.mock("../../src/components/SuspendUserModal.jsx", () => ({ SuspendUserModal: () => null }));
vi.mock("../../src/components/RoleViews.jsx", () => ({ AdminAudit: () => <div>Administrator audit</div> }));
vi.mock("../../src/components/ConsolidatedAuditTrail.jsx", () => ({
  ConsolidatedAuditTrail: () => <div data-testid="audits-panel">Governance records</div>,
}));
vi.mock("../../src/components/ProposalAuditQueue.jsx", () => ({
  ProposalAuditQueue: () => <div data-testid="proposals-panel">Proposal records</div>,
}));
vi.mock("../../src/components/PostingSubmissionLogs.jsx", () => ({
  PostingSubmissionLogs: () => <div data-testid="postings-panel">Problem statement records</div>,
}));
vi.mock("../../src/components/FundingSubmissionLogs.jsx", () => ({
  FundingSubmissionLogs: () => <div data-testid="funding-panel">Funding records</div>,
}));
vi.mock("../../src/components/ModerationQueue.jsx", () => ({
  ModerationQueue: () => <div data-testid="moderation-panel">Pending content reports</div>,
}));
vi.mock("../../src/components/ExpiryAdminUtility.jsx", () => ({ ExpiryAdminUtility: () => null }));
vi.mock("../../src/components/OnChainOffChainLegend.jsx", () => ({ OnChainOffChainLegend: () => null }));
vi.mock("../../src/components/PlatformStatusPanel.jsx", () => ({
  PlatformStatusPanel: ({ onOpenAuditTrail }) => (
    <div data-testid="status-panel"><button onClick={onOpenAuditTrail}>Inspect proposal verification</button></div>
  ),
}));
vi.mock("../../src/components/AdminActivityPanel.jsx", () => ({
  AdminActivityPanel: ({ onOpenTab }) => (
    <div data-testid="overview-panel"><button onClick={() => onOpenTab("users")}>Open user management</button></div>
  ),
}));
vi.mock("../../src/components/AdminEscrowCancellation.jsx", () => ({
  EscrowAdministration: () => <div data-testid="escrows-panel">Escrow inspection and cancellation</div>,
}));

import AdminPage from "../../src/pages/AdminPage.jsx";

const sections = [
  ["overview", "Overview"],
  ["status", "Service health"],
  ["escrows", "Escrows & refunds"],
  ["moderation", "Content reports"],
  ["users", "Users & access"],
  ["proposals", "Proposal verification"],
  ["postings", "Problem statements"],
  ["funding", "Funding calls"],
  ["audits", "Governance history"],
];

const nav = () => within(screen.getByRole("navigation", { name: "Admin sections" }));
const sectionButton = (label) => nav().getByRole("button", { name: new RegExp(label) });
const sectionPicker = () => screen.getByRole("combobox", { name: "Admin section" });
const openPicker = () => {
  fireEvent.click(sectionPicker());
  return screen.getByRole("listbox");
};
const choosePickerSection = (label) => {
  fireEvent.click(within(openPicker()).getByRole("option", { name: label }));
  expect(sectionPicker().getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("listbox")).toBeNull();
};

function expectSection(key, label) {
  expect(sectionButton(label).getAttribute("aria-current")).toBe("page");
  expect(sectionPicker().value).toBe(key);
  expect(screen.getByRole("region", { name: label })).toBeTruthy();
  expect(screen.getByTestId(`${key}-panel`)).toBeTruthy();
  expect(nav().getAllByRole("button").filter((button) => button.getAttribute("aria-current") === "page")).toHaveLength(1);
}

beforeEach(() => {
  mocks.session = { isSignedIn: true, isChecking: false, profile: { role: 1 }, address: "0xadmin" };
  mocks.fetchAdminUsers.mockReset().mockResolvedValue({ users: [], total: 11, totalPages: 1 });
  mocks.listModerationQueue.mockReset().mockResolvedValue({ pendingCount: 0 });
});
afterEach(cleanup);

describe("Admin workspace navigation", () => {
  it("opens the overview with the same nine grouped sections available on desktop and mobile", async () => {
    render(<AdminPage onNavigate={vi.fn()} />);
    await waitFor(() => expect(mocks.fetchAdminUsers).toHaveBeenCalled());

    expect(screen.getByRole("heading", { level: 1, name: "Admin workspace" })).toBeTruthy();
    expectSection("overview", "Overview");
    expect(nav().getAllByRole("button")).toHaveLength(9);
    expect(sectionPicker().tagName).toBe("BUTTON");
    expect(sectionPicker().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    const listbox = openPicker();
    expect(listbox.id).toBe(sectionPicker().getAttribute("aria-controls"));
    for (const name of ["Workspace", "Manage", "Audit records"]) {
      expect(within(listbox).getByRole("group", { name })).toBeTruthy();
    }
    expect(within(listbox).getAllByRole("option")).toHaveLength(9);
    for (const [, name] of sections) expect(within(listbox).getByRole("option", { name })).toBeTruthy();
    expect(within(listbox).getByRole("option", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens every existing panel and keeps the mobile selector and URL synchronized", async () => {
    const onNavigate = vi.fn();
    render(<AdminPage onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());

    for (const [key, label] of sections) {
      fireEvent.click(sectionButton(label));
      expectSection(key, label);
      expect(onNavigate).toHaveBeenLastCalledWith(`admin?tab=${key}`);
    }
  });

  it("lets mobile administrators switch directly to any section", async () => {
    const onNavigate = vi.fn();
    render(<AdminPage onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());

    for (const [key, label] of sections) {
      choosePickerSection(label);
      expectSection(key, label);
      expect(onNavigate).toHaveBeenLastCalledWith(`admin?tab=${key}`);
    }
  });

  it("supports arrow keys, Home and End without navigating until Enter or Space confirms", async () => {
    const onNavigate = vi.fn();
    render(<AdminPage onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());
    const picker = sectionPicker();
    const expectActive = (name) => {
      expect(document.getElementById(picker.getAttribute("aria-activedescendant")))
        .toBe(within(screen.getByRole("listbox")).getByRole("option", { name }));
    };

    openPicker();
    fireEvent.keyDown(picker, { key: "Home" });
    expectActive("Overview");
    fireEvent.keyDown(picker, { key: "ArrowDown" });
    expectActive("Service health");
    expectSection("overview", "Overview");
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(picker, { key: "Enter" });
    expectSection("status", "Service health");
    expect(onNavigate).toHaveBeenLastCalledWith("admin?tab=status");
    expect(screen.queryByRole("listbox")).toBeNull();

    openPicker();
    fireEvent.keyDown(picker, { key: "End" });
    expectActive("Governance history");
    fireEvent.keyDown(picker, { key: "ArrowUp" });
    expectActive("Funding calls");
    fireEvent.keyDown(picker, { key: " " });
    expectSection("funding", "Funding calls");
    expect(onNavigate).toHaveBeenLastCalledWith("admin?tab=funding");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it.each(["Escape", "Tab"])("closes the mobile picker on %s without committing the highlighted option", async (key) => {
    const onNavigate = vi.fn();
    render(<AdminPage onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());

    openPicker();
    fireEvent.keyDown(sectionPicker(), { key: "ArrowDown" });
    const browserDefaultAllowed = fireEvent.keyDown(sectionPicker(), { key });

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(sectionPicker().getAttribute("aria-expanded")).toBe("false");
    expectSection("overview", "Overview");
    expect(onNavigate).not.toHaveBeenCalled();
    if (key === "Tab") expect(browserDefaultAllowed).toBe(true);
  });

  it("finds a section by typing and commits it with Enter", async () => {
    const onNavigate = vi.fn();
    render(<AdminPage onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());

    openPicker();
    fireEvent.keyDown(sectionPicker(), { key: "u" });
    const active = document.getElementById(sectionPicker().getAttribute("aria-activedescendant"));
    expect(active).toBe(within(screen.getByRole("listbox")).getByRole("option", { name: "Users & access" }));
    fireEvent.keyDown(sectionPicker(), { key: "Enter" });

    expectSection("users", "Users & access");
    expect(onNavigate).toHaveBeenLastCalledWith("admin?tab=users");
  });

  it("dismisses the mobile picker when a pointer is pressed outside it", async () => {
    const onNavigate = vi.fn();
    render(<AdminPage onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());

    openPicker();
    fireEvent.pointerDown(screen.getByRole("heading", { level: 1, name: "Admin workspace" }));

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(sectionPicker().getAttribute("aria-expanded")).toBe("false");
    expectSection("overview", "Overview");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it.each([
    ["Review reports", "moderation", "Content reports"],
    ["Manage users", "users", "Users & access"],
    ["Manage escrow", "escrows", "Escrows & refunds"],
  ])("takes the overview action '%s' directly to its task", async (action, key, label) => {
    const onNavigate = vi.fn();
    render(<AdminPage onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${action}`) }));
    expectSection(key, label);
    expect(onNavigate).toHaveBeenLastCalledWith(`admin?tab=${key}`);
  });

  it("preserves existing panel shortcuts and updates navigation with them", async () => {
    const onNavigate = vi.fn();
    render(<AdminPage onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Open user management" }));
    expectSection("users", "Users & access");
    expect(onNavigate).toHaveBeenLastCalledWith("admin?tab=users");
    fireEvent.click(sectionButton("Service health"));
    fireEvent.click(screen.getByRole("button", { name: "Inspect proposal verification" }));
    expectSection("proposals", "Proposal verification");
    expect(onNavigate).toHaveBeenLastCalledWith("admin?tab=proposals");
  });

  it("opens pending reports first when no section was explicitly requested", async () => {
    mocks.listModerationQueue.mockResolvedValue({ pendingCount: 3 });
    render(<AdminPage onNavigate={vi.fn()} />);
    await screen.findByTestId("moderation-panel");
    expectSection("moderation", "Content reports");
    expect(sectionButton("Content reports").textContent).toContain("3");
  });

  it("honors a bookmarked section even when reports are waiting", async () => {
    mocks.listModerationQueue.mockResolvedValue({ pendingCount: 3 });
    render(<AdminPage initialSection="escrows" onNavigate={vi.fn()} />);
    await waitFor(() => expect(sectionButton("Content reports").textContent).toContain("3"));
    expectSection("escrows", "Escrows & refunds");
  });

  it("does not let a delayed report count overwrite a mobile section choice", async () => {
    let resolveReports;
    mocks.listModerationQueue.mockReturnValue(new Promise((resolve) => { resolveReports = resolve; }));
    const onNavigate = vi.fn();
    render(<AdminPage onNavigate={onNavigate} />);
    choosePickerSection("Service health");

    await act(async () => { resolveReports({ pendingCount: 3 }); });
    expectSection("status", "Service health");
    expect(onNavigate).toHaveBeenLastCalledWith("admin?tab=status");
  });

  it("updates the selected section when browser navigation changes the requested section", async () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<AdminPage initialSection="users" onNavigate={onNavigate} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());
    expectSection("users", "Users & access");

    rerender(<AdminPage initialSection="status" onNavigate={onNavigate} />);
    expectSection("status", "Service health");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("falls back to the overview for an unknown bookmarked section", async () => {
    render(<AdminPage initialSection="unknown-section" onNavigate={vi.fn()} />);
    await waitFor(() => expect(mocks.listModerationQueue).toHaveBeenCalled());
    expectSection("overview", "Overview");
  });

  it.each([
    ["signed out", { isSignedIn: false, profile: null }],
    ["a standard user", { profile: { role: 0 } }],
    ["a suspended administrator", { profile: { role: 1, suspended: true } }],
  ])("keeps the workspace and its data restricted for %s", (_label, session) => {
    mocks.session = { ...mocks.session, ...session };
    render(<AdminPage initialSection="escrows" onNavigate={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Access Restricted" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Admin sections" })).toBeNull();
    expect(mocks.fetchAdminUsers).not.toHaveBeenCalled();
    expect(mocks.listModerationQueue).not.toHaveBeenCalled();
  });
});
