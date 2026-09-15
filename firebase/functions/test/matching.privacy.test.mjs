import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase-admin/firestore';
import { memoryDb } from './memoryDb.mjs';
import { fundMockProposal, getMockMatching, selectMockProposal, confirmMockProposal } from '../matching.js';

const now = Timestamp.fromMillis(1_800_000_000_000);
const funder = `0x${'f'.repeat(40)}`;
const types = new Set(['funding_contributed', 'funding_target_reached']);
async function fixture() {
  const db = memoryDb({
    'users/owner': { role: 0 }, 'users/creator': { role: 0 }, 'users/member': { role: 0 },
    [`users/${funder}`]: { role: 0 }, 'users/admin': { role: 1 }, 'users/stringAdmin': { role: '1' },
    'problems/p': { ownerId: 'owner', status: 'open', currency: 'SGD' },
    'proposals/a': { problemId: 'p', researcherId: 'creator', status: 'submitted', title: 'Proposal A', amount: 100, currency: 'SGD', matching: { evaluationComplete: true } },
  });
  for (const [index, amount] of [40, 60].entries()) {
    await fundMockProposal({ db, uid: funder, problemId: 'p', proposalId: 'a', amount, requestId: `privacy_request_${index}`, now });
  }
  return db;
}
const view = (db, uid, options = {}) => getMockMatching({ db, uid, problemId: 'p', now, ...options });

for (const uid of ['member', 'owner', 'creator', funder, 'stringAdmin']) {
  test(`funding history redacts contributor identities for non-admin ${uid}`, async () => {
    const db = await fixture();
    for (const options of [{}, { proposalId: 'a' }, { cursor: 'a' }]) {
      const result = await view(db, uid, options);
      const events = result.history.filter(event => types.has(event.type));
      assert.equal(events.length, 2);
      assert.ok(events.every(event => event.actorId === null));
      assert.ok(events.every(event => event.proposalId === 'a' && event.createdAt === now.toDate().toISOString()));
      assert.ok(!JSON.stringify(result).includes(funder));
      assert.equal(result.contributions.length, uid === funder ? 2 : 0);
      if (uid === funder) assert.equal(result.contributions.reduce((sum, row) => sum + row.amount, 0), 100);
    }
  });
}

test('administrator audit identities stay intact and member reads never mutate stored events', async () => {
  const db = await fixture();
  const original = [...db.records].filter(([path]) => path.startsWith('matchingEvents/'));
  assert.equal(original.length, 2);
  assert.ok(original.every(([, event]) => event.actorId === funder));
  await view(db, 'member');
  const admin = await view(db, 'admin');
  assert.ok(admin.history.every(event => event.actorId === funder));
  assert.deepEqual([...db.records].filter(([path]) => path.startsWith('matchingEvents/')), original);
});

test('funding history cannot expose identity aliases or nested internal metadata', async () => {
  const db = await fixture();
  for (const [path, event] of db.records) if (path.startsWith('matchingEvents/')) {
    db.records.set(path, { ...event, funderId: funder, details: { actorId: funder }, reason: funder });
  }
  assert.ok(!JSON.stringify((await view(db, 'member')).history).includes(funder));
  assert.ok((await view(db, 'admin')).history.every(event => event.funderId === funder));
});

test('public approval history and locked funding remain intact after creator confirmation', async () => {
  const db = await fixture();
  await selectMockProposal({ db, uid: 'owner', problemId: 'p', proposalId: 'a', rationale: 'Strong delivery plan.', now });
  await confirmMockProposal({ db, uid: 'creator', problemId: 'p', proposalId: 'a', now });
  const member = await view(db, 'member');
  assert.equal(member.history.find(event => event.type === 'owner_selected').actorId, 'owner');
  assert.equal(member.history.find(event => event.type === 'owner_selected').reason, 'Strong delivery plan.');
  assert.equal(member.history.find(event => event.type === 'creator_confirmed').actorId, 'creator');
  assert.equal(member.matching.status, 'confirmed');
  assert.ok(!JSON.stringify(member).includes(funder));
  assert.ok((await view(db, funder)).contributions.every(row => row.status === 'locked'));
});

test('readiness notification copies never disclose the funding actor or private event metadata', async () => {
  const { enqueueMatchingNotifications, processMatchingNotificationPage } = await import('../matchingNotifications.js');
  const { listModerationNotifications } = await import('../moderation.js');
  const db = await fixture();
  const [path, event] = [...db.records].find(([path, event]) => path.startsWith('matchingEvents/') && event.type === 'funding_target_reached');
  db.records.set(path, { ...event, funderId: funder, details: { actorId: funder } });
  const eventId = path.split('/')[1];
  await enqueueMatchingNotifications({ db, eventId, now });
  await processMatchingNotificationPage({ db, eventId, now });
  const notices = await listModerationNotifications({ db, uid: 'owner' });
  assert.equal(notices.items.length, 1);
  assert.ok(!JSON.stringify(notices).includes(funder));
});
