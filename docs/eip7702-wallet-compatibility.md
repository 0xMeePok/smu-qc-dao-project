# EIP-7702 wallet compatibility (QCDAO-146)

Privy's sponsored transactions can install delegation code on the embedded
wallet without changing its address or signing key.

The current application signs in using a Privy access token. The server verifies
that token with Privy, fetches the linked embedded wallet, and binds the Firebase
session to that address. It does not request a SIWE signature or choose a
signature verifier based on account code. The older `verifySiweSignature` path
described in the story has already been removed.

The stablecoin faucet verifies its timestamped mint message using EIP-191 address
recovery (`ethers.verifyMessage`). Delegation does not change that recovery. Do
not replace it with an ERC-1271 check merely because the address has code. Other
smart-account signature schemes are outside this story's scope.

## Automated evidence

- `firebase/functions/test/privy-upgrade-session.test.mjs` runs the production
  session-exchange path with the Privy SDK boundary stubbed. It checks repeated
  sign-ins preserve identity, require token verification, and perform no wallet
  signing or chain lookup. Invalid tokens, substituted addresses, suspension,
  emulator-header bypass attempts and unavailable Privy users remain rejected.
- `contracts/stable-faucet/site/tests/eip7702.test.mjs` uses a real isolated Prague
  EVM with chain ID 421614. A separate account pays for an actual type-4
  authorization transaction. The test checks the member's delegation code,
  incremented nonce and zero ETH balance. The production faucet handler mints
  10,000 tokens before and after the upgrade into that same address. The delegate
  deliberately has no ERC-1271 implementation. Altered messages, another signer
  and expired requests are rejected without sending a transaction.

Run the backend tests with `npm test --prefix firebase/functions`. For the faucet,
install dependencies in both `contracts/stable-faucet` and its `site` directory,
then run `npm test --prefix contracts/stable-faucet/site`. The EVM suite compiles
the test token itself and needs no deployment keys, live RPC or `.env` file.
Existing CI runs the backend suite, including the new session regressions. Run
the faucet lint, type checks, unit/integration tests, build and contract tests
locally as described above; adding a dedicated faucet CI job is a release
follow-up requiring GitHub workflow-write permission.

These checks exercise real local EIP-7702 execution and signature recovery. They
do not exercise live Privy email OTP, its hosted signing dialog or its paymaster.
For a live deployment check, sign in, complete a sponsored transaction, sign out
and back in, and request a faucet claim from the same embedded wallet. Confirm
that the address and profile remain unchanged and the claim is confirmed.

## Existing testnet tokens

The faucet calls owner-only `faucetMint(recipient)` to create tokens directly. It
does not need a token inventory refill. The owner needs test ETH for gas; the API
retains a 0.005 ETH reserve. Each token permits 10,000 tokens per recipient per
hour, up to its configured supply cap. Redeploy only when the existing contract
or configuration actually needs replacement; funding escrow uses these token
addresses too.
