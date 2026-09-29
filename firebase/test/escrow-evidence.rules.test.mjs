import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';

const AUTHOR = `0x${'81'.repeat(20)}`, OWNER = `0x${'91'.repeat(20)}`, MEMBER = `0x${'71'.repeat(20)}`;
const ADMIN = `0x${'61'.repeat(20)}`, SUSPENDED = `0x${'51'.repeat(20)}`, NO_PROFILE = `0x${'41'.repeat(20)}`;
const HASH = `0x${'a'.repeat(64)}`;
const terms = { token: `0x${'c'.repeat(40)}`, target: '100000000', funderVoting: true,
  trancheBps: [5000, 5000], reviewWindows: [604800, 2592000], milestoneHashes: [HASH, HASH] };
let env, serial = 0;
const dbFor = (uid) => uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
const evidenceRef = (uid, proposalId, hash = HASH) => doc(dbFor(uid), 'proposals', proposalId, 'deliveryEvidence', hash);
const evidence = (patch = {}) => ({ summary: 'Delivered benchmark and reproducible results.', url: 'https://example.org/results', ownerId: AUTHOR, createdAt: serverTimestamp(), ...patch });
async function seed(proposalPatch = {}, problemPatch = {}) {
  const proposalId = `escrow-evidence-${++serial}`, problemId = `escrow-evidence-parent-${serial}`;
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), 'problems', problemId), { ownerId: OWNER, status: 'submitted', ...problemPatch });
    await setDoc(doc(ctx.firestore(), 'proposals', proposalId), {
      researcherId: AUTHOR, postingOwnerId: OWNER, status: 'submitted', problemId, fundingTerms: terms, ...proposalPatch,
    });
  });
  return proposalId;
}
before(async () => {
  env = await initializeTestEnvironment({ projectId: 'qc-dao-rules-test', firestore: {
    rules: fs.readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
  } });
  await env.withSecurityRulesDisabled(async ctx => {
    for (const uid of [AUTHOR, OWNER, MEMBER, ADMIN, SUSPENDED]) await setDoc(doc(ctx.firestore(), 'users', uid), {
      address: uid, role: uid === ADMIN ? 1 : 0, suspended: uid === SUSPENDED,
    });
  });
});
after(async () => env?.cleanup());

test('delivery evidence is created by the proposal author and readable by authorized proposal viewers', async () => {
  const id = await seed();
  await assertSucceeds(setDoc(evidenceRef(AUTHOR, id), evidence()));
  for (const uid of [AUTHOR, OWNER, MEMBER, ADMIN]) await assertSucceeds(getDoc(evidenceRef(uid, id)));
  for (const uid of [null, SUSPENDED, NO_PROFILE]) await assertFails(getDoc(evidenceRef(uid, id)));
});

test('only the active author of a published escrow proposal may create delivery evidence', async () => {
  const id = await seed();
  for (const uid of [OWNER, MEMBER, ADMIN, SUSPENDED, NO_PROFILE, null]) {
    await assertFails(setDoc(evidenceRef(uid, id), evidence({ ownerId: uid || AUTHOR })));
  }
  for (const patch of [{ status: 'draft' }, { fundingTerms: undefined }, { researcherId: SUSPENDED }, { researcherId: NO_PROFILE }]) {
    const adjusted = { ...patch };
    if (Object.hasOwn(adjusted, 'fundingTerms')) delete adjusted.fundingTerms;
    const parentId = await seed(adjusted);
    if (Object.hasOwn(patch, 'fundingTerms')) {
      await env.withSecurityRulesDisabled(async ctx => {
        const ref = doc(ctx.firestore(), 'proposals', parentId);
        const data = (await getDoc(ref)).data(); delete data.fundingTerms;
        await setDoc(ref, data);
      });
    }
    const uid = patch.researcherId || AUTHOR;
    await assertFails(setDoc(evidenceRef(uid, parentId), evidence({ ownerId: uid })));
  }
  await assertFails(setDoc(evidenceRef(AUTHOR, 'no-parent'), evidence()));
});

test('delivery evidence enforces exact fields, owner, digest format, content bounds, HTTPS, and server creation time', async () => {
  const id = await seed();
  for (const patch of [
    { summary: 'x' }, { summary: 'x'.repeat(4001) }, { summary: 7 }, { url: '' },
    { url: 'http://example.org' }, { url: 'javascript:alert(1)' }, { url: 'https://example.org/has space' },
    { url: `https://example.org/${'x'.repeat(2048)}` }, { ownerId: OWNER },
    { createdAt: new Date(0) }, { unexpected: true },
  ]) await assertFails(setDoc(evidenceRef(AUTHOR, id), evidence(patch)));
  const missing = evidence(); delete missing.url;
  await assertFails(setDoc(evidenceRef(AUTHOR, id), missing));
  await assertFails(setDoc(evidenceRef(AUTHOR, id, 'not-a-digest'), evidence()));
  await assertSucceeds(setDoc(evidenceRef(AUTHOR, id), evidence({ summary: 'OK' })));
});

test('delivery evidence cannot be replaced, edited, or deleted even by its author or an administrator', async () => {
  const id = await seed();
  await assertSucceeds(setDoc(evidenceRef(AUTHOR, id), evidence()));
  for (const uid of [AUTHOR, ADMIN]) {
    await assertFails(setDoc(evidenceRef(uid, id), evidence()));
    await assertFails(updateDoc(evidenceRef(uid, id), { summary: 'Changed after delivery.' }));
    await assertFails(deleteDoc(evidenceRef(uid, id)));
  }
});

test('hidden proposal evidence follows parent access including revoked sponsor visibility', async () => {
  const id = await seed({ moderationStatus: 'hidden', postingOwnerId: null });
  await assertSucceeds(setDoc(evidenceRef(AUTHOR, id), evidence()));
  for (const uid of [AUTHOR, ADMIN]) await assertSucceeds(getDoc(evidenceRef(uid, id)));
  for (const uid of [OWNER, MEMBER]) await assertFails(getDoc(evidenceRef(uid, id)));
});

test('evidence access follows parent opportunity visibility while preserving author and owner access', async () => {
  for (const problemPatch of [{ status: 'draft' }, { moderationStatus: 'hidden' }]) {
    const id = await seed({}, problemPatch);
    await assertSucceeds(setDoc(evidenceRef(AUTHOR, id), evidence()));
    for (const uid of [AUTHOR, OWNER, ADMIN]) await assertSucceeds(getDoc(evidenceRef(uid, id)));
    await assertFails(getDoc(evidenceRef(MEMBER, id)));
  }
  for (const status of ['cancelled', 'expired']) {
    const id = await seed({}, { status });
    await assertSucceeds(setDoc(evidenceRef(AUTHOR, id), evidence()));
    await assertSucceeds(getDoc(evidenceRef(MEMBER, id)));
  }
});

test('evidence reads cannot bypass a missing proposal or private draft parent', async () => {
  for (const [id, parent] of [['missing-evidence-parent', false], [await seed({ status: 'draft', postingOwnerId: null }), true]]) {
    await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'proposals', id, 'deliveryEvidence', HASH), evidence()));
    await assertFails(getDoc(evidenceRef(MEMBER, id)));
    if (parent) await assertSucceeds(getDoc(evidenceRef(AUTHOR, id)));
    else await assertFails(getDoc(evidenceRef(AUTHOR, id)));
  }
});
