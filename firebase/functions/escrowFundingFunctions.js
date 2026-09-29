import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { enqueueEscrowFunding, getEscrowFundingHistory, getEscrowFundingSummary, prepareEscrowDeposit,
  queuePostingFundingPause, startEscrowSettlement, sweepEscrowFunding, syncEscrowFunding } from "./escrowFunding.js";

export const escrowPlatformKey = defineSecret("ESCROW_PLATFORM_PRIVATE_KEY");

export function registerEscrowFundingFunctions({ db, client, config, requireMember, options, region }) {
  const getWallet = () => {
    const key = escrowPlatformKey.value()?.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key || "")) throw new HttpsError("failed-precondition", "Configure the deployment's platform signing secret before settlement.");
    return createWalletClient({ account: privateKeyToAccount(key), chain: arbitrumSepolia,
      transport: http(process.env.ARBITRUM_SEPOLIA_RPC_URL || undefined) });
  };
  const shared = { db, client, config, getWallet };
  const callable = (service, signing = false) => onCall({ ...options, timeoutSeconds: 180,
    ...(signing ? { secrets: [escrowPlatformKey] } : {}) }, async request => {
    const uid = await requireMember(request);
    try {
      return await service({ ...shared, uid, proposalId: request.data?.proposalId, transactionHash: request.data?.transactionHash });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      // Viem errors can contain complete request objects. Never return or log
      // transport details or any signing material in callable error messages.
      throw new HttpsError("unavailable", "Escrow confirmation is unavailable. Try again shortly.");
    }
  });
  return {
    prepareEscrowDeposit: callable(prepareEscrowDeposit),
    syncEscrowFunding: callable(syncEscrowFunding, true),
    getEscrowFundingHistory: callable(getEscrowFundingHistory),
    getEscrowFundingSummary: callable(getEscrowFundingSummary),
    startEscrowSettlement: callable(startEscrowSettlement, true),
    queueEscrowFunding: onDocumentWritten({ document: "proposals/{proposalId}", region, retry: true, maxInstances: 5 },
      event => event.data?.after?.exists ? enqueueEscrowFunding({ db, config,
        record: { ...event.data.after.data(), id: event.params.proposalId } }) : undefined),
    queueEscrowPostingPause: onDocumentWritten({ document: "problems/{problemId}", region, retry: true, maxInstances: 5 },
      event => event.data?.after?.exists ? queuePostingFundingPause({ db, config,
        problemId: event.params.problemId, record: event.data.after.data() }) : undefined),
    reconcileEscrowFunding: onSchedule({ schedule: "every 1 minutes", region, maxInstances: 1, concurrency: 1,
      timeoutSeconds: 540, secrets: [escrowPlatformKey] }, async () => {
      try { return await sweepEscrowFunding(shared); }
      catch { throw new Error("Escrow background reconciliation is unavailable; the persisted jobs will retry."); }
    }),
  };
}
