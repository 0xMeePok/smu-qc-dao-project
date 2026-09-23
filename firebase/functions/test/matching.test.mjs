import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { memoryDb } from './memoryDb.mjs';
import { CONFIRMATION_WINDOW_MS, getMockMatching, fundMockProposal, selectMockProposal,
  confirmMockProposal, settleExpiredMockMatch, sweepExpiredMockMatches, getMockFundingPortfolio, declineMockProposal, completeMockEvaluation, forceExpireMockMatch, prepareModerationMatching } from '../matching.js';

const now = Timestamp.fromMillis(1_800_000_000_000);
const later = (ms) => Timestamp.fromMillis(now.toMillis() + ms);
function fixture() {
  return memoryDb({
    'users/admin': { role: 1 }, 'users/owner': {}, 'users/alice': {}, 'users/bob': {}, 'users/funder': {}, 'users/funder2': {},
    'users/suspended': { suspended: true },
    'problems/problem': { ownerId: 'owner', currency: 'SGD', status: 'open', expiresAt: later(30 * 86400000) },
    'proposals/a': { researcherId: 'alice', problemId: 'problem', title: 'A', amount: 100, currency: 'SGD', status: 'submitted', matching: { evaluationComplete: true } },
    'proposals/b': { researcherId: 'bob', problemId: 'problem', title: 'B', amount: 100, currency: 'SGD', status: 'submitted', matching: { evaluationComplete: true } },
  });
}
const fund = (db, proposalId = 'a', amount = 100, requestId = 'request_1234567890', uid = 'funder') =>
  fundMockProposal({ db, problemId: 'problem', proposalId, amount, requestId, uid, now });
const select = (db, proposalId = 'a', uid = 'owner') => selectMockProposal({ db, rationale: 'This approach meets our requirements.', problemId: 'problem', proposalId, uid, now });
const confirm = (db, proposalId = 'a', uid = 'alice', at = now) =>
  confirmMockProposal({ db, problemId: 'problem', proposalId, uid, now: at });
const get = (db, uid = 'owner', at = now) => getMockMatching({ db, uid, problemId: 'problem', now: at });
const rejects = (fn, code) => assert.rejects(fn, { code });

 test('funding alone cannot confirm; owner selection records acceptance and creator accepts to lock winner and refund sibling funders', async () => {
  const db = fixture();
  await fund(db, 'a', 40);
  await fund(db, 'a', 60, 'request_second_1234', 'funder2');
  await fund(db, 'b', 100, 'request_third_12345');
  assert.equal((await get(db)).matching.status, 'open');
  await rejects(() => confirm(db), 'failed-precondition');
  await select(db);
  const pending = await get(db, 'alice');
  assert.equal(pending.matching.status, 'awaiting_confirmation');
  assert.equal(pending.matching.deadlineAt, later(CONFIRMATION_WINDOW_MS).toDate().toISOString());
  assert.equal(pending.proposals.find(p => p.id === 'a').canConfirm, true);
  await rejects(() => select(db, 'b'), 'failed-precondition');
  await rejects(() => fund(db, 'b', 1, 'request_fourth_1234'), 'failed-precondition');
  await confirm(db);
  const state = await get(db);
  assert.equal(state.matching.status, 'confirmed');
  assert.equal(state.proposals.find(p => p.id === 'a').matching.status, 'confirmed');
  assert.equal(state.proposals.find(p => p.id === 'b').matching.status, 'cancelled');
  const funding = [...db.records.entries()].filter(([key]) => key.startsWith('mockFunding/')).map(([,v]) => v);
  assert.equal(funding.filter(v => v.status === 'locked').reduce((a,v) => a + v.amount, 0), 100);
  assert.equal(funding.filter(v => v.status === 'refunded').reduce((a,v) => a + v.amount, 0), 100);
  assert.equal(funding.find(v => v.status === 'refunded').refundReason, 'another_proposal_confirmed');
  assert.equal(db.records.get('proposals/a').status, 'submitted');
  assert.equal([...db.records.keys()].some(key => key.startsWith('funding/')), false);
  await confirm(db); // retries cannot settle again
  await select(db); // duplicate selection cannot reset the deadline or outcome
});

