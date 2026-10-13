import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { keccak256, stringToHex } from "viem";
import { assertFundingChain, deploymentKey, enqueueEscrowFunding, FUNDING_EVENTS, FUNDING_JOBS,
  loadFundingContext, PLATFORM_OUTBOX, readVerifiedFunding, submitPlatformAction } from "./escrowFunding.js";
import { reconcileFundingReceipt, same } from "./escrowFundingEvents.js";
import { isIndependentProposal } from "./independentProposal.js";
import { memberNoticeFields } from "./moderation.js";

export const ADMIN_CANCELLATIONS = "escrowAdminCancellationJobs";
const OPEN = new Set(["Open", "Locked", "Active"]);
const refId = (config, proposalId) => `${deploymentKey(config)}_${proposalId}`;
const fail = (code, message) => { throw new HttpsError(code, message); };
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const at = ms => Timestamp.fromMillis(ms);

async function requireCancellationAdmin(db, uid) {
  if (typeof uid !== "string" || !uid) fail("unauthenticated", "Sign in as an administrator.");
  const profile = await db.collection("users").doc(uid).get();
  if (!profile.exists || profile.data().role !== 1 || profile.data().suspended) {
    fail("permission-denied", "An active administrator account is required to cancel escrow.");
  }
}

function cancellationContext(options) {
  return loadFundingContext({ ...options, readDocument: async ref => {
    const snapshot = await ref.get();
    const data = snapshot.data();
    // Removal intentionally hides the posting owner from member content. The
    // server's preserved original owner is still needed to verify its escrow.
    if (snapshot.exists && ref.path.startsWith("proposals/") && !data.postingOwnerId
        && data.moderation?.originalPostingOwnerId) {
      return { ...snapshot, data: () => ({ ...data, postingOwnerId: data.moderation.originalPostingOwnerId }) };
    }
    return snapshot;
  } });
}

/** Commits the human administrator and mandatory reason in the on-chain void digest. */
export function adminCancellationReasonHash({ requestId, actorId, proposalEntityId, reason }) {
  return keccak256(stringToHex(JSON.stringify({ version: 1, action: "escrow_admin_cancel", requestId,
    actorId: actorId.toLowerCase(), proposalEntityId: proposalEntityId.toLowerCase(), reason })));
}

export function adminCancellationBlockReason(summary, { grant = false } = {}) {
  if (BigInt(summary.totalReleased) !== 0n) return "Escrow cannot be cancelled after any payment has been released.";
  if (!OPEN.has(summary.state)) return "This escrow is already closed or refundable.";
  if (grant && BigInt(summary.totalDeposited) <= 0n) {
    return "This grant has no accepted escrow deposit. Use the grant pool workflow to release its reservation.";
  }
  if (BigInt(summary.totalRefunded) !== 0n
      || BigInt(summary.outstandingBalance) !== BigInt(summary.totalDeposited)
      || BigInt(summary.custodyBalance) < BigInt(summary.outstandingBalance)) {
    return "The full recorded deposit cannot be verified in escrow custody.";
  }
  return null;
}

function publicRequest(job) {
  if (!job) return { status: "none", cancellation: null, request: null };
  const cancellation = {
    id: job.id, requestId: job.requestId, proposalId: job.proposalId, problemId: job.problemId,
    actorId: job.actorId, reason: job.reason, reasonHash: job.reasonHash,
    status: job.status, transactionHash: job.transactionHash || null, message: job.message || null,
    refundAmountBaseUnits: job.refundAmountBaseUnits || null, tokenSymbol: job.tokenSymbol,
    tokenDecimals: job.tokenDecimals, escrowAddress: job.escrowAddress, chainId: job.chainId,
    blockNumber: job.blockNumber ?? null, timestamp: job.timestamp ?? null,
    notificationStatus: job.notificationStatus || null,
  };
  return { status: job.status, cancellation, request: { ...cancellation, actor: job.actorId,
    txHash: cancellation.transactionHash, confirmedAt: job.timestamp ?? null } };
}

