# Due sandbox on/off-ramp

**Add funds** on the account menu and on the escrow panel calls Due's sandbox. The browser never sees the API key and never calls Due itself. The `dueSandbox` Cloud Function does.

Every Due request is locked to `https://api.sandbox.due.network`. There is no setting that points it at `https://api.due.network`. A key whose value contains `live` is a production key. Do not use it. A sandbox key comes from [app.sandbox.due.network](https://app.sandbox.due.network), or from [demo@due.network](mailto:demo@due.network) if that workspace has no API key section.

## Where the key goes

`dueSandbox` reads `process.env.DUE_API_KEY`. It does not read Firebase Secret Manager, so `firebase functions:secrets:set DUE_API_KEY` has no effect on this function. Versions already stored there can be left in place. They are not mounted.

| Place | Put the sandbox key here? |
| --- | --- |
| `firebase/functions/.env` | Yes, for the emulator and for a deploy from your laptop. Restart the emulators after saving |
| GitHub repository secret `DUE_API_KEY` | Yes, for a deploy from GitHub Actions. The backend job writes it into the generated `firebase/functions/.env` |
| `firebase/functions/.secret.local` | No. That file is for `PRIVY_SECRET` and the other Secret Manager values |
| `frontend/.env.local` or any `VITE_` name | No. Those values are shipped in the public site |
| Firebase Secret Manager | No. This function does not bind a secret |

`.env` is git-ignored. A laptop deploy uploads that file with the functions. A GitHub deploy replaces the file from the workflow, so the repository secret is what production receives. If the secret is missing, the rest of the deploy still runs and **Add funds** reports that the key is missing.

## What the screen does

The dialog offers **Buy USDC** and **Sell USDC**, then a currency and an amount. **Review quote** asks Due's sandbox for a quote. **Create sandbox transfer** creates the transfer there.

A buy shows the sandbox bank details Due returns. **Simulate sandbox pay-in** calls Due's sandbox-only `POST /dev/payin`. A sale shows the funding address Due returns. Due matches only its own sandbox USDC, sent from the linked wallet for the exact quoted amount. The QC DAO faucet token is a different token and is not credited.

The function creates a sandbox account for the signed-in email and links the embedded wallet. It stores the Due account id in `dueSandboxLinks/{wallet}`, which clients cannot read.

The deployed function uses the same two Due sandbox commands as the emulator. One approves sandbox KYC (`POST /dev/sumsub/applicants/{accountId}/approve`). The other marks a bank payment as received (`POST /dev/payin`) when a member chooses **Simulate sandbox pay-in**. Both are sent only to `https://api.sandbox.due.network`. They do not exist on Due's production host, and this function cannot call that host.
