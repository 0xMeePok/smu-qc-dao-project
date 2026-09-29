import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EscrowPaymentPlanFields } from "../../src/components/EscrowPaymentPlanFields.jsx";
import { EscrowPaymentPlanSummary } from "../../src/components/EscrowPaymentPlanSummary.jsx";

vi.mock("../../../firebase/functions/auditRegistry.contract.json", async () => {
  const { escrowConfig } = await import("../../../firebase/functions/test/fixtures/escrowConfigFixture.js");
  return { default: escrowConfig };
});
vi.mock("../../src/config/auditRegistry.js", async importOriginal => {
  const actual = await importOriginal();
  const { escrowConfig } = await import("../../../firebase/functions/test/fixtures/escrowConfigFixture.js");
  return { ...actual, AUDIT_REGISTRY_CONFIG: escrowConfig, AUDIT_REGISTRY_ABI: escrowConfig.abi,
    AUDIT_REGISTRY_ADDRESS: escrowConfig.address, DEFAULT_AUDIT_REGISTRY_ADDRESS: escrowConfig.address,
    getAuditRegistryAddress: (address = escrowConfig.address) => address };
});

const { prepareStoredProposal } = await import("../../../firebase/functions/proposalAuditPayload.js");
const { escrowRecord, escrowClient, escrowConfig, txHash } = await import("../../../firebase/functions/test/fixtures/escrowAuditFixture.js");
const { commitProposalAudit, verifyProposalAudit } = await import("../../src/lib/auditRegistry.js");
const { buildProposalDocument } = await import("../../src/lib/proposals.js");
const { formFromProposal } = await import("../../src/pages/CreateProposalPage.jsx");

afterEach(cleanup);

