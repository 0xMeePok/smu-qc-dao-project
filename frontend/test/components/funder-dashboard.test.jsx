import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), user: { id: "owner", org: "Research Fund" }, posting: vi.fn(), proposal: vi.fn() }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/lib/openFunding.js", () => ({ getFunderDashboard: (...args) => mocks.fetch(...args) }));
vi.mock("../../src/lib/postings.js", () => ({ findPosting: (...args) => mocks.posting(...args) }));
vi.mock("../../src/lib/proposals.js", () => ({ findProposal: (...args) => mocks.proposal(...args) }));
vi.mock("../../src/components/RelatedAuditReceiptPane.jsx", () => ({ RELATED_AUDIT_KIND: { LISTING: "listing", PROPOSAL: "proposal" },
  RelatedAuditReceiptPane: ({ record, loading, error }) => <div role="dialog">{loading ? "Loading audit" : error || `Receipt for ${record?.title}`}</div> }));
import { FunderDashboard } from "../../src/components/FunderDashboard.jsx";
vi.mock("../../src/components/IndependentFundingPanel.jsx", () => ({ IndependentFundingPanel: ({ proposal }) => <p>Independent refund panel {proposal.id}</p> }));
const token = { chainId: 421614, tokenAddress: `0x${"a".repeat(40)}`, tokenDecimals: 6, tokenSymbol: "USDC" };
const fixture = { opportunities: [{ id: "grant", title: "Quantum grants", status: "open", amount: 100000, currency: "USDC", pool: { ...token, poolAddress: "pool", totalDeposited: "100000000000", available: "50000000000", totalReserved: "50000000000" } }],
  commitments: [{ ...token, proposalId: "solution", title: "Quantum solution", postingTitle: "Quantum grants", state: 1, committed: "50000000000", locked: "50000000000", released: "0", refunded: "0", fundingTarget: "50000000000", totalDeposited: "50000000000" }],
  totals: [{ ...token, committed: "50000000000", locked: "50000000000", released: "0", refunded: "0" }], approaches: [], decisions: [], truncated: {} };