export async function getEscrowAdminCancellation({ db, client, config, uid, proposalId }) {
  await requireCancellationAdmin(db, uid);
  if (!validId(proposalId)) fail("invalid-argument", "Choose a valid proposal escrow.");
  const context = await cancellationContext({ db, uid, proposalId });
  if (isIndependentProposal(context.record)) fail("failed-precondition", "Independent listings use their dedicated crowdfunding cancellation workflow.");
  const job = await db.collection(ADMIN_CANCELLATIONS).doc(refId(config, proposalId)).get();
  const persisted = publicRequest(job.exists ? { ...job.data(), id: job.id } : null);
  let verified;
  try {
    await assertFundingChain(client, config);
    verified = await readVerifiedFunding({ client, config, ...context,
      blockNumber: await client.getBlockNumber({ cacheTime: 0 }) - 1n });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    return { ...persisted, proposalId, title: context.record.title, summary: null, canCancel: false,
      blockReason: "Escrow custody is temporarily unavailable. Refresh before requesting cancellation." };
  }
  const grant = context.record.opportunityType === "open-funding" || context.parent.opportunityType === "open-funding";
  const blockReason = job.exists ? "A cancellation request already exists for this escrow."
    : adminCancellationBlockReason(verified.summary, { grant });
  return { ...persisted, proposalId, title: context.record.title,
    summary: { ...verified.summary, ...(job.data()?.status === "complete" ? { refundReason: "admin_cancelled" } : {}) }, canCancel: !blockReason, blockReason };
}

/** A durable request is queued before signing. Queued never means refunded. */
export async function startEscrowAdminCancellation({ db, client, config, getWallet, uid, proposalId, reason,
  requestId, now = Timestamp.now() }) {
  await requireCancellationAdmin(db, uid);
  if (!validId(proposalId) || !validId(requestId)) fail("invalid-argument", "A valid proposal and cancellation request reference are required.");
  if (typeof reason !== "string" || !reason.trim() || reason.trim().length > 2000) {
    fail("invalid-argument", "Give a cancellation reason of 1 to 2,000 characters.");
  }
  reason = reason.trim();
  const maintenance = await db.collection("maintenanceState").doc("registryCutover").get();
  if (maintenance.data()?.active) fail("failed-precondition", "Escrow cancellation is paused during registry maintenance.");
  const id = refId(config, proposalId), ref = db.collection(ADMIN_CANCELLATIONS).doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    if (existing.data().requestId !== requestId || existing.data().actorId !== uid || existing.data().reason !== reason) {
      fail("already-exists", "A cancellation request already exists for this escrow. Review its status before retrying.");
    }
    return publicRequest({ ...existing.data(), id });
  }
  const context = await cancellationContext({ db, uid, proposalId });
  if (isIndependentProposal(context.record)) {
    fail("failed-precondition", "Independent listings use their dedicated crowdfunding cancellation workflow.");
  }
  await assertFundingChain(client, config);
  const verified = await readVerifiedFunding({ client, config, ...context,
    blockNumber: await client.getBlockNumber({ cacheTime: 0 }) - 1n });
  const grant = context.record.opportunityType === "open-funding" || context.parent.opportunityType === "open-funding";
  const blocked = adminCancellationBlockReason(verified.summary, { grant });
  if (blocked) fail("failed-precondition", blocked);
  const wallet = await getWallet();
  if (!await client.readContract({ address: config.escrow.factoryAddress, abi: config.escrow.factoryAbi,
    functionName: "isEscrowAdmin", args: [wallet.account.address], blockNumber: BigInt(verified.summary.blockNumber) })) {
    fail("failed-precondition", "The platform signer must be allowlisted as an escrow administrator.");
  }
  await enqueueEscrowFunding({ db, config, record: context.record, now });
  const job = { id, requestId, proposalId, problemId: context.record.problemId, actorId: uid, reason,
    reasonHash: adminCancellationReasonHash({ requestId, actorId: uid, proposalEntityId: verified.expected.entityId, reason }),
    registryAddress: config.address.toLowerCase(), chainId: config.chainId, escrowAddress: verified.escrow.address,
    tokenSymbol: verified.summary.tokenSymbol, tokenDecimals: verified.summary.tokenDecimals,
    status: "queued", message: "Cancellation is queued; deposits remain in escrow until chain confirmation.",
    refundAmountBaseUnits: null, createdAt: now, updatedAt: now, nextAttemptAt: now };
  const fundingRef = db.collection(FUNDING_JOBS).doc(id), proposalRef = db.collection("proposals").doc(proposalId);
  await db.runTransaction(async tx => {
    const [old, funding, proposal, outbox] = await Promise.all([tx.get(ref), tx.get(fundingRef), tx.get(proposalRef),
      tx.get(db.collection(PLATFORM_OUTBOX).doc(deploymentKey(config)))]);
    if (old.exists) {
      if (old.data().requestId !== requestId || old.data().actorId !== uid || old.data().reason !== reason) {
        fail("already-exists", "A cancellation request already exists for this escrow.");
      }
      return;
    }
    if (!funding.exists || !proposal.exists) fail("failed-precondition", "The escrow reconciliation job is unavailable.");
    const payment = outbox.data();
    if (payment?.proposalId === proposalId && (payment.transactionHash || payment.status === "preparing")
        && (payment.functionName === "lockSelection" || /^release/.test(payment.functionName || "")
          || /^(select|release|upfront|final):/.test(payment.actionKey || ""))) {
      fail("failed-precondition", "An escrow selection or payment is already being confirmed. Refresh its confirmed state before cancellation.");
    }
    tx.set(ref, job);
    tx.set(fundingRef, { ...funding.data(), adminCancellationId: id, adminCancellationStatus: "queued", updatedAt: now });
    tx.set(proposalRef, { ...proposal.data(), escrowAdminCancellation: { id, status: "queued" } });
  });
  try { await reconcileEscrowAdminCancellation({ db, client, config, getWallet, id, now }); }
  catch { /* Keep the durable request; retry without creating another transfer. */ }
  return { ...publicRequest({ ...(await ref.get()).data(), id }), proposalId, canCancel: false };
}

