import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { fundMockProposal, selectMockProposal, confirmMockProposal, getMockMatching, completeMockEvaluation, declineMockProposal, CONFIRMATION_WINDOW_MS } from '../matching.js';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
test('Firestore contention: duplicate funding, overfunding, competing selections and deadline settlement', { skip: !enabled }, async () => {
  const app = initializeApp({ projectId: 'qc-dao-matching-transactions' }, `matching-${Date.now()}`);
  const db = getFirestore(app);
  const suffix = `${Date.now()}`, problemId = `problem-${suffix}`, a = `a-${suffix}`, b = `b-${suffix}`;
  const now = Timestamp.now();
  try {
    await Promise.all(['owner', 'alice', 'bob', 'funder', 'admin'].map(uid => db.collection('users').doc(uid).set({ suspended: false, role: uid === 'admin' ? 1 : 0 })));
    await db.collection('problems').doc(problemId).set({ ownerId: 'owner', status: 'open', currency: 'SGD', expiresAt: Timestamp.fromMillis(now.toMillis() + 30 * 86400000) });
    await Promise.all([[a, 'alice'], [b, 'bob']].map(([id, researcherId]) => db.collection('proposals').doc(id).set({ problemId, researcherId, status: 'submitted', title: id, currency: 'SGD', amount: 100 })));
    await Promise.all([a, b].map(proposalId => completeMockEvaluation({ db, uid: 'admin', problemId, proposalId, now })));
    const fund = (proposalId, amount, requestId) => fundMockProposal({ db, uid: 'funder', problemId, proposalId, amount, requestId, now });
    const duplicate = await Promise.all([fund(a, 40, `duplicate-${suffix}`), fund(a, 40, `duplicate-${suffix}`)]);
    assert.equal(duplicate[0].contributionId, duplicate[1].contributionId);
    const racing = await Promise.allSettled([fund(a, 60, `first-${suffix}`), fund(a, 60, `second-${suffix}`)]);
    assert.equal(racing.filter(v => v.status === 'fulfilled').length, 1);
    await fund(b, 100, `other-${suffix}`);
    const selections = await Promise.allSettled([a, b].map(proposalId => selectMockProposal({ db, rationale: 'This approach meets our requirements.', uid: 'owner', problemId, proposalId, now })));
    assert.equal(selections.filter(v => v.status === 'fulfilled').length, 1);
    const selected = (await getMockMatching({ db, uid: 'owner', problemId, now })).matching.proposalId;
    await assert.rejects(() => fund(selected === a ? b : a, 1, `blocked-${suffix}`), { code: 'failed-precondition' });
    await assert.rejects(() => confirmMockProposal({ db, uid: selected === a ? 'alice' : 'bob', problemId, proposalId: selected,
      now: Timestamp.fromMillis(now.toMillis() + CONFIRMATION_WINDOW_MS) }), { code: 'failed-precondition' });
    const final = await getMockMatching({ db, uid: 'funder', problemId, now: Timestamp.fromMillis(now.toMillis() + CONFIRMATION_WINDOW_MS) });
    assert.equal(final.matching.status, 'invalidated');
    assert.equal(final.contributions.filter(c => c.status === 'refunded').reduce((sum, c) => sum + c.amount, 0), 200);
    assert.equal(final.contributions.filter(c => c.status === 'pledged').length, 0);
    assert.equal(final.history.filter(event => event.type === 'posting_invalidated').length, 1);
    const next = Timestamp.fromMillis(now.toMillis() + CONFIRMATION_WINDOW_MS + 1);
    await assert.rejects(() => selectMockProposal({ db, uid: 'owner', problemId, proposalId: selected === a ? b : a,
      rationale: 'Select the remaining proposal.', now: next }), { code: 'failed-precondition' });
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});

test('Firestore contention: creator acceptance settles once under concurrent retries after owner selection', { skip: !enabled }, async () => {
  const app = initializeApp({ projectId: 'qc-dao-matching-transactions' }, `matching-approvals-${Date.now()}`);
  const db = getFirestore(app);
  const suffix = `${Date.now()}`, problemId = `approval-${suffix}`, proposalId = `proposal-${suffix}`;
  const now = Timestamp.now();
  try {
    await Promise.all(['owner', 'creator', 'funder'].map(uid => db.collection('users').doc(uid).set({ suspended: false })));
    await db.collection('problems').doc(problemId).set({ ownerId: 'owner', status: 'open', currency: 'SGD' });
    await db.collection('proposals').doc(proposalId).set({ problemId, researcherId: 'creator', status: 'submitted', currency: 'SGD', amount: 100 });
    await fundMockProposal({ db, uid: 'funder', problemId, proposalId, amount: 100, requestId: `approvals-${suffix}`, now });
    await selectMockProposal({ db, uid: 'owner', problemId, proposalId, rationale: 'A suitable proposal to start the project.', now });
    const selected = await getMockMatching({ db, uid: 'owner', problemId, now });
    assert.equal(selected.matching.ownerApprovedBy, 'owner');
    assert.equal(selected.matching.creatorApprovedBy, null);
    await Promise.all(['owner', 'creator', 'owner', 'creator'].map(uid => confirmMockProposal({ db, uid, problemId, proposalId, now })));
    const result = await getMockMatching({ db, uid: 'funder', problemId, now });
    assert.equal(result.matching.status, 'confirmed');
    assert.equal(result.contributions.length, 1);
    assert.equal(result.contributions[0].status, 'locked');
    for (const type of ['creator_confirmed', 'match_confirmed']) {
      assert.equal(result.history.filter(event => event.type === type).length, 1);
    }
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});

test('Firestore contention: owner rejection races creator acceptance with exactly one settlement', { skip: !enabled }, async () => {
  const app = initializeApp({ projectId: 'qc-dao-matching-transactions' }, `matching-rejection-${Date.now()}`);
  const db = getFirestore(app);
  const suffix = `${Date.now()}`, problemId = `rejection-${suffix}`, proposalId = `rejection-proposal-${suffix}`;
  const now = Timestamp.now();
  try {
    await Promise.all(['owner', 'creator', 'funder'].map(uid => db.collection('users').doc(uid).set({ suspended: false })));
    await db.collection('problems').doc(problemId).set({ ownerId: 'owner', status: 'open', currency: 'SGD' });
    await db.collection('proposals').doc(proposalId).set({ problemId, researcherId: 'creator', status: 'submitted', currency: 'SGD', amount: 100 });
    await fundMockProposal({ db, uid: 'funder', problemId, proposalId, amount: 100, requestId: `rejection-${suffix}`, now });
    await selectMockProposal({ db, uid: 'owner', problemId, proposalId, rationale: 'A suitable proposal to start the project.', now });
    const outcomes = await Promise.allSettled([
      confirmMockProposal({ db, uid: 'creator', problemId, proposalId, now }),
      declineMockProposal({ db, uid: 'owner', problemId, proposalId, reason: 'We cannot commit to this project.', now }),
    ]);
    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    const result = await getMockMatching({ db, uid: 'funder', problemId, now });
    assert.equal(result.history.filter(event => ['match_confirmed', 'owner_declined'].includes(event.type)).length, 1);
    assert.equal(result.contributions[0].status, result.matching.status === 'confirmed' ? 'locked' : 'refunded');
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});
