/** Stable, type-preserving keys; unfamiliar or cyclic values are not cached. */
function keyFor(value) {
  const seen = new Set();
  const visit = (item) => {
    if (item === null) return ["null"];
    if (typeof item === "bigint") return ["bigint", item.toString()];
    if (["undefined", "boolean", "number", "string"].includes(typeof item)) return [typeof item, item];
    if (typeof item !== "object" || seen.has(item)) throw new TypeError("Uncacheable read arguments");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) throw new TypeError("Uncacheable read arguments");
    seen.add(item);
    try {
      return Array.isArray(item) ? ["array", item.map(visit)]
        : ["object", Object.keys(item).sort().map((key) => [key, visit(item[key])])];
    } finally { seen.delete(item); }
  };
  try { return JSON.stringify(visit(value)); }
  catch { return null; }
}

/**
 * Allocate inside one read-only request. Identical contract and block reads
 * share promises only when explicitly pinned to a block number. Head, latest,
 * receipt, transaction, and signing methods pass through unchanged. Rejected
 * reads are evicted so a later attempt can recover. Nothing survives a request.
 */
export function createRequestReadClient(client, { chainId = client?.chain?.id } = {}) {
  const reads = new Map(), abiIds = new WeakMap();
  let nextAbiId = 0;
  const share = (key, call) => {
    if (key === null) return call();
    if (reads.has(key)) return reads.get(key);
    const promise = Promise.resolve().then(call);
    reads.set(key, promise);
    promise.catch(() => { if (reads.get(key) === promise) reads.delete(key); });
    return promise;
  };
  const pinned = (request) => typeof request?.blockNumber === "bigint" && request.blockNumber >= 0n;
  const wrapped = {
    readContract: (request) => {
      if (!pinned(request) || !Array.isArray(request.abi)) return client.readContract(request);
      if (!abiIds.has(request.abi)) abiIds.set(request.abi, ++nextAbiId);
      const key = keyFor({ ...request, abi: abiIds.get(request.abi),
        args: request.args ?? [], chainId: request.chainId ?? chainId });
      return share(key === null ? null : `contract:${key}`, () => client.readContract(request));
    },
    getBlock: (request) => {
      const key = pinned(request) ? keyFor(request) : null;
      return share(key === null ? null : `block:${key}`, () => client.getBlock(request));
    },
    // Chain identity is constant for this request; chain checks still run once
    // and a failed check is retried, rather than becoming a global cache.
    getChainId: (...args) => {
      const key = keyFor(args);
      return share(key === null ? null : `chain:${key}`, () => client.getChainId(...args));
    },
  };
  return new Proxy(client, { get(target, property) {
    if (Object.hasOwn(wrapped, property)) return wrapped[property];
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
