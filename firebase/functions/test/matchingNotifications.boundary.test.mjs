import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { memoryDb } from './memoryDb.mjs';
import { enqueueMatchingNotifications, processMatchingNotificationPage, resumeMatchingNotifications } from '../matchingNotifications.js';

const now = Timestamp.fromMillis(1_800_000_000_000);
function fixture(type = 'owner_selected') {
  return memoryDb({
    'problems/problem': { ownerId: 'owner', status: 'open' },
    'proposals/p000': { problemId: 'problem', researcherId: 'creator', status: 'submitted', amount: 100,
      matching: { evaluationComplete: true, fundedMinor: 10000, updatedAt: now } },
    'matchingEvents/event': { type, problemId: 'problem', proposalId: 'p000', createdAt: now },
  });
}
const notices = db => [...db.records].filter(([path]) => path.startsWith('moderationNotifications/')).map(([, data]) => data);
const page = db => processMatchingNotificationPage({ db, eventId: 'event', now });
async function finish(db) {
  for (let i = 0; i < 20; i++) if ((await page(db)).complete) return;
  assert.fail('Notification job did not finish within twenty pages');
}

for (const count of [99, 100, 101]) {
  test(`[boundary] notification fanout delivers all ${count} authors and ${count} funders once across 100-record pages`, async () => {
    const db = fixture();
    for (let i = 0; i < count; i++) {
      db.records.set(`proposals/p${String(i).padStart(3, '0')}`, { problemId: 'problem', status: 'submitted', researcherId: i === 0 ? 'creator' : `author${i}`, createdAt: now });
      db.records.set(`mockFunding/f${String(i).padStart(3, '0')}`, { problemId: 'problem', funderId: `funder${i}`, createdAt: now });
    }
    await enqueueMatchingNotifications({ db, eventId: 'event', now });
    await page(db); await page(db);
    const job = db.records.get('matchingNotificationJobs/event');
    assert.equal(job.phase, count < 100 ? 'funders' : 'authors');
    assert.equal(job.cursor, count < 100 ? null : 'p099');
    await finish(db);
    assert.equal(notices(db).length, 2 * count + 1);
    assert.equal(new Set(notices(db).map(row => row.recipientId)).size, 2 * count + 1);
    assert.equal(db.records.get('matchingNotificationJobs/event').scannedCount, 2 * count);
    assert.equal(db.records.get('matchingNotificationJobs/event').deliveredCount, 2 * count + 1);
    assert.deepEqual(await page(db), { complete: true, delivered: 0 });
  });
}

test('[boundary] funders at event time are included and those one millisecond later are excluded', async () => {
  const db = fixture();
  for (const offset of [-1, 0, 1]) db.records.set(`mockFunding/f${offset}`, {
    problemId: 'problem', funderId: `funder${offset}`, createdAt: Timestamp.fromMillis(now.toMillis() + offset),
  });
  await enqueueMatchingNotifications({ db, eventId: 'event', now }); await finish(db);
  assert.deepEqual(notices(db).filter(row => row.recipientId.startsWith('funder')).map(row => row.recipientId).sort(), ['funder-1', 'funder0']);
});

test('[boundary] resumer processes at most twenty jobs and rotates the twenty-first into the next batch', async () => {
  const db = fixture();
  for (let i = 0; i < 21; i++) {
    const eventId = `event${String(i).padStart(2, '0')}`;
    db.records.set(`matchingEvents/${eventId}`, { ...db.records.get('matchingEvents/event') });
    await enqueueMatchingNotifications({ db, eventId, now: Timestamp.fromMillis(now.toMillis() + i) });
  }
  assert.equal((await resumeMatchingNotifications({ db, now: Timestamp.fromMillis(now.toMillis() + 100) })).processed, 20);
  assert.equal(db.records.get('matchingNotificationJobs/event20').phase, 'owners');
  await resumeMatchingNotifications({ db, now: Timestamp.fromMillis(now.toMillis() + 200) });
  assert.equal(db.records.get('matchingNotificationJobs/event20').phase, 'authors');
});

for (const type of ['funding_contributed', 'unknown_event']) {
  test(`[negative] ${type} events do not queue decision or readiness notices`, async () => {
    const db = fixture(type);
    assert.deepEqual(await enqueueMatchingNotifications({ db, eventId: 'event', now }), { queued: false });
    assert.equal(db.records.has('matchingNotificationJobs/event'), false);
    assert.equal(notices(db).length, 0);
  });
}

test('[negative] missing events and jobs are harmless no-ops', async () => {
  const db = fixture();
  assert.deepEqual(await enqueueMatchingNotifications({ db, eventId: 'missing', now }), { queued: false });
  assert.deepEqual(await processMatchingNotificationPage({ db, eventId: 'missing', now }), { complete: true, delivered: 0 });
  assert.equal(notices(db).length, 0);
});

for (const [scope, flag] of [['problem', { moderated: true }], ['proposal', { moderated: true }]]) {
  test(`[negative] readiness notice is suppressed when ${scope} has legacy moderated flag`, async () => {
    const db = fixture('funding_target_reached');
    Object.assign(db.records.get(scope === 'problem' ? 'problems/problem' : 'proposals/p000'), flag);
    assert.equal((await enqueueMatchingNotifications({ db, eventId: 'event', now })).queued, false);
    await finish(db); assert.equal(notices(db).length, 0);
  });
}

test('[positive] readiness notification deduplicates simultaneous gate events after both gates hold', async () => {
  const db = fixture('funding_target_reached');
  db.records.set('matchingEvents/evaluation', { ...db.records.get('matchingEvents/event'), type: 'mock_evaluation_completed' });
  await Promise.all(['event', 'evaluation'].map(eventId => enqueueMatchingNotifications({ db, eventId, now })));
  await Promise.all(['event', 'evaluation'].map(eventId => processMatchingNotificationPage({ db, eventId, now })));
  assert.deepEqual(notices(db).map(row => row.recipientId), ['owner']);
});
