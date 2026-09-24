import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { memoryDb } from './memoryDb.mjs';
import { CONFIRMATION_WINDOW_MS, fundMockProposal, selectMockProposal, confirmMockProposal,
  getMockMatching, settleExpiredMockMatch, declineMockProposal } from '../matching.js';

const now = Timestamp.fromMillis(1_800_000_000_000);
const at = offset => Timestamp.fromMillis(now.toMillis() + offset);
const view = (db, uid = 'owner', time = now) => getMockMatching({ db, uid, problemId: 'p', now: time });
const accept = (db, uid, time = now, proposalId = 'a') => confirmMockProposal({ db, uid, problemId: 'p', proposalId, now: time });
const select = (db, time = now) => selectMockProposal({ db, uid: 'owner', problemId: 'p', proposalId: 'a', rationale: 'This proposal meets our needs.', now: time });
const fund = (db, proposalId, amount, requestId, time = now) => fundMockProposal({ db, uid: 'funder', problemId: 'p', proposalId, amount, requestId, now: time });
const ledger = db => [...db.records].filter(([path]) => path.startsWith('mockFunding/')).map(([, data]) => data);
const events = db => [...db.records].filter(([path]) => path.startsWith('matchingEvents/')).map(([, data]) => data);
async function fixture() {
  const db = memoryDb({
    'users/owner': {}, 'users/creator': {}, 'users/sibling': {}, 'users/funder': {},
    'problems/p': { ownerId: 'owner', currency: 'SGD', status: 'open' },
    'proposals/a': { problemId: 'p', researcherId: 'creator', status: 'submitted', title: 'Chosen proposal', amount: 100, currency: 'SGD', matching: { evaluationComplete: true } },
    'proposals/b': { problemId: 'p', researcherId: 'sibling', status: 'submitted', title: 'Sibling proposal', amount: 100, currency: 'SGD', matching: { evaluationComplete: true } },
  });
  await fund(db, 'a', 100, 'approval_funding_0001');
  await fund(db, 'b', 40, 'approval_funding_0002');
  await select(db);
  return db;
}

test('selecting accepts for the owner and starts one fixed creator acceptance window', async () => {
  const db = await fixture();
  const initial = await view(db);
  assert.equal(initial.matching.selectedBy, 'owner');
  assert.equal(initial.matching.selectedAt, now.toDate().toISOString());
  assert.equal(initial.matching.ownerApprovedBy, 'owner');
  assert.equal(initial.matching.ownerApprovedAt, now.toDate().toISOString());
  assert.equal(initial.matching.creatorApprovedBy, null);
  assert.equal(initial.proposals.find(p => p.id === 'a').canApproveOwner, false);
  assert.equal(initial.proposals.find(p => p.id === 'a').canConfirm, false);
  assert.equal(initial.proposals.find(p => p.id === 'a').canDecline, true);
  const creator = await view(db, 'creator');
  assert.equal(creator.proposals.find(p => p.id === 'a').canConfirm, true);
  assert.equal(creator.proposals.find(p => p.id === 'a').canDecline, true);
  assert.ok(initial.proposals.every(p => !p.canFund && !p.canSelect));
  const receipt = initial.history.find(event => event.type === 'owner_selected');
  assert.equal(receipt.ownerApprovedBy, 'owner');
  assert.equal(receipt.ownerApprovedAt, now.toDate().toISOString());
  await accept(db, 'owner', at(1000)); // Old clients may retry an already recorded acceptance.
  await select(db, at(3000));
  const pending = await view(db, 'owner', at(3000));
  assert.equal(pending.matching.status, 'awaiting_confirmation');
  assert.equal(pending.matching.deadlineAt, initial.matching.deadlineAt);
  assert.equal(pending.matching.ownerApprovedAt, initial.matching.ownerApprovedAt);
  assert.ok(ledger(db).every(row => row.status === 'pledged'));
  assert.equal(events(db).some(event => event.type === 'match_confirmed' || event.type === 'owner_confirmed'), false);
  for (const proposalId of ['a', 'b']) {
    await assert.rejects(() => fund(db, proposalId, 1, `approval_blocked_${proposalId}0003`, at(4000)), { code: 'failed-precondition' });
  }
  await accept(db, 'creator', at(5000));
  const confirmed = await view(db, 'funder', at(6000));
  assert.equal(confirmed.matching.status, 'confirmed');
  assert.equal(confirmed.matching.ownerApprovedBy, 'owner');
  assert.equal(confirmed.matching.creatorApprovedBy, 'creator');
  assert.equal(ledger(db).find(row => row.proposalId === 'a').status, 'locked');
  assert.equal(ledger(db).find(row => row.proposalId === 'b').status, 'refunded');
  for (const type of ['owner_selected', 'creator_confirmed', 'match_confirmed']) {
    assert.equal(events(db).filter(event => event.type === type).length, 1);
  }
  for (const uid of ['owner', 'creator']) {
    assert.equal((await view(db, uid)).proposals.find(p => p.id === 'a').canDecline, false);
    await assert.rejects(() => reject(db, uid), { code: 'failed-precondition' });
  }
});