async function updateJob({ db, config, id, job, changes, now }) {
  const ref = db.collection(ADMIN_CANCELLATIONS).doc(id);
  await db.runTransaction(async tx => {
    const [current, funding, proposal] = await Promise.all([tx.get(ref),
      tx.get(db.collection(FUNDING_JOBS).doc(refId(config, job.proposalId))),
      tx.get(db.collection("proposals").doc(job.proposalId))]);
    if (!current.exists || current.data().requestId !== job.requestId || current.data().status === "complete") return;
    tx.set(ref, { ...current.data(), ...changes, updatedAt: now });
    if (changes.status && funding.exists) tx.set(funding.ref, { ...funding.data(), adminCancellationStatus: changes.status, updatedAt: now });
    if (changes.status && proposal.exists) tx.set(proposal.ref, { ...proposal.data(), escrowAdminCancellation: { id, status: changes.status } });
  });
}

/** Verify the exact successful anchor and reason before producing an audit or a notice. */
export async function reconcileEscrowAdminCancellation({ db, client, config, getWallet, id, now = Timestamp.now() }) {
  const ref = db.collection(ADMIN_CANCELLATIONS).doc(id), snapshot = await ref.get();
  if (!snapshot.exists) return;
  const job = snapshot.data();
  if (!same(job.registryAddress, config.address) || job.chainId !== config.chainId || ["blocked", "complete"].includes(job.status)) return;
  const context = await cancellationContext({ db, proposalId: job.proposalId });
  if (isIndependentProposal(context.record)) fail("failed-precondition", "Use the dedicated independent funding workflow.");
  const safeBlock = await client.getBlockNumber({ cacheTime: 0 }) - 1n;
  const verified = await readVerifiedFunding({ client, config, ...context, blockNumber: safeBlock });
  if (!same(verified.escrow.address, job.escrowAddress)
      || job.reasonHash !== adminCancellationReasonHash({ ...job, proposalEntityId: verified.expected.entityId })) {
    fail("failed-precondition", "The cancellation request no longer matches its canonical escrow.");
  }
  const actionKey = `admin-cancel:${id}:${job.reasonHash}`;
  const outbox = (await db.collection(PLATFORM_OUTBOX).doc(deploymentKey(config)).get()).data();
  let hash = job.transactionHash || (outbox?.actionKey === actionKey ? outbox.transactionHash : null)
    || (outbox?.lastActionKey === actionKey && outbox?.lastOutcome === "success" ? outbox.lastTransactionHash : null);
  if (outbox?.lastActionKey === actionKey && outbox?.lastOutcome === "replaced") {
    await updateJob({ db, config, id, job, now, changes: { status: "blocked", transactionHash: hash || outbox.lastTransactionHash,
      message: "The cancellation transaction was replaced. Its refund anchor was not confirmed." } });
    return;
  }
  if (hash) {
    let events;
    try { events = await reconcileFundingReceipt({ client, config, expected: verified.expected,
      escrowAddress: verified.escrow.address, transactionHash: hash, safeBlock }); }
    catch {
      let receipt;
      try { receipt = await client.getTransactionReceipt({ hash }); } catch { /* Pending RPC result. */ }
      if (receipt?.status === "reverted" && receipt.blockNumber <= safeBlock
          && same(receipt.blockHash, (await client.getBlock({ blockNumber: receipt.blockNumber })).hash)) {
        await updateJob({ db, config, id, job, now, changes: { status: "blocked", transactionHash: hash,
          message: "The cancellation transaction reverted. Deposits were not refunded." } });
      } else await updateJob({ db, config, id, job, now, changes: { status: "pending", transactionHash: hash,
        message: "Cancellation is awaiting its confirmed escrow audit anchor.", nextAttemptAt: at(now.toMillis() + 60_000) } });
      return;
    }
    const event = events.find(item => item.eventType === "Voided" && same(item.digest, job.reasonHash));
    if (!event) fail("failed-precondition", "The cancellation receipt has no matching administrator reason anchor.");
    // A serialized platform release that won the signer first is a cancellation
    // blocker. Moderation's partial-refund behavior is deliberately untouched.
    if (BigInt(verified.summary.totalReleased) !== 0n) {
      await updateJob({ db, config, id, job, now, changes: { status: "blocked", transactionHash: hash,
        message: "Escrow already released a payment. Manual full cancellation cannot be confirmed." } });
      return;
    }
    await confirmCancellation({ db, config, ref, job, event, verified, now });
    return;
  }
  try { await requireCancellationAdmin(db, job.actorId); }
  catch (error) {
    if (error instanceof HttpsError && error.code === "permission-denied") {
      await updateJob({ db, config, id, job, now, changes: { status: "blocked",
        message: "The requesting administrator is no longer authorized. No cancellation was submitted." } });
      return;
    }
    throw error;
  }
  const blocked = adminCancellationBlockReason(verified.summary,
    { grant: context.record.opportunityType === "open-funding" || context.parent.opportunityType === "open-funding" });
  if (blocked) {
    await updateJob({ db, config, id, job, now, changes: { status: "blocked", message: blocked } });
    return;
  }
  // Read the current total again at signing, after the shared outbox has resumed
  // any previous payout. Every platform payout uses that same durable signer.
  const guardedWallet = async () => {
    const wallet = await getWallet();
    const allowed = await client.readContract({ address: config.escrow.factoryAddress, abi: config.escrow.factoryAbi,
      functionName: "isEscrowAdmin", args: [wallet.account.address] });
    if (!allowed) fail("failed-precondition", "The platform signer is not an escrow administrator.");
    return { ...wallet, signTransaction: async request => {
      await requireCancellationAdmin(db, job.actorId);
      if (BigInt(await client.readContract({ address: verified.escrow.address, abi: config.escrow.escrowAbi,
        functionName: "totalReleased" })) !== 0n) fail("failed-precondition", "Escrow already released a payment.");
      return wallet.signTransaction(request);
    } };
  };
  const result = await submitPlatformAction({ db, client, config, getWallet: guardedWallet, now,
    action: { address: verified.escrow.address, abi: config.escrow.escrowAbi, functionName: "voidEscrow", args: [job.reasonHash],
      proposalId: job.proposalId, problemId: job.problemId, adminCancellationId: id, key: actionKey } });
  await updateJob({ db, config, id, job, now, changes: { status: result.transactionHash ? "pending" : "queued",
    transactionHash: result.transactionHash || null, nextAttemptAt: at(now.toMillis() + 60_000),
    message: "Cancellation is awaiting chain confirmation. Depositors will claim their own full refunds after confirmation." } });
}

