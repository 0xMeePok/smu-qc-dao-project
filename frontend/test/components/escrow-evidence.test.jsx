import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn(), auth: { currentUser: null } }));
vi.mock('../../src/lib/firebase.js', () => ({ db: {}, auth: mocks.auth }));
vi.mock('../../src/lib/authFlow.js', () => ({ requireFirebase: () => {} }));
vi.mock('firebase/firestore', () => ({
  doc: (_db, ...parts) => ({ path: parts.join('/') }), getDoc: mocks.get, setDoc: mocks.set,
  serverTimestamp: () => 'server-time',
}));
import { hashEscrowEvidence } from '../../src/lib/escrow.js';
import { loadEscrowEvidence, saveEscrowEvidence } from '../../src/lib/escrowEvidence.js';
const ownerId = `0x${'a'.repeat(40)}`;
const evidence = { summary: 'Delivered results', url: 'https://example.org/results' };
const payload = (patch = {}) => ({ proposalId: 'proposal', ownerId, evidence, evidenceHash: hashEscrowEvidence(evidence), ...patch });
const snapshot = (data) => ({ exists: () => Boolean(data), data: () => data });
beforeEach(() => {
  mocks.auth.currentUser = { uid: ownerId };
  mocks.set.mockReset().mockResolvedValue(undefined);
  mocks.get.mockReset().mockResolvedValue(snapshot(null));
});

describe('immutable escrow delivery evidence', () => {
  it('persists the canonical NFC summary and trimmed URL under its actual hash', async () => {
    const raw = { summary: '  Cafe\u0301 delivered  ', url: '  https://example.org/cafe\u0301  ' };
    const hash = hashEscrowEvidence(raw);
    await saveEscrowEvidence(payload({ evidence: raw, evidenceHash: hash }));
    expect(mocks.set).toHaveBeenCalledWith({ path: `proposals/proposal/deliveryEvidence/${hash}` }, {
      summary: 'Café delivered', url: 'https://example.org/cafe\u0301', ownerId, createdAt: 'server-time',
    });
  });
  it('refuses a mismatched digest and an unconnected author before any write', async () => {
    await expect(saveEscrowEvidence(payload({ evidenceHash: `0x${'0'.repeat(64)}` }))).rejects.toThrow(/delivery hash/);
    mocks.auth.currentUser = { uid: `0x${'b'.repeat(40)}` };
    await expect(saveEscrowEvidence(payload())).rejects.toThrow(/owner's wallet/);
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it.each([
    { summary: 'x', url: evidence.url }, { summary: 'x'.repeat(4001), url: evidence.url },
    { summary: evidence.summary, url: '' }, { summary: evidence.summary, url: 'http://example.org' },
    { summary: evidence.summary, url: `https://example.org/${'x'.repeat(2048)}` },
  ])('rejects invalid readable evidence', async invalid => {
    await expect(saveEscrowEvidence(payload({ evidence: invalid }))).rejects.toThrow();
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it('treats a denied duplicate create as idempotent only if the immutable contents match', async () => {
    const denied = new Error('permission-denied');
    mocks.set.mockRejectedValue(denied);
    mocks.get.mockResolvedValue(snapshot({ ...evidence, ownerId, createdAt: 'original-time' }));
    await expect(saveEscrowEvidence(payload())).resolves.toEqual({ ...evidence, ownerId });
    expect(mocks.set).toHaveBeenCalledTimes(1);
    mocks.get.mockResolvedValue(snapshot({ ...evidence, summary: 'Different result', ownerId }));
    await expect(saveEscrowEvidence(payload())).rejects.toBe(denied);
  });
  it('loads only evidence whose content matches its on-chain digest', async () => {
    const hash = hashEscrowEvidence(evidence);
    mocks.get.mockResolvedValue(snapshot({ ...evidence, ownerId, createdAt: 'original-time' }));
    await expect(loadEscrowEvidence('proposal', hash)).resolves.toEqual({ ...evidence, ownerId, createdAt: 'original-time' });
    mocks.get.mockResolvedValue(snapshot({ ...evidence, url: 'https://example.org/changed', ownerId }));
    await expect(loadEscrowEvidence('proposal', hash)).rejects.toThrow(/on-chain hash/);
    mocks.get.mockResolvedValue(snapshot({ ...evidence, summary: ` ${evidence.summary}`, ownerId }));
    await expect(loadEscrowEvidence('proposal', hash)).rejects.toThrow(/on-chain hash/);
  });
  it('returns no evidence for a missing record and rejects invalid references', async () => {
    await expect(loadEscrowEvidence('proposal', hashEscrowEvidence(evidence))).resolves.toBeNull();
    await expect(loadEscrowEvidence('../other', hashEscrowEvidence(evidence))).rejects.toThrow(/reference/);
  });
});