test('exact seven-day boundary invalidates posting and refunds every remaining pledge', async () => {
  const db = fixture();
  await fund(db);
  await fund(db, 'b', 60, 'request_second_1234');
  await select(db);
  await rejects(() => confirm(db, 'a', 'alice', later(CONFIRMATION_WINDOW_MS)), 'failed-precondition');
  const state = await get(db, 'funder', later(CONFIRMATION_WINDOW_MS));
  assert.equal(state.matching.status, 'invalidated');
  assert.equal(state.proposals.find(p => p.id === 'a').matching.status, 'voided');
  assert.equal(state.proposals.find(p => p.id === 'a').canFund, false);
  assert.equal(state.proposals.find(p => p.id === 'b').canFund, false);
  assert.deepEqual(state.contributions.map(c => c.status).sort(), ['refunded', 'refunded']);
  assert.equal(await settleExpiredMockMatch({ db, problemId: 'problem', now: later(CONFIRMATION_WINDOW_MS) }), false);
  await rejects(() => fundMockProposal({ db, uid: 'funder', problemId: 'problem', proposalId: 'b', amount: 40,
    requestId: 'request_complete_b', now: later(CONFIRMATION_WINDOW_MS) }), 'failed-precondition');
  assert.equal(state.history.filter(event => event.type === 'posting_invalidated').length, 1);
  assert.equal(state.matching.invalidationReason, 'confirmation_expired');
});

test('confirmation one millisecond before the shorter posting deadline succeeds', async () => {
  const db = fixture();
  db.records.get('problems/problem').expiresAt = later(1000);
  await fund(db);
  await select(db);
  await confirm(db, 'a', 'alice', later(999));
  assert.equal((await get(db, 'owner', later(CONFIRMATION_WINDOW_MS))).matching.status, 'confirmed');
});

test('contribution request IDs prevent duplicate money and reject changed payloads', async () => {
  const db = fixture();
  const results = await Promise.all([fund(db, 'a', 40), fund(db, 'a', 40)]);
  assert.equal(results[0].contributionId, results[1].contributionId);
  assert.equal((await get(db)).proposals.find(p => p.id === 'a').fundedAmount, 40);
  await rejects(() => fund(db, 'a', 50), 'already-exists');
  await rejects(() => fund(db, 'b', 40), 'already-exists');
  await fund(db, 'a', 60, 'request_second_1234');
  await select(db);
  await confirm(db);
  await fund(db, 'a', 40); // replay after settlement retains existing outcome
  assert.equal([...db.records.keys()].filter(k => k.startsWith('mockFunding/')).length, 2);
});

test('concurrent funding cannot overfund and concurrent owner selections have one winner', async () => {
  const db = fixture();
  const funded = await Promise.allSettled([fund(db, 'a', 70), fund(db, 'a', 70, 'request_second_1234')]);
  assert.equal(funded.filter(v => v.status === 'fulfilled').length, 1);
  await fund(db, 'a', 30, 'request_third_12345');
  await fund(db, 'b', 100, 'request_fourth_1234');
  const selected = await Promise.allSettled([select(db, 'a'), select(db, 'b')]);
  assert.equal(selected.filter(v => v.status === 'fulfilled').length, 1);
  assert.equal((await get(db)).matching.status, 'awaiting_confirmation');
});

test('actors and invalid funding are rejected; summaries omit proposal body and others contributions', async () => {
  const db = fixture();
  db.records.get('proposals/a').methodology = 'Private implementation details';
  for (const amount of [0, -1, NaN, Infinity, '10', 1.001, 1e12]) await rejects(() => fund(db, 'a', amount), 'invalid-argument');
  await rejects(() => fund(db, 'a', 10, 'request_1234567890', 'alice'), 'permission-denied');
  await rejects(() => fund(db, 'a', 10, 'request_1234567890', 'suspended'), 'permission-denied');
  await rejects(() => get(db, 'unknown'), 'permission-denied');
  await rejects(() => select(db), 'failed-precondition');
  await fund(db);
  await rejects(() => select(db, 'a', 'bob'), 'permission-denied');
  await select(db);
  await rejects(() => confirm(db, 'a', 'funder'), 'permission-denied');
  await rejects(() => confirm(db, 'b', 'bob'), 'failed-precondition');
  const state = await get(db, 'funder2');
  assert.equal(state.contributions.length, 0);
  assert.equal('methodology' in state.proposals[0], false);
  assert.equal('researcherId' in state.proposals[0], false);
  const portfolio = await getMockFundingPortfolio({ db, uid: 'funder', now: later(CONFIRMATION_WINDOW_MS) });
  assert.equal(portfolio.contributions[0].status, 'refunded');
});