async function confirmCancellation({ db, config, ref, job, event, verified, now }) {
  const audit = db.collection("audits").doc(`escrow_admin_cancel_${ref.id}`);
  const ownerNotice = db.collection("moderationNotifications").doc(`escrow_admin_cancel_${ref.id}_${verified.summary.postingOwnerId}`);
  const funding = db.collection(FUNDING_JOBS).doc(ref.id), proposal = db.collection("proposals").doc(job.proposalId);
  await db.runTransaction(async tx => {
    const [current, oldAudit, oldNotice, currentFunding, currentProposal] = await Promise.all([
      tx.get(ref), tx.get(audit), tx.get(ownerNotice), tx.get(funding), tx.get(proposal)]);
    if (!current.exists || current.data().status === "complete") return;
    const confirmed = { ...current.data(), status: "complete", message: "Cancellation is confirmed. Depositors can claim their full recorded deposits using the standard refund action.",
      transactionHash: event.transactionHash, blockNumber: event.blockNumber, blockHash: event.blockHash, timestamp: event.timestamp,
      refundAmountBaseUnits: verified.summary.totalDeposited, notificationStatus: "pending", nextAttemptAt: now, updatedAt: now };
    tx.set(ref, confirmed);
    if (!oldAudit.exists) tx.set(audit, { ...event, type: "escrow", action: "ESCROW_ADMIN_CANCELLED", targetId: job.proposalId,
      proposalId: job.proposalId, problemId: job.problemId, actor: job.actorId, chainActor: event.actor, reason: job.reason,
      reasonHash: job.reasonHash, cancellationId: ref.id, amountBaseUnits: verified.summary.totalDeposited,
      tokenSymbol: verified.summary.tokenSymbol, tokenDecimals: verified.summary.tokenDecimals,
      timestamp: at(event.timestamp * 1000), createdAt: now });
    if (!oldNotice.exists) tx.set(ownerNotice, cancellationNotice({ job: confirmed,
      recipientId: verified.summary.postingOwnerId, now }));
    if (currentFunding.exists) tx.set(funding, { ...currentFunding.data(), adminCancellationStatus: "complete", nextAttemptAt: now, updatedAt: now });
    if (currentProposal.exists) tx.set(proposal, { ...currentProposal.data(), escrowAdminCancellation: { id: ref.id, status: "complete" } });
  });
}

