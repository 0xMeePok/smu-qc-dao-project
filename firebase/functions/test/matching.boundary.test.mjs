import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { memoryDb } from './memoryDb.mjs';
import { CONFIRMATION_WINDOW_MS, fundMockProposal, selectMockProposal, confirmMockProposal,
  declineMockProposal, getMockMatching, settleExpiredMockMatch } from '../matching.js';

const now = Timestamp.fromMillis(1_800_000_000_000);
const at = offset => Timestamp.fromMillis(now.toMillis() + offset);
function fixture() {
  return memoryDb({
    'users/owner': {}, 'users/alice': {}, 'users/bob': {}, 'users/funder': {}, 'users/other': {},
    'problems/problem': { ownerId: 'owner', currency: 'SGD', status: 'open' },
    'proposals/a': { researcherId: 'alice', problemId: 'problem', title: 'A', amount: 100, currency: 'SGD', status: 'submitted', matching: { evaluationComplete: true } },
    'proposals/b': { researcherId: 'bob', problemId: 'problem', title: 'B', amount: 100, currency: 'SGD', status: 'submitted', matching: { evaluationComplete: true } },
  });
}
const fund = (db, extra = {}) => fundMockProposal({ db, uid: 'funder', problemId: 'problem', proposalId: 'a', amount: 100, requestId: 'boundary_request_0001', now, ...extra });
const select = (db, extra = {}) => selectMockProposal({ db, uid: 'owner', problemId: 'problem', proposalId: 'a', rationale: 'An evaluated approach.', now, ...extra });
const confirm = (db, extra = {}) => confirmMockProposal({ db, uid: 'alice', problemId: 'problem', proposalId: 'a', now, ...extra });
const decline = (db, extra = {}) => declineMockProposal({ db, uid: 'alice', problemId: 'problem', proposalId: 'a', reason: 'Unable to undertake it.', now, ...extra });
const rows = db => [...db.records].filter(([path]) => path.startsWith('mockFunding/')).map(([, row]) => row);
const history = db => [...db.records].filter(([path]) => path.startsWith('matchingEvents/')).map(([, row]) => row);

for (const [length, accepted] of [[9, false], [10, true], [2000, true], [2001, false]]) {
  for (const operation of ['select', 'decline']) {
    test(`[boundary] ${operation} trims and ${accepted ? 'accepts' : 'rejects'} ${length} characters`, async () => {
      const db = fixture(); await fund(db);
      if (operation === 'decline') await select(db);
      const text = ` \n${'x'.repeat(length)}\t `;
      const action = operation === 'select' ? () => select(db, { rationale: text }) : () => decline(db, { reason: text });
      if (accepted) {
        await action();
        const decision = history(db).find(row => row.type === (operation === 'select' ? 'owner_selected' : 'creator_declined'));
        assert.equal(decision.reason, 'x'.repeat(length));
      } else {
        const before = JSON.stringify([...db.records]);
        await assert.rejects(action, { code: 'invalid-argument' });
        assert.equal(JSON.stringify([...db.records]), before);
      }
    });
  }
}

test('[boundary] one cent completes an exact target and one extra cent cannot create money', async () => {
  const db = fixture();
  await fund(db, { amount: 99.99 });
  await assert.rejects(() => fund(db, { amount: 0.02, requestId: 'boundary_request_0002' }), { code: 'failed-precondition' });
  await fund(db, { amount: 0.01, requestId: 'boundary_request_0002' });
  assert.deepEqual(rows(db).map(row => row.amountMinor), [9999, 1]);
  assert.equal(db.records.get('proposals/a').matching.fundedMinor, 10000);
  assert.equal(history(db).filter(row => row.type === 'funding_target_reached').length, 1);
  await assert.rejects(() => fund(db, { amount: 0.01, requestId: 'boundary_request_0003' }), { code: 'failed-precondition' });
  await select(db); await confirm(db);
  assert.equal(rows(db).reduce((sum, row) => sum + row.amountMinor, 0), 10000);
  assert.ok(rows(db).every(row => row.status === 'locked'));
});

