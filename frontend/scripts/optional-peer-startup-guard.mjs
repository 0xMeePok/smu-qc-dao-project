const OPTIONAL_PEER_PREFIX = "__vite-optional-peer-dep:";

/** Missing optional peers may reject a lazy import, but must not abort startup. */
export function optionalPeerStartupGuard() {
  return {
    name: "qcdao-optional-peer-startup-guard",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const entry of Object.values(bundle)) {
        if (entry.type !== "chunk" || !entry.isEntry) continue;
        const visited = new Set();
        const pending = [entry.fileName];
        while (pending.length) {
          const fileName = pending.pop();
          if (visited.has(fileName)) continue;
          visited.add(fileName);
          const chunk = bundle[fileName];
          if (!chunk || chunk.type !== "chunk") continue;
          if (Object.keys(chunk.modules).some(id =>
            id.replace(/^\0+/, "").startsWith(OPTIONAL_PEER_PREFIX))) {
            this.error(`An optional peer dependency stub is eagerly loaded by entry "${entry.fileName}" through "${fileName}". Keep missing optional peers behind dynamic imports instead of placing them in startup chunks.`);
          }
          // Dynamic imports are intentionally excluded: their caller can catch
          // the missing peer without preventing the application from loading.
          pending.push(...chunk.imports);
        }
      }
    },
  };
}