function cancellationNotice({ job, recipientId, now }) {
  return { ...memberNoticeFields({ recipientId, now, createdAt: at(job.timestamp * 1000), kind: "escrow",
    contentType: "proposal", contentId: job.proposalId, proposalId: job.proposalId, problemId: job.problemId,
    title: "Escrow cancelled by an administrator", message: `Escrow cancellation is confirmed. Depositors can claim their full deposits. Reason: ${job.reason}` }),
    cancellationId: job.id, transactionHash: job.transactionHash, registryAddress: job.registryAddress, reason: job.reason };
}

/** Page the already-verified deposit projection only once its scan covers the
 * cancellation block. Each notice is deterministic even for repeated deposits. */
async function notifyCancellationDepositors({ db, config, ref, job, now }) {
  const funding = (await db.collection(FUNDING_JOBS).doc(ref.id).get()).data();
  if (Number(funding?.cursorBlock ?? -1) < job.blockNumber) return;
  let query = db.collection(FUNDING_EVENTS).where("proposalId", "==", job.proposalId)
    .orderBy(FieldPath.documentId()).limit(25);
  if (job.notificationCursor) query = query.startAfter(job.notificationCursor);
  const page = await query.get();
  const recipients = [...new Set(page.docs.map(row => row.data()).filter(row => row.verified === true
    && row.eventType === "Deposit" && row.chainId === config.chainId && same(row.registryAddress, config.address)
    && same(row.escrowAddress, job.escrowAddress) && row.blockNumber <= job.blockNumber).map(row => row.actor))];
  await db.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (!current.exists || current.data().notificationCursor !== job.notificationCursor
        || current.data().notificationStatus === "complete") return;
    const refs = recipients.map(uid => db.collection("moderationNotifications").doc(`escrow_admin_cancel_${ref.id}_${uid}`));
    const notices = await Promise.all(refs.map(item => tx.get(item)));
    notices.forEach((old, i) => { if (!old.exists) tx.set(refs[i], cancellationNotice({ job, recipientId: recipients[i], now })); });
    tx.set(ref, { ...current.data(), notificationCursor: page.docs.at(-1)?.id || job.notificationCursor || null,
      notificationStatus: page.size < 25 ? "complete" : "pending", nextAttemptAt: now, updatedAt: now });
  });
}

export async function sweepEscrowAdminCancellations({ db, client, config, getWallet, now = Timestamp.now() }) {
  const maintenance = await db.collection("maintenanceState").doc("registryCutover").get();
  if (maintenance.data()?.active) return { maintenance: true };
  // Equality-only queries reuse normal indexes; each sweep has a fixed budget.
  const due = await db.collection(ADMIN_CANCELLATIONS).where("registryAddress", "==", config.address.toLowerCase())
    .where("status", "in", ["queued", "pending"]).limit(3).get();
  for (const row of due.docs) {
    if ((row.data().nextAttemptAt?.toMillis?.() || 0) > now.toMillis()) continue;
    try { await reconcileEscrowAdminCancellation({ db, client, config, getWallet, id: row.id, now }); }
    catch { await row.ref.update({ nextAttemptAt: at(now.toMillis() + 60_000), updatedAt: now,
      message: "Cancellation is waiting for verified escrow access. The persisted request will retry." }); }
  }
  const notices = await db.collection(ADMIN_CANCELLATIONS).where("registryAddress", "==", config.address.toLowerCase())
    .where("status", "==", "complete").where("notificationStatus", "==", "pending").limit(3).get();
  for (const row of notices.docs) await notifyCancellationDepositors({ db, config, ref: row.ref, job: row.data(), now });
  return { processed: due.size, notificationPages: notices.size };
}
