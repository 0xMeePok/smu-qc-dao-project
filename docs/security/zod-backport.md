# Maintained Zod collection-size backport

This repository maintains a local fix for GHSA-mrhx-c7xc-m3w5 while wallet and
contract tooling still require Zod 3 APIs. Package names, versions, lockfile
integrities and npm audit results remain truthful. Version-based alerts remain;
the executable patch verification is separate evidence of this mitigation.

The shared implementation and exact original/patched SHA-256 manifest live in
`firebase/functions/securityDependencies/`. That directory travels with Functions
so remote production installs and service startup enforce the same patch as CI.
`scripts/patch-zod-security.mjs` re-exports the implementation for repository tests.

## Installation and verification

Use Node 22.22.2 or newer in the Node 22 series and npm 10, matching CI. Normal
`npm ci` applies the patch in each installed package's `postinstall`. npm also
runs the linked audit-registry source package's hook without installing its
development toolchain. That hook defers only when its node_modules is absent
and the installing workspace lock explicitly links to it; the installing
workspace still patches and verifies every dependency it actually installed.
Standalone audit-registry installation and all execution guards remain mandatory. After an
installation using `--ignore-scripts`, explicitly run `npm run security:apply`
in that workspace before executing any application or tool code. Then run
`npm run security:verify`. Execution guards only verify; they never silently
repair missing or changed dependency files.

Discovery follows nested/scoped packages and in-repository workspace links,
deduplicates real paths, detects package aliases from metadata, and refuses
links outside the repository boundary. Every locked Zod copy must exist and
match its version. The explicit production mode permits absent development-only
copies, never missing production dependencies. Every discovered copy must match
an exact supported version and all patched file hashes; unknown versions fail.
Direct local links replacing Zod itself are not supported: their npm lock entries
lack a version and verification refuses them. The existing audit-registry workspace
link and its ordinary locked Zod dependency are supported.

The currently supported versions are 3.22.4, 3.25.76, 4.6.6 and 4.6.7. Modern
packages also export `zod/v3`, so their legacy implementation needs the backport
even though the modern root API already has the upstream fix. Modern v4 source
and runtime files are not changed in 4.6.6/4.6.7.

Package scripts, Vite/Hardhat config loading, Firebase predeploy checks and
Functions startup verify installed bytes. CI explicitly applies the patch after
its intentional Functions `--ignore-scripts` install. Direct arbitrary Node or
third-party executable invocations outside these supported entry points are not
protected by lifecycle hooks; invoke the verifier first when adding such a path.

## Security and compatibility boundary

Oversized constrained arrays and sets reject before traversing their elements;
the bundled older v4 also covers bounded maps. Exact-length and maximum-size
checks cover synchronous/asynchronous parsing, nested schemas, mini/core/source
exports and CJS/ESM/UMD surfaces. Valid legacy record/error APIs are preserved.
The bundled v4 tracks the particular cap issue, so `catch` removing that issue
allows refinements of its fallback value to run normally.

This follows the policy of upstream commit
[a0ebf970](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd).
It does not bound every unconstrained collection or arbitrary custom refinement.
As upstream does, an earlier non-size check may end the early gate, conditional
checks remain conditional, and raw Set/Map cardinality may reject a value whose
entries would later collapse through coercion. This is a locally maintained
adaptation, not an upstream-supported release or universal resource limit.

## Updating or removing the patch

Before updating any Zod dependency, compare all exported implementations against
the advisory fix and rerun the reproduction. Do not exempt a new version solely
because its root API is patched: inspect its `v3` compatibility export. Record
exact original and patched hashes, review semantic changes, and run
`node --test scripts/patch-zod-security.test.mjs scripts/dependency-discovery.test.mjs`
after installing frontend and Functions dependencies. Tests recover official
unpatched bytes in temporary fixtures, prove the trigger, then prove rejection
before element traversal and preservation of valid/catch workflows.

Also run the owning frontend, backend, rule and contract suites and local funding
integration. Keep attribution and the MIT license beside the implementation.
Remove the backport only after every reachable API has a compatible upstream fix
and clean installations/builds pass without it. Do not rename packages, fake
versions, ignore advisories or force incompatible major versions to obtain a
zero-alert report.
