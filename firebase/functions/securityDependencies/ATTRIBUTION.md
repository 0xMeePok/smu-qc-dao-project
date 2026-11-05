# Local Zod security backport

This adaptation retains the Zod package's name, package version, public APIs, original source files, and MIT license. Zod's license is reproduced in `ZOD-LICENSE`; the upstream copyright notices remain in each package's original `LICENSE` file.

Upstream reference: Colin McDonnell and Zod contributors, [commit a0ebf970f2d752e5f58527cd2942ff48be4f46bd](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd), with reference implementation read from the official `zod@4.6.7` npm package. This is a local adaptation, not a released or upstream-supported Zod 3 fix.

The bundled older v4 implementation retains the upstream policy of considering only leading size checks before a potentially value-rewriting check. A conditional size check whose `when` returns false remains conditional. Explicit internal skipChecks/backward contexts bypass the size gate. On an oversize result the gate aborts before allocating/traversing the container; a module-private WeakMap ties each payload to the exact cap issue and prevents subsequent conditional checks from receiving unparsed raw data while that issue remains. Once catch removes that issue and substitutes a fallback value, stale tracking is cleared and fallback refinements run normally. The early v4 contained in 3.25.76 lacks newer upstream schema-error stamping APIs, so normal old-v4 check issue ownership is preserved.

Zod 3 already checks array/set size before element traversal, but marks oversized results dirty and continues traversal and effects. The adaptation returns the existing INVALID sentinel for oversized .max/.length arrays and .max/.size sets. Undersize behavior and valid inputs retain their existing behavior. Zod 3 Map has no maximum-size API and needs no bounded-Map adaptation.

## Integrity inputs

These exact official npm tarballs were read from npm's local content cache. Their SHA512 values match frontend/package-lock.json in the reviewed checkout:

- zod@3.25.76: sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==
- zod@3.22.4: sha512-iC+8Io04lddc+mVqQ9AZ7OQ2MrUKGN+oIQyq1vemgt46jwCwLfhq7/pwnBnNXXXZb8VTVLKwp9EDkx+ryxIWmg==

`candidate-review-hashes.json` records the review artifact SHA256 values. The runtime verifier's exact original/patched file fingerprints are separately held in zod-security-manifest.json.

## Repository integration and verification

`manage.mjs` discovers nested, scoped, aliased and in-repository linked package
copies and checks selected lockfiles before applying or verifying the exact
manifest. It accepts only the supported exact versions. In addition to the
original legacy versions, 4.6.6 and 4.6.7 have a v3-only backport: their modern v4
source/runtime files remain unchanged.

Normal package postinstall applies the patch. Package execution guards, tool
config loading, Firebase predeploy and synchronous Functions startup verify it.
CI explicitly applies it after installations using --ignore-scripts. See
`docs/security/zod-backport.md` for supported entry points and limitations.

Repository tests live in `scripts/patch-zod-security.test.mjs` and
`scripts/dependency-discovery.test.mjs`. They copy installed official packages
into temporary fixtures, recover hash-verified original bytes, reproduce the
unpatched trigger, and test the patched exports including transformed TypeScript
sources. This is runtime source verification, not upstream TypeScript typechecking.

Package versions and npm audit metadata are unchanged. Version-based warnings
remain visible. This is a local mitigation, not an upstream-supported Zod 3
release, a universal validation resource limit, or a zero-alert npm audit claim.

## Reviewed compatibility limits

The following behaviors intentionally match upstream 4.6.7 and are not widened in this backport: a non-size check ends the leading cap scan; coercing Set/Map caps are evaluated on raw container sizes before element transformations; and an explicit raw-input size-check `when` predicate controls whether the leading cap applies. These limits belong to upstream semantics.

The repository commits no extracted dependency fixtures. Tests recover their official originals from verified installed copies in temporary directories; source transforms occur only there.