test('new drafts and large candidate lists cannot strand funds; focused and paged summaries remain available', async () => {
  const db = fixture();
  await fund(db);
  for (let i = 0; i < 420; i++) {
    db.records.set(`proposals/draft${i}`, { researcherId: 'bob', problemId: 'problem', status: 'draft' });
    db.records.set(`proposals/candidate${i}`, { researcherId: 'bob', problemId: 'problem', status: 'submitted', amount: 100, currency: 'SGD' });
  }
  const page = await get(db);
  assert.equal(page.truncated, true);
  assert.ok(page.nextCursor);
  const next = await getMockMatching({ db, uid: 'owner', problemId: 'problem', cursor: page.nextCursor, now });
  assert.ok(next.proposals.some(p => p.id === 'candidate419'));
  const focused = await getMockMatching({ db, uid: 'funder', problemId: 'problem', proposalId: 'candidate419', now });
  assert.equal(focused.proposals.find(p => p.id === 'candidate419').canFund, true);
  await select(db);
  await confirm(db);
  const done = await getMockMatching({ db, uid: 'owner', problemId: 'problem', proposalId: 'candidate419', now });
  assert.equal(done.proposals.find(p => p.id === 'candidate419').matching.status, 'cancelled');
  assert.equal(done.matching.totalFundedMinor, 10000);
});

test('moderation and preexisting accepted solutions prevent new funding; expiry releases the active parent balance', async () => {
  for (const flag of [{ moderated: true }, { moderationStatus: 'hidden' }, { acceptedProposalId: 'old' }, { hasAcceptedSolution: true }]) {
    const db = fixture(); Object.assign(db.records.get('problems/problem'), flag);
    await rejects(() => fund(db), flag.moderated || flag.moderationStatus ? 'permission-denied' : 'failed-precondition');
    if (flag.moderated || flag.moderationStatus) await rejects(() => get(db, 'funder'), 'permission-denied');
    else assert.equal((await get(db, 'funder')).proposals[0].canFund, false);
  }
  const db = fixture(); await fund(db); await select(db);
  const state = await get(db, 'owner', later(CONFIRMATION_WINDOW_MS));
  assert.equal(state.matching.totalFundedMinor, 0);
});

test('original posting expiry invalidates a pending selection and refunds all proposal pledges', async () => {
  const db = fixture();
  db.records.get('problems/problem').expiresAt = later(1000);
  await fund(db); await fund(db, 'b', 40, 'request_second_1234'); await select(db);
  const pending = await get(db);
  assert.equal(pending.matching.deadlineAt, later(1000).toDate().toISOString());
  assert.equal(pending.matching.deadlineLimitedByPosting, true);
  const state = await get(db, 'funder', later(1000));
  assert.equal(state.matching.status, 'invalidated');
  assert.ok(state.proposals.every(proposal => !proposal.canFund && !proposal.canSelect));
  assert.ok(state.contributions.every(row => row.status === 'refunded'));
  await rejects(() => selectMockProposal({ db, rationale: 'Choose the remaining proposal.', uid: 'owner', problemId: 'problem', proposalId: 'b', now: later(1000) }), 'failed-precondition');
});

test('trusted time refresh after transaction reads rejects a newly expired confirmation and still commits refunds', async () => {
  const db = fixture(); await fund(db); await select(db);
  const original = Timestamp.now;
  const clock = [later(CONFIRMATION_WINDOW_MS - 1), later(CONFIRMATION_WINDOW_MS)];
  Timestamp.now = () => clock.shift() || later(CONFIRMATION_WINDOW_MS);
  try {
    await rejects(() => confirmMockProposal({ db, uid: 'alice', problemId: 'problem', proposalId: 'a' }), 'failed-precondition');
  } finally { Timestamp.now = original; }
  assert.equal(db.records.get('problems/problem').matching.status, 'invalidated');
  assert.equal((await get(db, 'funder', later(CONFIRMATION_WINDOW_MS))).contributions[0].status, 'refunded');
});

test('scheduled expiry refunds without any member opening the problem', async () => {
  const db = fixture(); await fund(db); await select(db);
  assert.equal((await sweepExpiredMockMatches({ db, now: later(CONFIRMATION_WINDOW_MS + 1) })).settled, 1);
  assert.equal(db.records.get('problems/problem').matching.totalFundedMinor, 0);
  assert.equal((await sweepExpiredMockMatches({ db, now: later(CONFIRMATION_WINDOW_MS + 1) })).settled, 0);
});

