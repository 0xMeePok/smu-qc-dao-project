import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertActiveAuditDeployment, knownAuditDeployment, resolveAuditDeployment } from "../auditDeployments.js";
import active from "../auditRegistry.contract.json" with { type: "json" };
import history from "../auditRegistry.history.json" with { type: "json" };

const hash = `0x${"3".repeat(64)}`;
const record = { audit: { transactionHash: hash, chainId: 421614 } };

describe("Audit deployment resolution", () => {
  for (const historical of history) {
    it(`retains historical ${historical.contractName} reads after changing the active deployment`, async () => {
      const current = { ...active, address: `0x${"c".repeat(40)}` };
      const result = await resolveAuditDeployment(record, { activeConfig: current,
        getTransaction: async request => {
          assert.deepEqual(request, { hash, chainId: 421614 });
          return { hash, to: historical.address, chainId: 421614 };
        } });
      assert.deepEqual(result, historical);
      assert.throws(() => assertActiveAuditDeployment(result, current), /earlier.*read-only/);
    });
  }
  it("routes new records to the active registry without an RPC read", async () => {
    assert.equal(await resolveAuditDeployment({}, { activeConfig: active,
      getTransaction: () => { throw new Error("Unexpected read"); } }), active);
    assert.equal(assertActiveAuditDeployment(active, active), active);
  });
  it("never trusts a record-supplied address, unknown contract, wrong hash, or wrong chain", async () => {
    const known = history[0];
    const original = { hash, to: known.address, chainId: 421614 };
    for (const patch of [{ to: `0x${"d".repeat(40)}` }, { hash: `0x${"4".repeat(64)}` }, { chainId: 1 }]) {
      await assert.rejects(resolveAuditDeployment({ ...record, registryAddress: known.address }, {
        transaction: { ...original, ...patch }, activeConfig: active,
      }), /does not belong/);
    }
    assert.throws(() => knownAuditDeployment(known.address, 1), /does not belong/);
  });
  it("fails closed when deployment identity cannot be read", async () => {
    await assert.rejects(resolveAuditDeployment(record), /Reading the audit transaction/);
    await assert.rejects(resolveAuditDeployment(record, { getTransaction: async () => { throw new Error("HTTP 503"); } }), /503/);
  });
});
