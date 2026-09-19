import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { memoryDb } from './memoryDb.mjs';
import { enqueueMatchingNotifications, processMatchingNotificationPage, resumeMatchingNotifications } from '../matchingNotifications.js';
const at = Timestamp.fromMillis(1800000000000);
const event = (type = 'owner_selected') => ({ type, problemId: 'problem', proposalId: 'proposal000', createdAt: at });
const notices = db => [...db.records.entries()].filter(([path]) => path.startsWith('moderationNotifications/')).map(([path, data]) => ({ path, ...data }));
function fixture(type = 'owner_selected') {
  return memoryDb({
    'problems/problem': { ownerId: 'owner', status: 'open' },
    'proposals/proposal000': { researcherId: 'creator', problemId: 'problem', status: 'submitted', amount: 100,
      matching: { evaluationComplete: true, fundedMinor: 10000 } },
    'matchingEvents/event': event(type),
  });
}

test('fanout resumes beyond 200 authors, deduplicates funders and authors, and retains read acknowledgements', async () => {
  const db = fixture();
  for (let i = 0; i < 275; i++) db.records.set(`proposals/proposal${String(i).padStart(3, '0')}`, {
    researcherId: i === 0 ? 'creator' : `author${i}`, problemId: 'problem', status: 'submitted' });
  for (let i = 0; i < 120; i++) db.records.set(`mockFunding/fund${String(i).padStart(3, '0')}`, { problemId: 'problem', funderId: `funder${i}`, createdAt: at });
  db.records.set('mockFunding/duplicate', { problemId: 'problem', funderId: 'creator' });
  db.records.set('proposals/draft', { problemId: 'problem', researcherId: 'draft-author', status: 'draft' });
  db.records.set('proposals/future', { problemId: 'problem', researcherId: 'future-author', status: 'submitted', createdAt: Timestamp.fromMillis(at.toMillis() + 1) });
  await enqueueMatchingNotifications({ db, eventId: 'event', now: at });
  await processMatchingNotificationPage({ db, eventId: 'event', now: at });
  assert.equal(notices(db).length, 2);
  const first = notices(db).find(n => n.recipientId === 'creator');
  db.records.get(first.path).readAt = at;
  for (let step = 0; step < 12 && db.records.get('matchingNotificationJobs/event').status !== 'complete'; step++) {
    await Promise.all([enqueueMatchingNotifications({ db, eventId: 'event', now: at }), resumeMatchingNotifications({ db, now: at })]);
  }
  assert.equal(db.records.get('matchingNotificationJobs/event').status, 'complete');
  assert.equal(notices(db).length, 396);
  assert.equal(new Set(notices(db).map(n => n.recipientId)).size, 396);
  assert.equal(db.records.get(first.path).readAt, at);
  assert.equal(notices(db).some(n => ['draft-author', 'future-author'].includes(n.recipientId)), false);
  assert.equal(notices(db).find(n => n.recipientId === 'creator').message.includes('Your proposal was selected'), true);
  assert.equal(notices(db).find(n => n.recipientId === 'author274').navigationTarget, 'posting/problem');
  await processMatchingNotificationPage({ db, eventId: 'event', now: at });
  assert.equal(notices(db).length, 396);
});

test('a failed page commits neither notifications nor progress and safely resumes', async () => {
  const db = fixture(); await enqueueMatchingNotifications({ db, eventId: 'event', now: at });
  const failing = { ...db, runTransaction: fn => db.runTransaction(async tx => { await fn(tx); throw new Error('Interrupted'); }) };
  await assert.rejects(() => processMatchingNotificationPage({ db: failing, eventId: 'event', now: at }), /Interrupted/);
  assert.equal(notices(db).length, 0);
  assert.equal(db.records.get('matchingNotificationJobs/event').phase, 'owners');
  await Promise.all([processMatchingNotificationPage({ db, eventId: 'event', now: at }), processMatchingNotificationPage({ db, eventId: 'event', now: at })]);
  assert.equal(notices(db).length, 2);
});

