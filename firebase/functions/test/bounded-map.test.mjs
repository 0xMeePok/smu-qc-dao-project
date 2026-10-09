import assert from "node:assert/strict";
import { it } from "node:test";
import { boundedMap } from "../boundedMap.js";

it("bounds work and preserves order when operations finish out of order", async () => {
  let active = 0, maximum = 0;
  const result = await boundedMap([4, 3, 2, 1, 0], async value => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, value));
    active--; return value * 2;
  }, 2);
  assert.equal(maximum, 2); assert.deepEqual(result, [8, 6, 4, 2, 0]);
});
it("stops new work after failure and waits for active writes to finish before rejecting", async () => {
  const seen = [], finished = [], failure = new Error("write failed");
  await assert.rejects(boundedMap([0, 1, 2, 3], async value => {
    seen.push(value);
    if (value === 0) throw failure;
    await new Promise(resolve => setTimeout(resolve, 5)); finished.push(value);
  }, 2), error => error === failure);
  assert.deepEqual(seen, [0, 1]); assert.deepEqual(finished, [1]);
});