const reject = (db, uid, time = now, proposalId = 'a') => declineMockProposal({ db, uid, problemId: 'p', proposalId,
  reason: 'Unable to commit to this selection.', now: time });

for (const uid of ['owner', 'creator']) {
  test(`${uid} can reject during the window; only selected funds refund and sibling funding resumes`, async () => {
    const db = await fixture();
    await reject(db, uid, at(1000));
    await reject(db, uid, at(2000));
    const rejected = await view(db, uid, at(2000));
    assert.equal(rejected.matching.status, 'open');
    assert.equal(rejected.matching.selectedBy, null);
    assert.equal(rejected.matching.selectedAt, null);
    assert.equal(rejected.matching.ownerApprovedBy, null);
    assert.equal(rejected.matching.creatorApprovedBy, null);
    assert.equal(rejected.proposals.find(p => p.id === 'a').matching.status, 'declined');
    assert.equal(rejected.proposals.find(p => p.id === 'b').canFund, true);
    assert.equal(ledger(db).find(row => row.proposalId === 'a').status, 'refunded');
    assert.equal(ledger(db).find(row => row.proposalId === 'a').refundReason, `${uid}_declined`);
    assert.equal(ledger(db).find(row => row.proposalId === 'b').status, 'pledged');
    assert.equal(events(db).filter(event => event.type === `${uid}_declined`).length, 1);
    assert.equal(events(db).find(event => event.type === `${uid}_declined`).actorId, uid);
    await assert.rejects(() => accept(db, 'creator', at(2000)), { code: 'failed-precondition' });
    await fund(db, 'b', 60, 'approval_sibling_resume', at(3000));
    await selectMockProposal({ db, uid: 'owner', problemId: 'p', proposalId: 'b', rationale: 'Proceed with the remaining proposal.', now: at(4000) });
    const next = await view(db, 'owner', at(4000));
    assert.equal(next.matching.deadlineAt, at(4000 + CONFIRMATION_WINDOW_MS).toDate().toISOString());
    assert.equal(next.matching.ownerApprovedBy, 'owner');
  });

  test(`${uid} rejection at the exact deadline preserves timeout settlement`, async () => {
    const db = await fixture();
    await assert.rejects(() => reject(db, uid, at(CONFIRMATION_WINDOW_MS)), { code: 'failed-precondition' });
    assert.equal(ledger(db).find(row => row.proposalId === 'a').refundReason, 'confirmation_expired');
    assert.equal(ledger(db).find(row => row.proposalId === 'b').status, 'refunded');
    assert.equal(events(db).some(event => event.type === `${uid}_declined`), false);
  });

  for (const first of ['accept', 'reject']) {
    test(`${uid} rejection races creator acceptance (${first} first) without double settlement`, async () => {
      const db = await fixture();
      const operations = first === 'accept' ? [() => accept(db, 'creator'), () => reject(db, uid)] : [() => reject(db, uid), () => accept(db, 'creator')];
      const outcomes = await Promise.allSettled(operations.map(operation => operation()));
      assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'failed-precondition');
      const terminal = events(db).filter(event => ['match_confirmed', 'owner_declined', 'creator_declined'].includes(event.type));
      assert.equal(terminal.length, 1);
      const confirmed = terminal[0].type === 'match_confirmed';
      assert.equal(ledger(db).find(row => row.proposalId === 'a').status, confirmed ? 'locked' : 'refunded');
      assert.equal(ledger(db).find(row => row.proposalId === 'b').status, confirmed ? 'refunded' : 'pledged');
      assert.equal(ledger(db).reduce((sum, row) => sum + row.amountMinor, 0), 14000);
    });
  }
}

