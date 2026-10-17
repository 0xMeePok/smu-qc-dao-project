import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ACCEPTANCE_WINDOW_MS, deadlineUrgency } from "../../src/lib/deadlineUrgency.js";
import { developerAttention, ownerAttention } from "../../src/lib/dashboardAttention.js";

const now = new Date("2026-09-01T00:00:00Z");
const at = (hours) => new Date(now.getTime() + hours * 60 * 60 * 1000);

describe("windowed deadline urgency", () => {
  it("keeps posting deadlines on the shared 14-day / 48-hour rule", () => {
    assert.equal(deadlineUrgency(at(12 * 24), now), "approaching");
    assert.equal(deadlineUrgency(at(15 * 24), now), "normal");
    assert.equal(deadlineUrgency(at(47), now), "critical");
  });

  it("does not flag a seven-day acceptance or approval window as approaching from the start", () => {
    assert.equal(deadlineUrgency(at(6 * 24 + 23), now, { windowMs: ACCEPTANCE_WINDOW_MS }), "normal");
    assert.equal(deadlineUrgency(at(72), now, { windowMs: ACCEPTANCE_WINDOW_MS }), "normal");
    assert.equal(deadlineUrgency(at(47), now, { windowMs: ACCEPTANCE_WINDOW_MS }), "critical");
    assert.equal(deadlineUrgency(at(-1), now, { windowMs: ACCEPTANCE_WINDOW_MS }), "expired");
  });

  it("marks the seven-day dashboard steps with their window", () => {
    const actions = {
      researcher: { selectionToAccept: [{ id: "a", deadlineAt: at(100).toISOString() }], grantSelectionsToAccept: [{ id: "g" }] },
      escrowActions: [{ id: "u", problemId: "mine", action: "approve_upfront" }, { id: "d", problemId: "mine", action: "approve_delivery" }],
    };
    const dev = developerAttention(actions, new Set(["u", "d"]));
    assert.deepEqual(dev.map((row) => [row.kind, row.windowMs]).sort(), [
      ["accept", ACCEPTANCE_WINDOW_MS], ["escrow-approve_delivery", null], ["escrow-approve_upfront", ACCEPTANCE_WINDOW_MS], ["grant", ACCEPTANCE_WINDOW_MS],
    ]);
    assert.equal(ownerAttention(actions, new Set(["mine"])).find((row) => row.kind === "escrow-approve_upfront").windowMs, ACCEPTANCE_WINDOW_MS);
  });
});