test('owner selection requires full funding and the evaluator feedback gate; rationale and creator handshake remain required', async () => {
  const db = fixture(); db.records.get('proposals/a').matching = {};
  await fund(db, 'a', 40);
  assert.equal((await get(db)).proposals.find(p => p.id === 'a').canSelect, false);
  await rejects(() => select(db), 'failed-precondition');
  await fund(db, 'a', 60, 'request_second_1234');
  const funded = (await get(db)).proposals.find(p => p.id === 'a');
  assert.equal(funded.matching.evaluationComplete, false);
  assert.equal(funded.canSelect, false);
  await assert.rejects(() => select(db), { code: 'failed-precondition', message: 'Selection opens after the evaluator feedback gate and full funding.' });
  db.records.get('proposals/a').matching.evaluationComplete = true;
  const ready = (await get(db)).proposals.find(p => p.id === 'a');
  assert.equal(ready.canSelect, true);
  assert.equal((await get(db, 'funder')).proposals.find(p => p.id === 'a').canSelect, false);
  await rejects(() => select(db, 'a', 'funder'), 'permission-denied');
  await rejects(() => selectMockProposal({ db, uid: 'owner', problemId: 'problem', proposalId: 'a', now }), 'invalid-argument');
  await select(db);
  const pending = await get(db, 'alice');
  assert.equal(pending.matching.status, 'awaiting_confirmation');
  assert.equal(pending.proposals.find(p => p.id === 'a').canConfirm, true);
  assert.equal(pending.history.find(event => event.type === 'owner_selected').evaluationComplete, true);
  await confirm(db);
  const confirmed = await get(db, 'funder');
  assert.equal(confirmed.matching.status, 'confirmed');
  assert.equal(confirmed.contributions.every(row => row.proposalId === 'a' && row.status === 'locked'), true);
});

test('optional admin mock evaluation is idempotent and survives funding and selection', async () => {
  const db = fixture(); db.records.get('proposals/a').matching = {};
  db.records.set('evaluations/fake', { proposalId: 'a', status: 'completed' });
  await fund(db, 'a', 40);
  await rejects(() => select(db), 'failed-precondition');
  await rejects(() => completeMockEvaluation({ db, uid: 'owner', problemId: 'problem', proposalId: 'a', now }), 'permission-denied');
  await completeMockEvaluation({ db, uid: 'admin', problemId: 'problem', proposalId: 'a', now });
  await completeMockEvaluation({ db, uid: 'admin', problemId: 'problem', proposalId: 'a', now });
  await fund(db, 'a', 60, 'request_second_1234');
  assert.equal((await get(db)).proposals.find(p => p.id === 'a').canSelect, true);
  await rejects(() => selectMockProposal({ db, uid: 'owner', problemId: 'problem', proposalId: 'a', now }), 'invalid-argument');
  await select(db);
  await select(db);
  await confirm(db);
  await confirm(db);
  const state = await get(db);
  assert.equal(state.matching.ownerApprovedBy, 'owner');
  assert.equal(state.matching.creatorApprovedBy, 'alice');
  assert.equal(state.matching.rationale, 'This approach meets our requirements.');
  for (const type of ['mock_evaluation_completed', 'owner_selected', 'creator_confirmed', 'match_confirmed']) {
    assert.equal(state.history.filter(event => event.type === type).length, 1);
  }
  assert.ok(state.history.every(event => event.mode === 'mock' && event.chainStatus === 'not_applicable'));
});

test('creator decline requires a reason, refunds only selected funds, preserves siblings evaluation and creates a fresh selection window', async () => {
  const db = fixture(); await fund(db); await fund(db, 'b', 100, 'request_second_1234'); await select(db);
  await rejects(() => declineMockProposal({ db, uid: 'alice', problemId: 'problem', proposalId: 'a', reason: '', now }), 'invalid-argument');
  await rejects(() => declineMockProposal({ db, uid: 'funder', problemId: 'problem', proposalId: 'a', reason: 'We cannot deliver this project.', now }), 'permission-denied');
  const input = { db, uid: 'alice', problemId: 'problem', proposalId: 'a', reason: 'We cannot deliver this project.', now: later(1000) };
  await declineMockProposal(input); await declineMockProposal(input);
  const state = await get(db, 'funder', later(1000));
  assert.equal(state.proposals.find(p => p.id === 'a').matching.status, 'declined');
  assert.equal(state.proposals.find(p => p.id === 'b').matching.evaluationComplete, true);
  assert.equal(state.contributions.find(c => c.proposalId === 'a').status, 'refunded');
  assert.equal(state.contributions.find(c => c.proposalId === 'a').refundReason, 'creator_declined');
  assert.equal(state.contributions.find(c => c.proposalId === 'b').status, 'pledged');
  assert.equal(state.history.filter(e => e.type === 'creator_declined').length, 1);
  await selectMockProposal({ db, uid: 'owner', problemId: 'problem', proposalId: 'b', rationale: 'Choose the remaining evaluated approach.', now: later(2000) });
  assert.equal((await get(db, 'owner', later(2000))).matching.deadlineAt, later(CONFIRMATION_WINDOW_MS + 2000).toDate().toISOString());
});