test('owner selection alone cannot prevent expiry; creator must accept before the original deadline', async () => {
  const db = await fixture();
  await accept(db, 'owner', at(CONFIRMATION_WINDOW_MS - 1));
  await assert.rejects(() => accept(db, 'creator', at(CONFIRMATION_WINDOW_MS)), { code: 'failed-precondition' });
  const expired = await view(db, 'funder', at(CONFIRMATION_WINDOW_MS));
  assert.equal(expired.matching.status, 'invalidated');
  assert.equal(expired.proposals.find(p => p.id === 'a').matching.status, 'voided');
  assert.equal(expired.proposals.find(p => p.id === 'b').canFund, false);
  assert.equal(ledger(db).find(row => row.proposalId === 'a').status, 'refunded');
  assert.equal(ledger(db).find(row => row.proposalId === 'b').status, 'refunded');
  assert.equal(events(db).some(event => event.type === 'match_confirmed'), false);
  assert.equal(await settleExpiredMockMatch({ db, problemId: 'p', now: at(CONFIRMATION_WINDOW_MS) }), false);
});

test('concurrent repeated creator acceptances settle exactly once', async () => {
  const db = await fixture();
  await Promise.all(['owner', 'creator', 'owner', 'creator'].map(uid => accept(db, uid)));
  assert.equal((await view(db)).matching.status, 'confirmed');
  assert.equal(ledger(db).filter(row => row.status === 'locked').reduce((sum, row) => sum + row.amountMinor, 0), 10000);
  assert.equal(ledger(db).filter(row => row.status === 'refunded').reduce((sum, row) => sum + row.amountMinor, 0), 4000);
  for (const type of ['creator_confirmed', 'match_confirmed']) assert.equal(events(db).filter(event => event.type === type).length, 1);
  assert.equal(events(db).filter(event => event.type === 'owner_confirmed').length, 0);
});

test('outsiders and a sibling proposal creator cannot accept or reject the selection', async () => {
  const db = await fixture();
  for (const uid of ['funder', 'sibling']) {
    await assert.rejects(() => accept(db, uid), { code: 'permission-denied' });
    await assert.rejects(() => reject(db, uid), { code: 'permission-denied' });
  }
  await assert.rejects(() => accept(db, 'owner', now, 'b'), { code: 'failed-precondition' });
  await assert.rejects(() => reject(db, 'owner', now, 'b'), { code: 'failed-precondition' });
  const outsider = await view(db, 'funder');
  assert.ok(outsider.proposals.every(p => !p.canApproveOwner && !p.canConfirm && !p.canDecline));
});

test('legacy active matches retain their existing owner acceptance', async () => {
  const db = await fixture();
  delete db.records.get('problems/p').matching.selectedBy;
  await accept(db, 'creator', at(1000));
  const result = await view(db);
  assert.equal(result.matching.status, 'confirmed');
  assert.equal(result.matching.ownerApprovedAt, now.toDate().toISOString());
  assert.equal(events(db).filter(event => event.type === 'owner_confirmed').length, 0);
});
