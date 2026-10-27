---
name: privy
description: Use when building wallet infrastructure, authentication systems, or
  financial applications. Reach for Privy when you need to create embedded
  wallets, authenticate users, manage wallet controls and policies, execute
  transactions, or build treasury/agent/organization wallet systems.
metadata:
  mintlify-proj: privy
  version: "1.0"
---

# Privy Skill Reference

## Product summary

Privy is a programmable wallet infrastructure platform for building financial applications. It provides embedded wallets (non-custodial, user-controlled), authentication systems, transaction execution, policy controls, and financial flows (deposits, payouts, swaps, yield). Agents use Privy to create wallets for users, organizations, or autonomous systems; authenticate users via email, social, passkey, or wallet; execute transactions on 50+ blockchains; and enforce spending policies.

**Key files and concepts:**
- **App ID and App Secret**: Required for all API requests (found in Privy Dashboard > App settings > Basics)
- **Wallet ID**: Primary identifier for wallet operations (not the address)
- **Owner vs Signer**: Owners control wallets and policies; signers have scoped permissions
- **Policies**: Rules that constrain what actions wallets can perform
- **Authorization keys**: P256 cryptographic keys for server-side wallet control
- **Intents**: Asynchronous authorization flow for multi-party approval

**Primary docs:** https://docs.privy.io

## When to use

Reach for Privy when:
- Building user authentication flows (email, social, passkey, wallet-based)
- Creating embedded wallets for users, organizations, or agents
- Executing transactions on Ethereum, Solana, Bitcoin, Tempo, or 50+ other chains
- Implementing wallet controls, policies, or multi-sig approval workflows
- Building financial features (deposits, payouts, swaps, yield farming)
- Managing treasury operations or agent wallets with policy constraints
- Integrating external wallets (MetaMask, Phantom, etc.) into your app
- Handling server-side wallet automation or delegated signing

Do not use Privy for: non-financial applications, pure authentication without wallets, or systems that don't need blockchain interaction.

## Quick reference

### REST API authentication
All requests require Basic Auth and app ID header:
```bash
curl -u "app-id:app-secret" \
  -H "privy-app-id: app-id" \
  https://api.privy.io/v1/...
```

### SDK setup by platform

| Platform | Package | Key method |
|----------|---------|-----------|
| React | `@privy-io/react-auth` | `usePrivy()`, `useCreateWallet()` |
| React Native | `@privy-io/expo` | `useEmbeddedEthereumWallet()` |
| Node.js | `@privy-io/node` | `PrivyClient()` |
| Java | `io.privy:privy-java` | `PrivyClient.create()` |
| Go | `github.com/privy-io/privy-go` | `NewClient()` |
| Python | `privy-python` | `PrivyClient()` |
| REST | N/A | Direct HTTP requests |

### Common wallet operations

| Task | Method/Endpoint |
|------|-----------------|
| Create wallet | `POST /v1/wallets` or `createWallet()` hook |
| Get wallet | `GET /v1/wallets/{id}` or `usePrivy().user.embeddedEthereumWallets` |
| Send transaction | `eth_sendTransaction` (EVM) or `signAndSendTransaction` (Solana) |
| Sign message | `personal_sign` (EVM) or `signMessage()` (Solana) |
| Get balance | `GET /v1/wallets/{id}/balance` |
| List transactions | `GET /v1/wallets/{id}/transactions` |

### Wallet control models

| Model | Owner | Use case |
|-------|-------|----------|
| User-owned | User ID | Self-custodial consumer wallets |
| User + server | User ID + authorization key | Automated trading, limit orders |
| App-owned | Authorization key | Treasury, bots, agents |
| Custodial | Licensed custodian | FBO banking model |

### Policy enforcement

Policies are evaluated in secure enclaves and constrain:
- Transaction amounts (max transfer limits)
- Recipient addresses (approved destinations)
- Smart contract interactions (allowed contracts)
- Time windows (when actions are allowed)
- Asset types (which tokens can be moved)

## Decision guidance

### When to use embedded wallets vs external wallets

| Scenario | Embedded | External |
|----------|----------|----------|
| New users, onboarding | ✓ | |
| Users have existing wallets | | ✓ |
| Seamless UX priority | ✓ | |
| User brings their own assets | | ✓ |
| Non-custodial requirement | ✓ | ✓ |
| Mobile app | ✓ | |

