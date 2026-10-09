/** Read-only request cache. Never retain it across requests or transaction writes.
 * Access checks still run against the same snapshots; repeated parents and the
 * caller's profile need only one database round trip within a list response. */
export function createRequestDocumentReader() {
  const reads = new Map();
  const read = ref => {
    if (!reads.has(ref.path)) {
      const result = Promise.resolve().then(() => ref.get());
      reads.set(ref.path, result);
      result.catch(() => { if (reads.get(ref.path) === result) reads.delete(ref.path); });
    }
    return reads.get(ref.path);
  };
  read.prime = snapshots => {
    for (const snapshot of snapshots) {
      if (snapshot.ref?.path && !reads.has(snapshot.ref.path)) reads.set(snapshot.ref.path, Promise.resolve(snapshot));
    }
  };
  return read;
}