test('[boundary] maximum supported amount is accepted exactly; one cent above is rejected', async () => {
  const db = fixture(); db.records.get('proposals/a').amount = 1_000_000_000;
  await assert.rejects(() => fund(db, { amount: 1_000_000_000.01 }), { code: 'invalid-argument' });
  await fund(db, { amount: 1_000_000_000 }); await select(db); await confirm(db);
  assert.equal(rows(db)[0].amountMinor, 100_000_000_000);
  assert.equal(db.records.get('problems/problem').matching.totalFundedMinor, 100_000_000_000);
});

test('[positive] ordinary floating point arithmetic representing cents remains fundable', async () => {
  const db = fixture(); db.records.get('proposals/a').amount = 0.3;
  await fund(db, { amount: 0.1 + 0.2 }); await select(db); await confirm(db);
  assert.equal(rows(db)[0].amountMinor, 30);
});

for (const amount of [0.001, 0.000000001]) {
  test(`[boundary] positive sub-cent amount ${amount} cannot create a zero-value contribution`, async () => {
    const db = fixture();
    await assert.rejects(() => fund(db, { amount }), { code: 'invalid-argument' });
    assert.equal(rows(db).length, 0);
    assert.equal(history(db).length, 0);
  });
}

for (const [length, accepted] of [[15, false], [16, true], [80, true], [81, false]]) {
  test(`[boundary] request ID length ${length} is ${accepted ? 'accepted' : 'rejected'}`, async () => {
    const db = fixture(); const action = () => fund(db, { requestId: 'x'.repeat(length) });
    if (accepted) { await action(); await action(); assert.equal(rows(db).length, 1); }
    else { await assert.rejects(action, { code: 'invalid-argument' }); assert.equal(rows(db).length, 0); }
  });
}

test('[positive] request IDs are isolated by funder and replay safely after refunds', async () => {
  const db = fixture(); await fund(db, { amount: 50 }); await fund(db, { amount: 50, uid: 'other' });
  assert.equal(rows(db).length, 2);
  await select(db); await decline(db);
  await fund(db, { amount: 50 }); await fund(db, { amount: 50, uid: 'other' });
  assert.equal(rows(db).length, 2); assert.ok(rows(db).every(row => row.status === 'refunded'));
  assert.equal(db.records.get('problems/problem').matching.totalFundedMinor, 0);
});

for (const [field, value] of [['problemId', '../other'], ['proposalId', 'a/b'], ['proposalId', 'a'.repeat(129)], ['requestId', 'invalid/request/id']]) {
  test(`[negative] funding rejects malformed ${field}: ${String(value).slice(0, 20)}`, async () => {
    const db = fixture();
    await assert.rejects(() => fund(db, { [field]: value }), { code: 'invalid-argument' });
    assert.equal(rows(db).length, 0);
  });
}

test('[negative] unauthenticated funding and cross-problem proposals cannot create a ledger entry', async () => {
  const db = fixture();
  await assert.rejects(() => fund(db, { uid: null }), { code: 'unauthenticated' });
  db.records.get('proposals/a').problemId = 'unrelated';
  await assert.rejects(() => fund(db), { code: 'not-found' });
  assert.equal(rows(db).length, 0);
});

test('[negative] currency mismatch and moderated proposal block funding and selection', async () => {
  const db = fixture(); db.records.get('proposals/a').currency = 'USD';
  await assert.rejects(() => fund(db), { code: 'failed-precondition' });
  db.records.get('proposals/a').currency = 'SGD'; await fund(db);
  db.records.get('proposals/a').moderated = true;
  await assert.rejects(() => select(db), { code: 'failed-precondition' });
  await assert.rejects(() => fund(db, { amount: 1, requestId: 'boundary_request_0002' }), { code: 'failed-precondition' });
  assert.equal(rows(db)[0].status, 'pledged');
});

