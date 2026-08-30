import { HttpsError } from "firebase-functions/v2/https";

export const SESSION_REVOCATIONS_COLLECTION = "sessionRevocations";

export function writeSessionCutoff(tx, revocationRef, epoch, timestamp) {
  tx.set(revocationRef, {
    sessionsValidAfterEpoch: epoch,
    updatedAt: timestamp,
  });
}

export async function applyRoleChangeTransaction(tx, {
  targetRef,
  auditRef,
  actorUid,
  adminUser,
  targetAddress,
  newRole,
  reason,
  timestamp,
}) {
  const targetSnap = await tx.get(targetRef);
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "Target user profile not found.");
  }

  const targetData = targetSnap.data() ?? {};
  const previousRole = typeof targetData.role === "number" ? targetData.role : 0;
  if (previousRole === newRole) {
    throw new HttpsError("failed-precondition", "Target user already possesses this role assignment.");
  }

  tx.update(targetRef, { role: newRole, updatedAt: timestamp });
  tx.set(auditRef, {
    type: "role_change",
    action: "ROLE_CHANGE",
    actor: actorUid,
    actorName: adminUser.fullName || actorUid,
    targetAddress,
    targetName: targetData.fullName || targetAddress,
    previousRole,
    newRole,
    reason: reason.trim(),
    timestamp,
    createdAt: timestamp,
  });
  return previousRole;
}

export async function applySuspensionChangeTransaction(tx, {
  targetRef,
  auditRef,
  revocationRef,
  actorUid,
  adminUser,
  targetAddress,
  suspended,
  reason,
  timestamp,
  revokedAfterEpoch,
}) {
  const targetSnap = await tx.get(targetRef);
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "Target user profile not found.");
  }

  const targetData = targetSnap.data() ?? {};
  const currentSuspended = Boolean(targetData.suspended);
  const retryingRevocation = suspended
    && currentSuspended
    && targetData.tokenRevocationStatus !== "succeeded";
  if (currentSuspended === suspended && !retryingRevocation) {
    throw new HttpsError(
      "failed-precondition",
      suspended ? "User account is already suspended." : "User account is not currently suspended.",
    );
  }

  const userUpdate = {
    suspended,
    tokenRevocationStatus: suspended ? "pending" : "not-required",
    updatedAt: timestamp,
  };
  if (suspended) {
    userUpdate.sessionsValidAfterEpoch = revokedAfterEpoch;
    writeSessionCutoff(tx, revocationRef, revokedAfterEpoch, timestamp);
  }
  tx.update(targetRef, userUpdate);
  tx.set(auditRef, {
    type: retryingRevocation ? "token_revocation_retry" : "suspension_change",
    action: retryingRevocation
      ? "TOKEN_REVOCATION_RETRY"
      : suspended ? "USER_SUSPENDED" : "USER_REINSTATED",
    actor: actorUid,
    actorName: adminUser.fullName || actorUid,
    targetAddress,
    targetName: targetData.fullName || targetAddress,
    previousState: currentSuspended,
    newState: suspended,
    reason: reason.trim(),
    revocationStatus: suspended ? "pending" : "not-required",
    timestamp,
    createdAt: timestamp,
  });
}

export async function finalizeSuspensionRevocation({
  db,
  Timestamp,
  targetRef,
  auditRef,
  targetAddress,
  revokeRefreshTokens,
}) {
  try {
    await revokeRefreshTokens(targetAddress);
    const completedAt = Timestamp.now();
    const batch = db.batch();
    batch.update(targetRef, {
      tokenRevocationStatus: "succeeded",
      tokenRevokedAt: completedAt,
    });
    batch.update(auditRef, { revocationStatus: "succeeded", tokenRevokedAt: completedAt });
    await batch.commit();
  } catch (error) {
    if (error?.code !== "auth/user-not-found") {
      const failedAt = Timestamp.now();
      const batch = db.batch();
      batch.update(targetRef, { tokenRevocationStatus: "failed" });
      batch.update(auditRef, { revocationStatus: "failed", revocationFailedAt: failedAt });
      await batch.commit();
      throw new HttpsError(
        "unavailable",
        "The account is suspended, but credential revocation is pending. Retry this action.",
      );
    }
    const batch = db.batch();
    batch.update(targetRef, { tokenRevocationStatus: "succeeded" });
    batch.update(auditRef, { revocationStatus: "succeeded" });
    await batch.commit();
  }
}
