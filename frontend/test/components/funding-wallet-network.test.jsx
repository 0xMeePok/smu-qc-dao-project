import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ account: null, user: null, claim: vi.fn(), signIn: vi.fn(), decide: vi.fn(), submit: vi.fn(), record: vi.fn() }));
vi.mock("../../src/context/WalletContext.jsx", () => ({ useWallet: () => mocks.account }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock("../../src/context/SessionContext.jsx", () => ({ useSignIn: () => mocks.signIn }));
vi.mock("../../src/lib/escrow.js", () => ({ claimRemovedProposalFunds: (...args) => mocks.claim(...args), escrowErrorMessage: error => error.message }));
vi.mock("../../src/lib/fundingApproach.js", async importOriginal => ({ ...await importOriginal(),
  decideFundingApproach: (...args) => mocks.decide(...args), submitFundingApproachDecisions: (...args) => mocks.submit(...args),
  recordFundingApproachDecisionAnchors: (...args) => mocks.record(...args) }));
vi.mock("../../src/lib/proposals.js", () => ({ PROPOSAL_STATUS_DRAFT: "draft", listProposalsForPosting: async () => [
  { id: "removed-listing", removed: true, title: "Removed listing", reason: "off_topic", claimFunds: true },
] }));
import { ApproachResponseForm, ClaimRemovedFundsButton, SignDecisionAnchor } from "../../src/components/FundingApproachList.jsx";
import { PostingProposals } from "../../src/components/PostingProposals.jsx";

const address = `0x${"a".repeat(40)}`;
const hash = `0x${"1".repeat(64)}`;
const decision = { approachId: "approach", decisionAnchorId: hash, recordHash: hash };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: address };
  mocks.account = { address, isConnected: true, chainId: 1 };
  mocks.claim.mockResolvedValue({ transactionHash: hash });
  mocks.decide.mockResolvedValue({ decisions: [decision] });
  mocks.submit.mockResolvedValue({ transactionHash: hash });
  mocks.record.mockResolvedValue({});
});
afterEach(cleanup);

function renderClaim(source) {
  render(source === "funding approach" ? <ClaimRemovedFundsButton proposalId="removed-listing" />
    : <PostingProposals posting={{ id: "posting", removed: true }} viewerId={address} proposalCount={1} onNavigate={vi.fn()} />);
}

it.each(["funding approach", "posting proposal"])("lets the matching embedded wallet claim from a %s on a stale reported network", async source => {
  renderClaim(source);
  fireEvent.click(await screen.findByRole("button", { name: "Claim funds" }));
  await waitFor(() => expect(mocks.claim).toHaveBeenCalledExactlyOnceWith({ proposalId: "removed-listing", account: address }));
  expect(mocks.signIn).not.toHaveBeenCalled();
  expect(await screen.findByText(/Refund claimed/)).toBeTruthy();
});

it.each([
  ["funding approach", "disconnected"], ["funding approach", "wrong wallet"],
  ["posting proposal", "disconnected"], ["posting proposal", "wrong wallet"],
])("keeps the %s refund gated for %s", async (source, mode) => {
  if (mode === "disconnected") mocks.account.isConnected = false;
  else mocks.account.address = `0x${"b".repeat(40)}`;
  renderClaim(source);
  fireEvent.click(await screen.findByRole("button", { name: "Claim funds" }));
  expect(mocks.claim).not.toHaveBeenCalled();
  expect(mocks.signIn).toHaveBeenCalledOnce();
});

it.each(["response", "saved anchor"])("lets the matching embedded wallet sign an approach %s on a stale reported network", async source => {
  if (source === "response") {
    render(<ApproachResponseForm draft={{ id: "approach", decision: "accept", text: "Ready to proceed" }} setDraft={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Accept approach" }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledExactlyOnceWith("approach", "accept", "Ready to proceed"));
  } else {
    render(<SignDecisionAnchor proposalId="listing" items={[{ id: "approach", proposalId: "listing", decisionAnchorStatus: "pending", decisionAnchorId: hash, decisionRecordHash: hash }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign decision anchor" }));
  }
  await waitFor(() => expect(mocks.submit).toHaveBeenCalledExactlyOnceWith([decision], { account: address }));
  await waitFor(() => expect(mocks.record).toHaveBeenCalledExactlyOnceWith(["approach"], hash));
  expect(mocks.signIn).not.toHaveBeenCalled();
});