beforeEach(() => { vi.clearAllMocks(); mocks.user = { id: "owner", org: "Research Fund" }; mocks.fetch.mockReset().mockResolvedValue(fixture); });
afterEach(cleanup);
it("shows exact confirmed totals, separately reserved grants and pooled progress", async () => {
  render(<FunderDashboard onNavigate={() => {}} />);
  expect(await screen.findByText("Quantum grants")).toBeTruthy();
  for (const label of ["Total committed", "Total locked", "Total released", "Total refunded"]) expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText(/Deposited 100000 USDC · Available 50000 USDC · Reserved 50000 USDC/)).toBeTruthy();
  expect(screen.getByText("Pooled progress: 50000 USDC / 50000 USDC")).toBeTruthy();
});
it("opens grant creation, exact funding tab deep links, and the proposal audit receipt", async () => {
  const go = vi.fn(); mocks.proposal.mockResolvedValue({ id: "solution", title: "Quantum solution" });
  render(<FunderDashboard onNavigate={go} />); await screen.findByText("Quantum grants");
  fireEvent.click(screen.getByRole("button", { name: "New funding call" })); expect(go).toHaveBeenLastCalledWith("create-funding");
  fireEvent.click(screen.getByRole("button", { name: "Manage funding" })); expect(go).toHaveBeenLastCalledWith("posting/grant?tab=funding");
  fireEvent.click(screen.getByRole("button", { name: "View escrow" })); expect(go).toHaveBeenLastCalledWith("proposal/solution?tab=funding");
  fireEvent.click(screen.getAllByRole("button", { name: "Audit receipt" })[1]);
  expect(await screen.findByText("Receipt for Quantum solution")).toBeTruthy(); expect(mocks.proposal).toHaveBeenCalledWith("solution");
});
it("keeps different tokens in separate totals and reports missing verification", async () => {
  mocks.fetch.mockResolvedValue({ ...fixture, unavailableCommitments: 2, totals: [...fixture.totals, { ...token, tokenAddress: "other", tokenSymbol: "XSGD", committed: "1000000", locked: "1000000", released: "0", refunded: "0" }] });
  render(<FunderDashboard onNavigate={() => {}} />);
  expect(await screen.findByText(/2 commitments could not be verified/)).toBeTruthy();
  expect(screen.getAllByText("1 XSGD")).toHaveLength(2);
});
it("labels partial totals and unavailable grant decisions instead of claiming no decisions exist", async () => {
  mocks.fetch.mockResolvedValue({ ...fixture, totalsPartial: true, unavailableDecisions: 2 });
  render(<FunderDashboard onNavigate={() => {}} />);
  expect(await screen.findByText(/Funding totals are partial/)).toBeTruthy();
  expect(screen.getByText(/2 grant decisions could not be verified/)).toBeTruthy();
  expect(screen.getByText("Verified funding decisions are temporarily unavailable.")).toBeTruthy();
  expect(screen.queryByText("No funding decisions recorded yet.")).toBeNull();
});
it("shows a retryable error instead of zero commitments when the service fails", async () => {
  mocks.fetch.mockRejectedValue(new Error("Service unavailable")); render(<FunderDashboard onNavigate={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Service unavailable");
  expect(screen.queryByText("No verified proposal commitments yet.")).toBeNull();
  mocks.fetch.mockResolvedValue(fixture); fireEvent.click(screen.getByRole("button", { name: "Refresh dashboard" }));
  expect(await screen.findByText("Quantum grants")).toBeTruthy();
});
it("clears the previous user's funding data while a new account is loading", async () => {
  const view = render(<FunderDashboard onNavigate={() => {}} />); await screen.findByText("Quantum grants");
  mocks.user = { id: "another" }; mocks.fetch.mockImplementation(() => new Promise(() => {}));
  view.rerender(<FunderDashboard onNavigate={() => {}} />);
  expect(screen.queryByText("Quantum grants")).toBeNull(); expect(screen.getByText("Loading your funding dashboard…")).toBeTruthy();
});

it("lists cached independent commitments separately and leaves unknown refunds blank", async () => {
  const go = vi.fn();
  mocks.fetch.mockResolvedValue({ ...fixture, independentCommitments: [{ proposalId: "independent", title: "Independent library",
    state: "Accepted", tokenDecimals: 6, tokenSymbol: "USDT", totalDeposited: "2000000", fundingTarget: "2000000",
    wallet: { deposited: "1000000", claimable: null, stale: true }, detailRefreshRequired: true }] });
  render(<FunderDashboard onNavigate={go} />);
  await screen.findByText("Independent library");
  expect(screen.getByText("Your contribution 1 USDT · Available refund —")).toBeTruthy();
  expect(screen.getByText(/Cached funding record/)).toBeTruthy();
  expect(screen.getByText(/These totals cover problem-statement and grant proposal funding/)).toBeTruthy();
  expect(screen.queryByText("Your contribution 1 USDT · Available refund 0 USDT")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open crowdfunding" }));
  expect(go).toHaveBeenCalledWith("proposal/independent?tab=funding");
});

it("opens a removed independent listing's refund panel without exposing its proposal body", async () => {
  mocks.fetch.mockResolvedValue({ ...fixture, independentCommitments: [{ proposalId: "removed-independent", title: "Independent listing",
    hidden: true, state: "Cancelled", tokenDecimals: 6, tokenSymbol: "USDT", totalDeposited: "2000000", fundingTarget: "2000000",
    wallet: { deposited: "1000000", claimable: "1000000" } }] });
  render(<FunderDashboard onNavigate={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open refund" }));
  expect(await screen.findByText("Independent refund panel removed-independent")).toBeTruthy();
});