test('selection decisions produce accurate messages and fully funded proposals notify owners without evaluation', async () => {
  for (const [type, fragment] of [['owner_confirmed', 'problem owner accepted'], ['creator_confirmed', 'creator accepted'], ['match_confirmed', 'funding is locked'], ['owner_declined', 'owner rejected'], ['creator_declined', 'creator declined'], ['confirmation_expired', 'window expired'], ['admin_force_expired', 'window expired']]) {
    const db = fixture(type);
    await enqueueMatchingNotifications({ db, eventId: 'event', now: at });
    await processMatchingNotificationPage({ db, eventId: 'event', now: at });
    assert.equal(notices(db).every(n => n.message.includes(fragment)), true);
    assert.equal(notices(db).every(n => n.mode === 'mock' && n.kind === 'matching'), true);
  }
  const db = fixture('funding_target_reached');
  db.records.get('proposals/proposal000').matching.evaluationComplete = false;
  assert.equal((await enqueueMatchingNotifications({ db, eventId: 'event', now: at })).queued, true);
  await processMatchingNotificationPage({ db, eventId: 'event', now: at });
  db.records.get('proposals/proposal000').matching.evaluationComplete = true;
  db.records.set('matchingEvents/evaluation', event('mock_evaluation_completed'));
  assert.equal((await enqueueMatchingNotifications({ db, eventId: 'evaluation', now: at })).queued, false);
  await processMatchingNotificationPage({ db, eventId: 'evaluation', now: at });
  assert.deepEqual(notices(db).map(n => n.recipientId), ['owner']);
  assert.match(notices(db)[0].message, /proposal has reached its funding target/);
  assert.doesNotMatch(notices(db)[0].message, /evaluation/);
  db.records.set('matchingEvents/target_retry', event('funding_target_reached'));
  await enqueueMatchingNotifications({ db, eventId: 'target_retry', now: at });
  await processMatchingNotificationPage({ db, eventId: 'target_retry', now: at });
  assert.equal(notices(db).length, 1); // Retried funding events describe one readiness transition.
});

test('selection notices preserve the actual shortened deadline even when delivery is delayed', async () => {
  const db = fixture();
  const deadlineAt = Timestamp.fromMillis(at.toMillis() + 2 * 24 * 60 * 60 * 1000);
  Object.assign(db.records.get('matchingEvents/event'), { deadlineAt, deadlineLimitedByPosting: true });
  await enqueueMatchingNotifications({ db, eventId: 'event', now: at });
  // A later selection must not alter the deadline in this immutable event's notices.
  db.records.get('problems/problem').matching = { deadlineAt: Timestamp.fromMillis(at.toMillis() + 7 * 24 * 60 * 60 * 1000) };
  await processMatchingNotificationPage({ db, eventId: 'event', now: at });
  const expected = deadlineAt.toDate().toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  for (const notice of notices(db)) {
    assert.ok(notice.message.includes(expected));
    assert.match(notice.message, /shortened to the original posting deadline/);
    assert.doesNotMatch(notice.message, /within seven days|has seven days/);
  }
});

for (const type of ['confirmation_expired', 'admin_force_expired', 'posting_expired']) {
  test(`${type} notifies all stakeholders that the posting is invalidated and all pledges refunded`, async () => {
    const db = fixture(type);
    db.records.set('proposals/sibling', { problemId: 'problem', researcherId: 'sibling-creator', status: 'submitted' });
    db.records.set('mockFunding/sibling', { problemId: 'problem', funderId: 'sibling-funder', createdAt: at });
    await enqueueMatchingNotifications({ db, eventId: 'event', now: at });
    for (let i = 0; i < 4; i++) await processMatchingNotificationPage({ db, eventId: 'event', now: at });
    assert.deepEqual(notices(db).map(n => n.recipientId).sort(), ['creator', 'owner', 'sibling-creator', 'sibling-funder']);
    for (const notice of notices(db)) {
      assert.match(notice.message, /posting is invalidated/);
      assert.match(notice.message, /All outstanding mock contributions/);
      assert.doesNotMatch(notice.message, /reopen/);
    }
  });
}

for (const type of ['posting_reopened', 'posting_invalidated']) {
  test(`${type} audit events do not duplicate their primary decision notices`, async () => {
    const db = fixture(type);
    assert.deepEqual(await enqueueMatchingNotifications({ db, eventId: 'event', now: at }), { queued: false });
    assert.equal(notices(db).length, 0);
  });
}