describe("Escrow registry frontend compatibility", () => {
  it("sends the atomic commit with exact terms and verifies the linked escrow", async () => {
    const record = escrowRecord(), client = escrowClient(record), prepared = prepareStoredProposal(record);
    const writeContract = vi.fn(async () => txHash);
    const adapters = { readContract: client.readContract, writeContract,
      waitForTransactionReceipt: async () => ({ status: "success", blockNumber: 88n }) };
    await commitProposalAudit(prepared, { account: record.researcherId, adapters });
    expect(writeContract.mock.calls[0][0].functionName).toBe("commitProposalWithEscrow");
    expect(writeContract.mock.calls[0][0].args[5].target).toBe(1200250000n);
    const checked = await verifyProposalAudit(prepared, { adapters });
    expect(checked.verified).toBe(true);
    expect(checked.escrow.factoryAddress).toBe(escrowConfig.escrow.factoryAddress);
  });

  it("does not mark an altered escrow as verified even when the proposal hashes match", async () => {
    const record = escrowRecord(), client = escrowClient(record), prepared = prepareStoredProposal(record);
    const read = client.readContract;
    const adapters = { readContract: request => request.functionName === "funderVoting" ? Promise.resolve(false) : read(request),
      writeContract: vi.fn(), waitForTransactionReceipt: vi.fn() };
    const result = await verifyProposalAudit(prepared, { adapters });
    expect(result.verified).toBe(false);
    expect(result.status).toBe("mismatch");
    expect(result.mismatches.some(item => item.field === "escrow")).toBe(true);
  });

  it("keeps draft plan inputs and writes finalized terms when a proposal is submitted", () => {
    const original = escrowRecord();
    const posting = { id: original.problemId, ownerId: original.postingOwnerId, currency: "USDC" };
    const form = { ...original, amount: "1200.25", reviewDays: "7, 30", funderVoting: true };
    const draft = buildProposalDocument({ researcherId: original.researcherId, posting, form, status: "draft" });
    expect(draft.fundingPlan.tranchePercentages).toBe("50, 50");
    expect(draft.fundingTerms).toBeUndefined();
    const submitted = buildProposalDocument({ researcherId: original.researcherId, posting, form });
    expect(submitted.fundingTerms).toEqual(original.fundingTerms);
    expect(submitted.fundingPlan).toBeUndefined();
    const editing = formFromProposal(submitted);
    expect(editing.immutableFundingTerms).toEqual(submitted.fundingTerms);
    expect(() => buildProposalDocument({ researcherId: original.researcherId, posting,
      form: { ...editing, amount: "1" } })).toThrow(/cannot change/);
  });

  it("shows the fixed split, both completion variants, inline validation and immutable-plan state", () => {
    const onChange = vi.fn();
    const { rerender } = render(<EscrowPaymentPlanFields form={{}} onChange={onChange} error="Invalid approval window." />);
    expect(screen.getByLabelText("Payment percentages").value).toBe("50, 50");
    expect(screen.getByLabelText("Payment percentages").readOnly).toBe(true);
    expect(screen.getByLabelText("Approval window in days").value).toBe("7");
    expect(screen.getByRole("radio", { name: "Both owners" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Both owners and a funding-weighted majority of funders" }));
    expect(onChange).toHaveBeenCalledWith("funderVoting", true);
    expect(screen.getByRole("alert").textContent).toMatch(/Invalid approval window/);
    rerender(<EscrowPaymentPlanFields form={{ funderVoting: true }} onChange={onChange} />);
    expect(screen.getByText(/Completion requires agreement from all three parties/)).toBeTruthy();
    expect(screen.getByText("more than 50% of all contributed funds")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Both owners" }));
    expect(onChange).toHaveBeenCalledWith("funderVoting", false);
    rerender(<EscrowPaymentPlanFields form={{ immutableFundingTerms: escrowRecord().fundingTerms }} disabled onChange={onChange} />);
    expect(screen.getByLabelText("Payment percentages").closest("fieldset").disabled).toBe(true);
  });

  it("normalizes old draft splits to 50/50 and preserves the selected approval variant", () => {
    const original = escrowRecord();
    const restored = formFromProposal({ ...original, status: "draft", fundingTerms: undefined,
      fundingPlan: { tranchePercentages: "100", reviewDays: "90", funderVoting: true } });
    expect(restored.tranchePercentages).toBe("50, 50");
    expect(restored.immutableFundingTerms).toBeUndefined();
    expect(restored.funderVoting).toBe(true);
    const submitted = buildProposalDocument({ researcherId: original.researcherId,
      posting: { id: original.problemId, ownerId: original.postingOwnerId, currency: "USDC" }, form: restored });
    expect(submitted.fundingTerms.trancheBps).toEqual([5000, 5000]);
    expect(submitted.fundingTerms.reviewWindows).toEqual([90 * 86400, 90 * 86400]);
    expect(submitted.fundingTerms.funderVoting).toBe(true);
  });

  it.each([false, true])("explains evidence and owner acceptance before the final half (voting=%s)", funderVoting => {
    render(<EscrowPaymentPlanSummary funderVoting={funderVoting} />);
    expect(screen.getByText("50% upfront").parentElement.textContent).toMatch(/full funding target is in escrow/);
    const completion = screen.getByText("50% on completion").parentElement.textContent;
    expect(completion).toMatch(/proposal owner submits delivery evidence and confirms completion/);
    expect(completion).toMatch(/problem owner must review that evidence and accept the work as delivered/);
    expect(completion.includes("more than 50% of all contributed funds")).toBe(funderVoting);
    if (funderVoting) expect(completion).toMatch(/Exactly 50% is insufficient; abstentions do not reduce the threshold/);
  });

  it("restores tiny stored amounts as plain decimals when resuming a draft", () => {
    expect(formFromProposal({ status: "draft", amount: 1e-7 }).amount).toBe("0.0000001");
    expect(formFromProposal({ status: "draft", amount: 1e-18 }).amount).toBe("0.000000000000000001");
  });
});
