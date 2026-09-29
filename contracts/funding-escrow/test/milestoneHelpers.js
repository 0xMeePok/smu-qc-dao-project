import { approve } from "./helpers.js";
export async function first(c) { await approve(c); await c.escrow.release(c.selectionId); }
export async function submit(c, label = "evidence") {
  const index = await c.escrow.currentTranche();
  const evidence = c.ethers.id(`${label}-${index}`);
  await c.escrow.connect(c.solution).submitMilestone(index, evidence);
  return [c.selectionId, index, evidence];
}
export async function approveLater(c, args) {
  await c.escrow.connect(c.owner).approveMilestone(...args);
  await c.escrow.connect(c.solution).approveMilestone(...args);
}
export async function payLater(c) {
  const args = await submit(c); await approveLater(c, args);
  if (await c.escrow.funderVoting()) await c.escrow.connect(c.alice).voteMilestone(args[1], args[2], true);
  await c.escrow.releaseMilestone(...args);
}
