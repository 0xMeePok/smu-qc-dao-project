import { onCall, HttpsError } from "firebase-functions/v2/https";
import { escrowPlatformKey, platformWallet } from "./escrowFundingFunctions.js";
import { getIndependentFundingState, prepareIndependentFundingAction, releaseIndependentFundingCompletion,
  syncIndependentFunding } from "./independentFunding.js";

/** The independent factory shares the existing signer and durable nonce outbox. */
export function registerIndependentFundingFunctions({ db, client, config, requireMember, requireAdmin, options, region, getWallet = platformWallet }) {
  const shared = { db, client, config };
  const callable = service => onCall({ ...options, timeoutSeconds: 180 }, async request => {
    const uid = await requireMember(request);
    const { proposalId, action, amount, evidence, evidenceHash, approve, reason, reasonHash, transactionHash } = request.data ?? {};
    try { return await service({ ...shared, uid, proposalId, action, amount, evidence,
      evidenceHash, approve, reason, reasonHash, transactionHash }); }
    catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("unavailable", "Independent funding confirmation is temporarily unavailable. Retry the same transaction shortly.");
    }
  });
  return {
    getIndependentFundingState: callable(getIndependentFundingState),
    prepareIndependentFundingAction: callable(prepareIndependentFundingAction),
    syncIndependentFunding: callable(syncIndependentFunding),
    // The funder majority approves on-chain; an administrator's review submits the
    // final payment through the platform signer. No member wallet can release it.
    releaseIndependentFundingCompletion: onCall({ ...options, timeoutSeconds: 180, secrets: [escrowPlatformKey] }, async request => {
      const { uid } = await requireAdmin(request);
      try { return await releaseIndependentFundingCompletion({ ...shared, getWallet, uid, proposalId: request.data?.proposalId,
        expectedEvidenceVersion: request.data?.expectedEvidenceVersion, expectedEvidenceHash: request.data?.expectedEvidenceHash }); }
      catch (error) {
        if (error instanceof HttpsError) throw error;
        // Never echo transport or signing details from viem errors.
        throw new HttpsError("unavailable", "The final payment release is temporarily unavailable. Retry shortly.");
      }
    }),
  };
}