test('force-expiry is admin-only and records actor/time and refunds all sibling funds', async () => {
  const db = fixture(); await fund(db); await fund(db, 'b', 40, 'request_second_1234'); await select(db);
  await rejects(() => forceExpireMockMatch({ db, uid: 'owner', problemId: 'problem', now }), 'permission-denied');
  assert.equal((await get(db, 'admin')).canForceExpire, true);
  assert.equal((await forceExpireMockMatch({ db, uid: 'admin', problemId: 'problem', now })).expired, true);
  assert.equal((await forceExpireMockMatch({ db, uid: 'admin', problemId: 'problem', now })).expired, false);
  const state = await get(db, 'funder');
  assert.equal(state.matching.status, 'invalidated');
  assert.equal(state.contributions.find(c => c.proposalId === 'b').status, 'refunded');
  assert.equal(state.history.find(e => e.type === 'admin_force_expired').actorId, 'admin');
});

test('moderation settlement refunds selected scope, restores eligibility and never refunds a confirmed lock', async () => {
  const db = fixture(); await fund(db); await fund(db, 'b', 100, 'request_second_1234'); await select(db);
  const moderate = (contentType, contentId, action) => db.runTransaction(async tx => {
    const plan = await prepareModerationMatching({ tx, db, contentType, contentId, action, now, actorId: 'admin' });
    plan.apply(); return plan.summary;
  });
  assert.equal((await moderate('proposal', 'a', 'hide')).refundedAmount, 100);
  assert.equal((await get(db, 'funder')).matching.status, 'open');
  assert.equal((await get(db, 'funder')).contributions.find(c => c.proposalId === 'b').status, 'pledged');
  await moderate('proposal', 'a', 'restore');
  const restored = (await get(db, 'funder')).proposals.find(p => p.id === 'a');
  assert.equal(restored.fundedAmount, 0); assert.equal(restored.matching.evaluationComplete, true);
  await select(db, 'b'); await confirm(db, 'b', 'bob');
  assert.equal((await moderate('problem', 'problem', 'remove')).refundedAmount, 0);
  assert.equal((await get(db, 'funder')).contributions.find(c => c.proposalId === 'b').status, 'locked');
});

test('a concurrent moderation refund and creator confirmation conserve every contribution', async () => {
  const db = fixture(); await fund(db); await fund(db, 'b', 100, 'request_second_1234'); await select(db);
  await Promise.allSettled([
    confirm(db),
    db.runTransaction(async tx => {
      const plan = await prepareModerationMatching({ tx, db, contentType: 'problem', contentId: 'problem', action: 'hide', now, actorId: 'admin' });
      plan.apply();
      tx.update(db.collection('problems').doc('problem'), { moderationStatus: 'hidden', status: 'moderated_hidden' });
    }),
  ]);
  const rows = [...db.records.entries()].filter(([path]) => path.startsWith('mockFunding/')).map(([,data]) => data);
  assert.equal(rows.reduce((sum, row) => sum + row.amount, 0), 200);
  assert.equal(rows.filter(row => row.status === 'pledged').length, 0);
  assert.equal(rows.filter(row => row.status === 'locked').reduce((sum, row) => sum + row.amountMinor, 0), db.records.get('problems/problem').matching.totalFundedMinor);
});

