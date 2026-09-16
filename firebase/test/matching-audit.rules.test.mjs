import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteField, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
const OWNER = `0x${'a6'.repeat(20)}`, AUTHOR = `0x${'b6'.repeat(20)}`;
const originalHash = `0x${'3'.repeat(64)}`, forgedHash = `0x${'4'.repeat(64)}`;
let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'qc-dao-rules-test', firestore: { rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  await env.withSecurityRulesDisabled(async ctx => {
    for (const address of [OWNER, AUTHOR]) await setDoc(doc(ctx.firestore(), 'users', address), { address, role: 0, suspended: false, organisation: 'University' });
  });
});
after(async () => env?.cleanup());
function audit() {
  return { schemaVersion: 1, chainId: 421614, entityId: `0x${'1'.repeat(64)}`, contentHash: `0x${'2'.repeat(64)}`,
    status: 'pending', transactionHash: originalHash, blockNumber: 0, attemptCount: 1, lastError: '' };
}
async function seed(id, scope, state) {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const matching = state === 'unfunded' ? {} : { mode: 'mock', status: state === 'funded' ? 'open' : state, totalFundedMinor: 100 };
    await setDoc(doc(db, 'problems', id), {
      ownerId: OWNER, organisation: 'University', title: 'Audit gate regression', summary: 'A funded research problem',
      businessContext: 'Context', currentApproach: 'Baseline', currentLimitations: 'Limitations', expectedOutcome: 'Outcome', successCriteria: 'Criteria', dataAvailability: 'Available',
      categories: ['quantum'], amount: 100, currency: 'USDC', expiresAt: new Date('2099-01-01'), status: 'submitted', attachments: [],
      audit: audit(), createdAt: new Date(), updatedAt: new Date(), ...(matching.mode ? { matching } : {}),
    });
    if (scope === 'proposals') await setDoc(doc(db, scope, id), {
      researcherId: AUTHOR, postingOwnerId: OWNER, problemId: id, opportunityType: 'business-problem', title: 'Study proposal', summary: 'Research summary',
      category: 'quantum-annealing', methodology: 'Compare baselines', suitability: 'Combinatorial problem', expectedOutcomes: 'Measurable improvement', successCriteria: 'Lower distance',
      timeline: '12 weeks', milestones: 'Baseline then validation', team: 'Research team', amount: 100, currency: 'USDC', status: 'submitted', attachments: [],
      audit: audit(), createdAt: new Date(), updatedAt: new Date(),
      ...(matching.mode ? { matching: { mode: 'mock', status: state === 'funded' ? 'funding' : state, fundedMinor: 100 } } : {}),
    });
    const data = (await getDoc(doc(db, scope, id))).data();
    const { createdAt, updatedAt, audit: receipt, ...record } = data;
    // Attest only the original fixture, never the attempted malicious update.
    await setDoc(doc(db, 'publicationProofs', `${scope}_${id}`), { uid: scope === 'problems' ? OWNER : AUTHOR, record, transactionHash: originalHash });
  });
}
for (const scope of ['problems', 'proposals']) for (const state of ['unfunded', 'funded', 'awaiting_confirmation', 'confirmed']) {
  test(`${scope}/${state}: audit-only commitment exception still enforces audit, proof and timestamp validation`, async () => {
    const id = `audit-commitment-${scope}-${state}`;
    await seed(id, scope, state);
    const ref = doc(env.authenticatedContext(scope === 'problems' ? OWNER : AUTHOR).firestore(), scope, id);
    const original = (await getDoc(ref)).data();
    const attacks = [
      { audit: { ...audit(), transactionHash: forgedHash } }, { 'audit.transactionHash': forgedHash },
      { audit: deleteField() }, { 'audit.status': 'confirmed' }, { 'audit.status': 'invented' },
      { 'audit.schemaVersion': 99 }, { 'audit.chainId': 1 }, { 'audit.contentHash': 'not-a-hash' },
      { 'audit.extraField': 'forged metadata' }, { 'audit.attemptCount': 4 }, { 'audit.blockNumber': -1 },
      { 'audit.lastError': 'x'.repeat(501) }, { updatedAt: new Date('2000-01-01') }, { updatedAt: deleteField() },
    ];
    for (const attack of attacks) {
      await assertFails(updateDoc(ref, { updatedAt: serverTimestamp(), ...attack }));
      assert.deepEqual((await getDoc(ref)).data(), original);
    }
    await assertFails(setDoc(ref, { audit: { ...audit(), transactionHash: forgedHash }, updatedAt: serverTimestamp() }, { merge: true }));
    await assertSucceeds(updateDoc(ref, { 'audit.status': 'failed', 'audit.lastError': 'RPC temporarily unavailable', updatedAt: serverTimestamp() }));
    await assertSucceeds(updateDoc(ref, { 'audit.status': 'pending', 'audit.lastError': '', updatedAt: serverTimestamp() }));
    assert.equal((await getDoc(ref)).data().audit.transactionHash, originalHash);
  });
}

for (const scope of ['problems', 'proposals']) {
  test(`${scope}: a confirmed receipt cannot be downgraded or rewritten under the same transaction`, async () => {
    const id = `confirmed-audit-${scope}`;
    await seed(id, scope, 'funded');
    await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), scope, id), { 'audit.status': 'confirmed', 'audit.blockNumber': 42 }));
    const ref = doc(env.authenticatedContext(scope === 'problems' ? OWNER : AUTHOR).firestore(), scope, id);
    const original = (await getDoc(ref)).data();
    await assertFails(updateDoc(ref, { 'audit.status': 'pending', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(ref, { audit: { ...audit(), status: 'failed', entityId: forgedHash, contentHash: forgedHash }, updatedAt: serverTimestamp() }));
    assert.deepEqual((await getDoc(ref)).data(), original);
    await assertSucceeds(updateDoc(ref, { updatedAt: serverTimestamp() }));
  });
}

test('an unfunded problem can replace its confirmed receipt through a fresh trusted publication proof', async () => {
  const id = 'confirmed-audit-trusted-correction';
  await seed(id, 'problems', 'unfunded');
  await env.withSecurityRulesDisabled(ctx => updateDoc(doc(ctx.firestore(), 'problems', id), { 'audit.status': 'confirmed', 'audit.blockNumber': 42 }));
  const ref = doc(env.authenticatedContext(OWNER).firestore(), 'problems', id);
  const patch = { title: 'Attested correction', audit: { ...audit(), transactionHash: forgedHash }, updatedAt: serverTimestamp() };
  await assertFails(updateDoc(ref, patch));
  await env.withSecurityRulesDisabled(async ctx => {
    const data = (await getDoc(doc(ctx.firestore(), 'problems', id))).data();
    const { createdAt, updatedAt, audit: receipt, ...record } = data;
    await setDoc(doc(ctx.firestore(), 'publicationProofs', `problems_${id}`), { uid: OWNER, record: { ...record, title: patch.title }, transactionHash: forgedHash });
  });
  await assertSucceeds(updateDoc(ref, patch));
});
