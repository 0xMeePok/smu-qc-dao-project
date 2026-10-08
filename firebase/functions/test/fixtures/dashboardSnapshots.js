import { deploymentKey, readVerifiedFunding, loadFundingContext } from "../../escrowFunding.js";
import { readOpenFunding } from "../../openFunding.js";

// Represent the confirmed projections written by detail/transaction syncs.
// Dashboard tests call this before measuring the dashboard itself.
export async function seedDashboardSnapshots(f) {
  const uid = f.uid, prefix = deploymentKey(f.config);
  let blockNumber;
  try { await f.client.getChainId(); blockNumber = await f.client.getBlockNumber({ cacheTime: 0 }) - 1n; }
  catch { return; }
  if (f.posting.opportunityType === "open-funding") {
    try {
      const pool = await readOpenFunding({ ...f, blockNumber });
      const { selections, ...totals } = pool;
      f.db.records.set(`openFundingSummaries/${prefix}_${f.problemId}`, { ...totals, registryAddress: f.config.address });
      for (const selection of selections) f.db.records.set(`openFundingSelections/${prefix}_${selection.proposalId}`, {
        ...selection, owner: uid, problemId: f.problemId, registryAddress: f.config.address, chainId: f.config.chainId, blockNumber: Number(blockNumber),
      });
      // The fixture intentionally inserts unoffered rows to stress pagination.
      for (const [path, proposal] of f.db.records) if (path.startsWith("proposals/") && !path.slice(10).includes("/")
          && proposal.problemId === f.problemId && !selections.some(item => item.proposalId === path.slice(10))) {
        f.db.records.set(`openFundingSelections/${prefix}_${path.slice(10)}`, { proposalId: path.slice(10), problemId: f.problemId,
          owner: uid, registryAddress: f.config.address, chainId: f.config.chainId, blockNumber: Number(blockNumber), status: "none" });
      }
    } catch { /* A missing verified snapshot must remain unavailable. */ }
  }
  for (const proposal of f.proposals) {
    try {
      const context = await loadFundingContext({ db: f.db, uid, proposalId: proposal.id });
      const { summary, escrow } = await readVerifiedFunding({ ...f, ...context, blockNumber });
      summary.snapshotVerified = true;
      const own = await f.client.readContract({ address: escrow.address, abi: f.config.escrow.escrowAbi,
        functionName: "depositorSummary", args: [uid], blockNumber });
      f.db.records.set(`escrowFundingSummaries/${prefix}_${proposal.id}`, summary);
      if (BigInt(own.deposited)) f.db.records.set(`escrowFundingPositions/${prefix}_${proposal.id}_${uid}`, {
        ...summary, uid, committed: String(own.deposited), released: String(own.released), refunded: String(own.refunded),
      });
    } catch { /* Do not synthesize a position from document amounts. */ }
  }
}