test('[boundary] 200th contribution succeeds, 201st fails, and all 200 still settle', async () => {
  const db = fixture(); db.records.get('proposals/a').amount = 2;
  for (let i = 0; i < 200; i++) await fund(db, { amount: 0.01, requestId: `boundary_request_${String(i).padStart(4, '0')}` });
  assert.equal(rows(db).length, 200);
  await assert.rejects(() => fund(db, { proposalId: 'b', amount: 1, requestId: 'boundary_request_0200' }), { code: 'resource-exhausted' });
  const state = await getMockMatching({ db, uid: 'funder', problemId: 'problem', now });
  assert.equal(state.proposals.find(row => row.id === 'b').canFund, false);
  await select(db); await confirm(db);
  assert.equal(rows(db).filter(row => row.status === 'locked').length, 200);
  assert.equal(rows(db).reduce((sum, row) => sum + row.amountMinor, 0), 200);
});

for (const count of [199, 200, 201]) {
  test(`[boundary] ${count} candidate summaries have complete cursor coverage`, async () => {
    const db = fixture(); db.records.delete('proposals/a'); db.records.delete('proposals/b');
    for (let i = 0; i < count; i++) db.records.set(`proposals/p${String(i).padStart(3, '0')}`, {
      problemId: 'problem', researcherId: 'alice', status: 'submitted', amount: 100, currency: 'SGD',
    });
    const first = await getMockMatching({ db, uid: 'funder', problemId: 'problem', now });
    assert.equal(first.proposals.length, Math.min(count, 200));
    assert.equal(first.truncated, count > 200);
    if (count > 200) {
      const second = await getMockMatching({ db, uid: 'funder', problemId: 'problem', now, cursor: first.nextCursor });
      assert.equal(second.proposals.length, 1); assert.equal(second.nextCursor, null);
      assert.equal(new Set([...first.proposals, ...second.proposals].map(row => row.id)).size, count);
    } else assert.equal(first.nextCursor, null);
  });
}

for (const offset of [-1, 0, 1]) {
  test(`[boundary] decline at seven-day deadline ${offset >= 0 ? '+' : ''}${offset}ms preserves timeout precedence`, async () => {
    const db = fixture(); await fund(db); await select(db);
    const action = () => decline(db, { now: at(CONFIRMATION_WINDOW_MS + offset) });
    if (offset < 0) await action();
    else await assert.rejects(action, { code: 'failed-precondition' });
    assert.equal(db.records.get('proposals/a').matching.status, offset < 0 ? 'declined' : 'voided');
    assert.equal(rows(db)[0].status, 'refunded');
    assert.equal(rows(db)[0].refundReason, offset < 0 ? 'creator_declined' : 'confirmation_expired');
    assert.equal(await settleExpiredMockMatch({ db, problemId: 'problem', now: at(CONFIRMATION_WINDOW_MS + 1) }), false);
  });
}

for (const first of ['confirm', 'decline']) {
  test(`[negative] conflicting ${first}-first creator decisions conserve funds and retain one terminal decision`, async () => {
    const db = fixture(); await fund(db); await fund(db, { proposalId: 'b', amount: 60, requestId: 'boundary_request_0002' }); await select(db);
    const actions = first === 'confirm' ? [() => confirm(db), () => decline(db)] : [() => decline(db), () => confirm(db)];
    const outcomes = await Promise.allSettled(actions.map(action => action()));
    assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'failed-precondition');
    assert.equal(history(db).filter(row => ['creator_confirmed', 'creator_declined'].includes(row.type)).length, 1);
    assert.equal(rows(db).reduce((sum, row) => sum + row.amountMinor, 0), 16000);
    assert.equal(rows(db).find(row => row.proposalId === 'a').status, first === 'confirm' ? 'locked' : 'refunded');
    assert.equal(rows(db).find(row => row.proposalId === 'b').status, first === 'confirm' ? 'refunded' : 'pledged');
  });
}

test('expired public postings retain read-only matching visibility without funding or selection', async () => {
  const db = fixture();
  db.records.get('problems/problem').status = 'expired';
  const view = await getMockMatching({ db, uid: 'funder', problemId: 'problem', now });
  assert.ok(view.proposals.length > 0);
  assert.ok(view.proposals.every(item => !item.canFund && !item.canSelect && !item.canCompleteEvaluation));
  await assert.rejects(() => fund(db), { code: 'failed-precondition' });
  await assert.rejects(() => select(db), { code: 'failed-precondition' });
});
