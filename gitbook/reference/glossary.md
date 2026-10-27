# Glossary

| Term | Meaning in QC DAO |
| --- | --- |
| Access level | The number in `users/{address}.role`: `0` member, `1` administrator, `2` evaluator. Only the server can change it |
| Anchor | A transaction that records a record's hash on the registry, so the off-chain record can be checked later |
| App Check | Firebase's way of proving a request comes from the real web app, here with reCAPTCHA Enterprise |
| Arbitrum Sepolia | The Ethereum Layer 2 testnet the contracts run on, chain id `421614` |
| Attestation | `attestPublication` checking a mined anchor before the record may be written |
| Audit receipt | The view of a record's anchor, which recomputes the hash and compares it with the chain |
| Basis point (BPS) | One hundredth of a percent. The 10 BPS fee is 0.1% |
| Business problem | A funded problem statement posted by a problem owner. Stored in `problems` with no `opportunityType`, or `business-problem` |
| Canonical JSON | The fixed way records are serialised before hashing: sorted keys, NFC strings, safe integers |
| Capability | What the frontend lets an account do: owner, researcher, funder, evaluator or admin. Derived from the access level |
| Custody lock | The rule that escrowed deposits stay in place until the posting expires or a refund opens |
| Dual approval | The problem owner and the researcher both approving a selection before the first payment |
| Embedded wallet | The EVM wallet Privy creates for each email. Its address is the account |
| Entity id | The hashed id a record has on the registry. Scheme 2 includes the actor's address |
| EIP-7702 | An Ethereum upgrade that lets an ordinary wallet run delegated code. Privy uses it for gas sponsorship without changing the address |
| ERC-4337 | The account-abstraction standard behind bundlers and paymasters, used for sponsored transactions |
| Escrow | The per-proposal contract that holds deposits and pays out in milestones |
| Evaluator recommendation | A comment by an evaluator with one outcome: Recommend, Recommend with revisions, or Do not recommend. Advisory only |
| Funding approach | A funder's expression of interest in an independent proposal, which the researcher accepts or declines |
| Grant pool | An open funding call's prefunded `OpenFundingPool` |
| Independent proposal | A researcher's listing not tied to any posting, shown under **Solutions** |
| Manifest | The JSON file naming the active contract addresses and ABIs |
| Member | A signed-in, onboarded, active account |
| Open funding call | A funder's call for proposals without a fixed problem. Stored in `problems` with `opportunityType: "open-funding"` |
| Platform signer | The backend wallet that sends settlement, cancellation and moderation transactions |
| Posting | A business problem or an open funding call |
| Preview channel | A temporary Firebase Hosting URL for testing a branch against the live backend |
| Problem owner | The member who posted a business problem or a funding call (`problems.ownerId`) |
| Projection | A server-maintained summary document, such as `opportunityMetrics` |
| Sponsored transaction | A member transaction whose gas Privy pays |
| TEE | Trusted execution environment. Where Privy holds embedded wallet keys |
| Tranche | One milestone payment. The app uses two: 50% upfront and 50% on completion |
| Workflow status | The shared set of labels from `workflowStatus.js`, shown by `StatusBadge` |
