import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertActiveAuditDeployment, knownAuditDeployment, resolveAuditDeployment } from "../auditDeployments.js";
import active from "../auditRegistry.contract.json" with { type: "json" };
import history from "../auditRegistry.history.json" with { type: "json" };

const hash = `0x${"3".repeat(64)}`;
const record = { audit: { transactionHash: hash, chainId: 421614 } };

describe("Audit deployment resolution", () => {
  it("rejects retired registry receipts after removing the historical deployment configuration", async () => {
    assert.deepEqual(history, []);
    for (const address of ["0x47dA28cAEf8021dD88fe18B80e367746e0036964",
      "0xb901B23382322090A1Ea7bC6b8a9d2D422e855FD", "0x2C23b72d6717E982cccd6F4eBe92C9d3448BFcD0"]) {
      await assert.rejects(resolveAuditDeployment(record, {
        transaction: { hash, to: address, chainId: 421614 },
      }), /does not belong to a known/);
    }
  });
  it("routes new records to the active registry without an RPC read", async () => {
    assert.equal(await resolveAuditDeployment({}, { activeConfig: active,
      getTransaction: () => { throw new Error("Unexpected read"); } }), active);
    assert.equal(assertActiveAuditDeployment(active, active), active);
  });
  it("never trusts a record-supplied address, unknown contract, wrong hash, or wrong chain", async () => {
    const known = active;
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
