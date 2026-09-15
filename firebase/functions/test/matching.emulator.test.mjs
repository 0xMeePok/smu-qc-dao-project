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
    assert.equal(final.matching.status, 'open');
    assert.equal(final.contributions.filter(c => c.status === 'refunded').reduce((sum, c) => sum + c.amount, 0), 100);
    assert.equal(final.contributions.filter(c => c.status === 'pledged').reduce((sum, c) => sum + c.amount, 0), 100);
    const remaining = selected === a ? b : a, creator = remaining === a ? 'alice' : 'bob';
    const next = Timestamp.fromMillis(now.toMillis() + CONFIRMATION_WINDOW_MS + 1);
    await selectMockProposal({ db, uid: 'owner', problemId, proposalId: remaining, rationale: 'Select the remaining evaluated proposal.', now: next });
    const decisions = await Promise.allSettled([
      confirmMockProposal({ db, uid: creator, problemId, proposalId: remaining, now: next }),
      declineMockProposal({ db, uid: creator, problemId, proposalId: remaining, reason: 'We cannot deliver within the proposed budget.', now: next }),
    ]);
    assert.equal(decisions.filter(value => value.status === 'fulfilled').length, 1);
    const resolved = await getMockMatching({ db, uid: 'funder', problemId, now: next });
    assert.equal(resolved.history.filter(event => ['creator_confirmed', 'creator_declined'].includes(event.type)).length, 1);
    assert.equal(resolved.contributions.filter(c => c.status === 'pledged').length, 0);
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});