### When to use Privy auth vs JWT-based auth

| Scenario | Privy auth | JWT-based |
|----------|-----------|-----------|
| No existing auth system | ✓ | |
| Already have Auth0/Firebase | | ✓ |
| Need social logins | ✓ | ✓ |
| Need passkey/biometric | ✓ | |
| Custom auth provider | | ✓ |

### When to use wallet actions vs intents vs RPC

| Use case | Wallet actions | Intents | RPC |
|----------|---|---|---|
| Transfers, swaps, earn | ✓ | | |
| Async multi-party approval | | ✓ | |
| Custom transaction flows | | | ✓ |
| Most use cases | ✓ | | |

## Workflow

### 1. Set up authentication
- Create app in Privy Dashboard
- Get app ID and app secret
- Choose auth method (Privy auth or JWT-based)
- Configure login methods (email, social, passkey, wallet)
- For JWT: register JWKS endpoint and user ID claim

### 2. Create or retrieve user
- Client-side: Use `usePrivy()` hook to authenticate
- Server-side: Call `POST /v1/users` or `GET /v1/users/{id}`
- Verify user access token if using JWT-based auth

### 3. Create wallet
- Client-side: Call `useCreateWallet()` hook
- Server-side: Call `POST /v1/wallets` with owner (user ID or authorization key)
- Specify chain type (ethereum, solana, etc.)
- Optionally attach policies or signers

### 4. Configure controls (if needed)
- Create authorization keys for server-side access
- Create policies to constrain wallet actions
- Add signers for delegated permissions
- Set up key quorums for multi-sig

### 5. Execute transactions
- Client-side: Use chain-specific signing methods
- Server-side: Sign request with authorization key, include `privy-authorization-signature` header
- Use wallet action APIs for common flows (transfer, swap, earn)
- Use RPC for custom transaction construction

### 6. Monitor and react
- Subscribe to webhooks for wallet events (funds_deposited, transaction.confirmed, etc.)
- Poll wallet state if webhooks unavailable
- Track wallet actions via action ID or external ID

## Common gotchas

- **HTTPS required**: Embedded wallets only work in secure contexts (https://). Localhost is treated as secure by browsers.
- **Wallet ID vs address**: Always use wallet ID for API calls, not the wallet address.
- **Policy evaluation timing**: Policies are evaluated at request time in secure enclaves; they cannot be changed retroactively.
- **Authorization signatures**: Server-side wallet operations require signing requests with authorization keys; include `privy-authorization-signature` header.
- **Idempotency keys**: Use idempotency keys to prevent duplicate wallet creation or transaction submission on retries.
- **Rate limits**: Privy enforces rate limits (HTTP 429); implement exponential backoff retry logic.
- **Wallet export**: Users can export private keys, providing an escape hatch. Plan for key rotation if needed.
- **Signers cannot modify policies**: Signers can only take actions; they cannot update wallet ownership or policies.
- **One policy per wallet**: Currently, only one policy can be enforced per wallet.
- **Chain-specific methods**: EVM and Solana have different signing methods; use the correct one for your chain.

## Verification checklist

Before submitting wallet or transaction work:

- [ ] Wallet created with correct owner (user ID, authorization key, or key quorum)
- [ ] Policies attached if needed (verify policy IDs are correct)
- [ ] Authorization signatures included for server-side requests
- [ ] Idempotency key used to prevent duplicates
- [ ] Correct chain type specified (ethereum, solana, etc.)
- [ ] Wallet has sufficient funds for transaction + gas
- [ ] Transaction recipient address is correct and approved by policy
- [ ] Webhooks subscribed for monitoring (or polling implemented)
- [ ] Error handling in place for rate limits and failures
- [ ] HTTPS used in production (not http://)
- [ ] App ID and app secret not exposed in client code

## Resources

**Comprehensive navigation:** https://docs.privy.io/llms.txt

**Critical documentation:**
1. [Key concepts](https://docs.privy.io/basics/key-concepts) — Understand authentication, wallets, and controls
2. [Wallet creation](https://docs.privy.io/wallets/wallets/create/create-a-wallet) — Create wallets for users, organizations, or servers
3. [API reference](https://docs.privy.io/api-reference/introduction) — REST API endpoints and authentication

---

> For additional documentation and navigation, see: https://docs.privy.io/llms.txt