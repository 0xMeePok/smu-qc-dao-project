import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const account = `0x${"a".repeat(40)}`;
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: `0x${"a".repeat(40)}` } }) }));
vi.mock("../../src/lib/fundingApproach.js", async importOriginal => ({ ...await importOriginal(), getFundingApproach: async () => ({
  id: "old-approach", proposalId: "listing", proposalTitle: "Legacy research proposal", researcherId: `0x${"a".repeat(40)}`,
  funderName: "Funder", researcherName: "Researcher", status: "pending", decisionAnchorStatus: "pending",
  amount: 2, currency: "USDT", expiresAt: "2099-01-01T00:00:00.000Z" }) }));
import FundingApproachDetailPage from "../../src/pages/FundingApproachDetailPage.jsx";
afterEach(cleanup);
it("preserves bookmarked legacy approach history without acceptance or signing controls", async () => {
  const go = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <FundingApproachDetailPage approachId="old-approach" onNavigate={go} />
  </QueryClientProvider>);
  await screen.findByRole("heading", { name: "Legacy research proposal" });
  expect(screen.getByText(/preserved as a read-only audit record/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Decline" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Sign decision anchor" })).toBeNull();
  expect(screen.getByRole("button", { name: "Audit receipt" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open crowdfunding" }));
  expect(go).toHaveBeenCalledWith("proposal/listing?tab=funding");
});
