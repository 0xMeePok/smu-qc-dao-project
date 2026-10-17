import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { createWalletClient, fallback, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { createArbitrumRpcTransport } from "./rpcPolicy.js";
import { enqueueEscrowFunding, getEscrowFundingHistory, getEscrowFundingSummary, prepareEscrowDeposit,
  prepareRemovedProposalClaim, queuePostingFundingPause, startEscrowSettlement, sweepEscrowFunding, syncEscrowFunding } from "./escrowFunding.js";
import { sweepIndependentFunding } from "./independentFunding.js";
import { getEscrowAdminCancellation, startEscrowAdminCancellation, sweepEscrowAdminCancellations } from "./escrowAdminCancellation.js";

export const escrowPlatformKey = defineSecret("ESCROW_PLATFORM_PRIVATE_KEY");

// Pre-signature callables kept warm: a cold start here delays the wallet prompt.
// Each minimum instance is billed while idle; see the deployment notes.
const HOT_PRE_SIGNATURE_OPTIONS = { minInstances: 1 };

export function registerEscrowFundingFunctions({ db, client, batchedReadClient, config, requireMember, options, region }) {
  const getWallet = () => {
    const key = escrowPlatformKey.value()?.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(key || "")) throw new HttpsError("failed-precondition", "Configure the deployment's platform signing secret before settlement.");
    return createWalletClient({ account: privateKeyToAccount(key), chain: arbitrumSepolia,
      transport: createArbitrumRpcTransport({ http, fallback,
        primaryUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL,
        backupUrls: process.env.ARBITRUM_SEPOLIA_RPC_BACKUP_URLS }) });
  };
  const shared = { db, client, config, getWallet };
  // Multicall batching makes each round of a request's read queue one RPC
  // request, so the queue may be wider without adding endpoint load.
  const batchedArgs = args => batchedReadClient ? { ...args, client: batchedReadClient, readConcurrency: 48 } : args;
  const callable = (service, signing = false, { warmable = false, ...extra } = {}) => onCall({ ...options, timeoutSeconds: 180,
    ...extra, ...(signing ? { secrets: [escrowPlatformKey] } : {}) }, async request => {
    // A signed-in panel may wake this instance before the member clicks. The
    // ping reads no member data and returns nothing; it only opens the RPC
    // connection and its cached chain check. App Check still applies.
    if (warmable && request.data?.warmup === true) {
      if (!/^0x[0-9a-f]{40}$/.test(request.auth?.uid ?? "")) throw new HttpsError("unauthenticated", "Sign in with your email.");
      try { await (batchedReadClient ?? client).getChainId(); } catch { /* The real request reports RPC failures. */ }
      return { warm: true };
    }
    const uid = await requireMember(request);
    try {
      return await service({ ...shared, uid, proposalId: request.data?.proposalId, problemId: request.data?.problemId,
        amount: request.data?.amount, transactionHash: request.data?.transactionHash,
        reason: request.data?.reason, requestId: request.data?.requestId });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      // Viem errors can contain complete request objects. Never return or log
      // transport details or any signing material in callable error messages.
      throw new HttpsError("unavailable", "Escrow confirmation is unavailable. Try again shortly.");
    }
  });
  return {
    prepareEscrowDeposit: callable(args => prepareEscrowDeposit(batchedArgs(args)), false, { warmable: true, ...HOT_PRE_SIGNATURE_OPTIONS }),
    prepareRemovedProposalClaim: callable(prepareRemovedProposalClaim),
    // Member-facing reconciliation reads through the batched client; the
    // scheduled sweep below keeps the shared client and its default queue.
    syncEscrowFunding: callable(args => syncEscrowFunding(batchedArgs(args)), true),
    getEscrowFundingHistory: callable(getEscrowFundingHistory),
    getEscrowFundingSummary: callable(getEscrowFundingSummary),
    startEscrowSettlement: callable(args => startEscrowSettlement(batchedArgs(args)), true),
    getEscrowAdminCancellation: callable(getEscrowAdminCancellation),
    startEscrowAdminCancellation: callable(startEscrowAdminCancellation, true),
    queueEscrowFunding: onDocumentWritten({ document: "proposals/{proposalId}", region, retry: true, maxInstances: 5 },
      event => event.data?.after?.exists ? enqueueEscrowFunding({ db, config,
        record: { ...event.data.after.data(), id: event.params.proposalId } }) : undefined),
    queueEscrowPostingPause: onDocumentWritten({ document: "problems/{problemId}", region, retry: true, maxInstances: 5 },
      event => event.data?.after?.exists ? queuePostingFundingPause({ db, config,
        problemId: event.params.problemId, record: event.data.after.data() }) : undefined),
    reconcileEscrowFunding: onSchedule({ schedule: "every 1 minutes", region, maxInstances: 1, concurrency: 1,
      timeoutSeconds: 540, secrets: [escrowPlatformKey] }, async () => {
      let main, independent, cancellation, failed = false;
      try { main = await sweepEscrowFunding(shared); } catch { failed = true; }
      try { independent = await sweepIndependentFunding({ ...shared, outboxAlreadyResumed: true }); } catch { failed = true; }
      try { cancellation = await sweepEscrowAdminCancellations(shared); } catch { failed = true; }
      if (failed) throw new Error("Escrow background reconciliation is unavailable; the persisted jobs will retry.");
      return { main, independent, cancellation };
    }),
  };
}