test('rejection reopens only the original remaining posting window and reselection uses its shorter deadline', async () => {
  const db = fixture();
  const expiry = later(3 * 86400000);
  db.records.get('problems/problem').expiresAt = expiry;
  await fund(db); await fund(db, 'b', 100, 'request_other_target'); await select(db);
  await declineMockProposal({ db, uid: 'owner', problemId: 'problem', proposalId: 'a', reason: 'Choose a more suitable proposal.', now: later(86400000) });
  let state = await get(db, 'owner', later(86400000));
  assert.equal(state.matching.postingExpiresAt, expiry.toDate().toISOString());
  assert.equal(state.matching.reopenedAt, later(86400000).toDate().toISOString());
  assert.equal(state.history.filter(event => event.type === 'posting_reopened').length, 1);
  await selectMockProposal({ db, uid: 'owner', problemId: 'problem', proposalId: 'b', rationale: 'This proposal fits the remaining time.', now: later(2 * 86400000) });
  state = await get(db, 'owner', later(2 * 86400000));
  assert.equal(state.matching.deadlineAt, expiry.toDate().toISOString());
  assert.equal(state.matching.deadlineLimitedByPosting, true);
  await rejects(() => confirm(db, 'b', 'bob', expiry), 'failed-precondition');
  assert.equal((await get(db, 'funder', expiry)).matching.status, 'invalidated');
});

test('scheduled open posting expiry includes its exact deadline, refunds all pledged funds, and runs once', async () => {
  const db = fixture();
  db.records.get('problems/problem').expiresAt = later(1000);
  await fund(db, 'a', 40); await fund(db, 'b', 50, 'request_sibling_fund');
  assert.equal((await sweepExpiredMockMatches({ db, now: later(999) })).settled, 0);
  assert.equal((await sweepExpiredMockMatches({ db, now: later(1000) })).settled, 1);
  assert.equal((await sweepExpiredMockMatches({ db, now: later(1001) })).settled, 0);
  const state = await get(db, 'funder', later(1001));
  assert.equal(state.matching.status, 'invalidated');
  assert.equal(state.matching.invalidationReason, 'posting_expired');
  assert.equal(state.matching.totalFundedMinor, 0);
  assert.ok(state.contributions.every(row => row.status === 'refunded'));
  assert.equal(state.history.filter(event => event.type === 'posting_invalidated').length, 1);
  await rejects(() => fundMockProposal({ db, uid: 'funder', problemId: 'problem', proposalId: 'a', amount: 20, requestId: 'request_after_expiry', now: later(1001) }), 'failed-precondition');
});

test('an expired untouched legacy posting cannot start mock funding or selection', async () => {
  const db = fixture();
  db.records.get('problems/problem').expiresAt = now;
  await rejects(() => fund(db), 'failed-precondition');
  await rejects(() => select(db), 'failed-precondition');
  assert.equal((await get(db)).proposals.some(proposal => proposal.canFund || proposal.canSelect), false);
  assert.equal(db.records.get('problems/problem').matching, undefined);
});

test('off-chain acceptance receipts capture authenticated wallet, role and time without a chain transaction', async () => {
  const db = fixture();
  const wallet = `0x${'ab'.repeat(20)}`;
  db.records.set(`users/${wallet}`, {});
  db.records.get('problems/problem').ownerId = wallet;
  await fund(db); await select(db, 'a', wallet);
  const receipt = (await get(db, wallet)).history.find(event => event.type === 'owner_selected');
  assert.equal(receipt.actorRole, 'problem_owner');
  assert.equal(receipt.actorWallet, wallet);
  assert.equal(receipt.chainStatus, 'not_applicable');
  assert.equal(receipt.createdAt, now.toDate().toISOString());
  assert.equal(receipt.transactionHash, undefined);
  await select(db, 'a', wallet);
  assert.equal((await get(db, wallet)).history.filter(event => event.type === 'owner_selected').length, 1);
});

test('scheduled expiry settles legacy pending selections whose saved deadline exceeded the posting expiry', async () => {
  const db = fixture();
  db.records.get('problems/problem').expiresAt = later(1000);
  await fund(db); await select(db);
  // Existing records created before the posting-deadline cap may contain seven days.
  db.records.get('problems/problem').matching.deadlineAt = later(CONFIRMATION_WINDOW_MS);
  const pending = await get(db);
  assert.equal(pending.matching.deadlineAt, later(1000).toDate().toISOString());
  assert.equal(pending.matching.deadlineLimitedByPosting, true);
  assert.equal((await sweepExpiredMockMatches({ db, now: later(1000) })).settled, 1);
  const state = await get(db, 'funder', later(1000));
  assert.equal(state.matching.status, 'invalidated');
  assert.equal(state.contributions[0].status, 'refunded');
});
