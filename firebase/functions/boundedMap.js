/** Preserve input order, stop scheduling after failure, and settle active work. */
export async function boundedMap(items, mapper, concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("A positive concurrency is required.");
  const results = new Array(items.length);
  let next = 0, failed = false, failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
