import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EscrowPaymentPlanFields } from "../../src/components/EscrowPaymentPlanFields.jsx";

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
    const form = { ...original, amount: "1200.25", tranchePercentages: "20, 30, 50", reviewDays: "7, 14, 30", funderVoting: true };
    const draft = buildProposalDocument({ researcherId: original.researcherId, posting, form, status: "draft" });
    expect(draft.fundingPlan.tranchePercentages).toBe("20, 30, 50");
    expect(draft.fundingTerms).toBeUndefined();
    const submitted = buildProposalDocument({ researcherId: original.researcherId, posting, form });
    expect(submitted.fundingTerms).toEqual(original.fundingTerms);
    expect(submitted.fundingPlan).toBeUndefined();
    const editing = formFromProposal(submitted);
    expect(editing.immutableFundingTerms).toEqual(submitted.fundingTerms);
    expect(() => buildProposalDocument({ researcherId: original.researcherId, posting,
      form: { ...editing, amount: "1" } })).toThrow(/cannot change/);
  });

  it("shows payment inputs, voting, inline validation and immutable-plan state", () => {
    const onChange = vi.fn();
    const { rerender } = render(<EscrowPaymentPlanFields form={{}} onChange={onChange} error="Percentages must total 100." />);
    expect(screen.getByLabelText("Payment percentages").value).toBe("100");
    expect(screen.getByLabelText("Approval window in days").value).toBe("7");
    fireEvent.change(screen.getByLabelText("Payment percentages"), { target: { value: "20,30,50" } });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith("tranchePercentages", "20,30,50");
    expect(onChange).toHaveBeenCalledWith("funderVoting", true);
    expect(screen.getByRole("alert").textContent).toMatch(/total 100/);
    rerender(<EscrowPaymentPlanFields form={{ tranchePercentages: "20,30,50", funderVoting: true }} disabled onChange={onChange} />);
    expect(screen.getByLabelText("Payment percentages").closest("fieldset").disabled).toBe(true);
  });

  it("restores tiny stored amounts as plain decimals when resuming a draft", () => {
    expect(formFromProposal({ status: "draft", amount: 1e-7 }).amount).toBe("0.0000001");
    expect(formFromProposal({ status: "draft", amount: 1e-18 }).amount).toBe("0.000000000000000001");
  });
});
