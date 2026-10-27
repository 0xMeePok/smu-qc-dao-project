# Troubleshooting

Find the symptom, then check the likely cause before changing anything. Several gates (Privy origins, App Check, CSP, rules, secrets) fail in similar-looking ways, so confirm which one is failing first.

## Local setup

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Cannot find module 'firebase-functions'` when starting emulators or tests | Functions dependencies not installed | `npm install --prefix firebase/functions` |
| A test suite fails to start with a port error | An emulator from another terminal is still running | `pkill -f "firebase.*emulators"` |
| "Email sign-in is not configured" | `VITE_PRIVY_APP_ID` missing | Add it to `frontend/.env.local` and restart `npm run dev` |
| "Firebase is not configured yet" | `VITE_FIREBASE_API_KEY`, `PROJECT_ID` or `APP_ID` missing | Add them to `frontend/.env.local` |
| "Sign-in is not configured" from the server | The functions cannot find `PRIVY_APP_ID` or `PRIVY_SECRET` | Emulator: add `PRIVY_SECRET` to `firebase/functions/.secret.local`. Deployed: see the deploy rows below |
| Attachments fail on `localhost` against the live project | The production bucket's CORS excludes localhost | Use the Storage emulator (`VITE_FIREBASE_USE_EMULATORS=true`). The app shows this message itself |
| A manual Hosting deploy talks to `127.0.0.1` | `npm run emulate` left an emulator build in `firebase/public` | Rebuild with `VITE_FIREBASE_USE_EMULATORS=false npm run build --prefix frontend` before deploying |

## Sign-in

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Privy's modal refuses to open or sign in on a site | The origin is not in Privy's allowed origins | Add the exact origin, with scheme and port, in the Privy dashboard |
| The modal offers "I have a passkey" | Passkey login is enabled in the dashboard | Turn passkeys off under **User management**, **Authentication** |
| Browser reports "blocked by CORS policy" on a function | Almost always a missing function: a 404 page has no CORS headers | Check `npx firebase functions:list`. Deploy functions. Check the region is `asia-southeast1` in both places |
| Every callable returns 401 | App Check token missing or rejected | Check `VITE_FIREBASE_APP_CHECK_SITE_KEY` in the build, the app's App Check registration, and that the key lists this domain |
| Callables return 403 | The function's Cloud Run service is not publicly invokable | Grant `roles/run.invoker` to `allUsers` on that service |
| Sign-in fails with a `signBlob` permission error in the logs | The runtime service account cannot sign custom tokens | Grant it Service Account Token Creator on itself and enable the IAM Service Account Credentials API |
| Email sign-in works but onboarding never opens | `exchangePrivySession` failed, so no Firebase session exists | Read the browser console and the function logs. The message names the failing step |
| "Your details were rejected by our security rules" | Rules not deployed, or older than the frontend | `npx firebase deploy --only firestore:rules` |
| "This account has more than one QC DAO wallet" | The Privy user has several embedded wallets | Resolve in the Privy dashboard. The server refuses to guess |
| "Too many sign-in attempts" | 30 attempts per minute from one source | Wait a minute |
| "Registry maintenance is in progress" | The registry cutover marker `maintenanceState/registryCutover` is active | Finish the cutover, then clear the marker as described in `docs/registry-cutover.md` |

## Transactions and funding

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| "QC DAO could not cover the network fee for this transaction" | Gas sponsorship is off, Arbitrum Sepolia is not a supported chain, or client transactions are not allowed | Check **Fee sponsorship** and that **Wallets**, **Advanced** shows TEE enabled |
| A transaction's outcome is unknown | The confirmation timed out | Use **Retry confirmation** or **Check transfer status**. These check the known hash and never send a second transaction |
| "The test-token faucet is temporarily unavailable" | The faucet API refused. Its Vercel logs say why: "The faucet is paused for replenishment" means the faucet wallet is low on ETH, and "Testnet fees are above the faucet safety limit" means fees spiked | Top up the faucet wallet, or try again later |
| "This wallet must wait before claiming this token again" | The one-hour cooldown per token | Wait, or claim a different token |
| Audit receipt shows **Unable to verify** | RPC unavailable | Retry later. This is not a mismatch |
| Audit receipt shows **Mismatch detected** | The stored record no longer matches its anchor | Investigate the record's revision trail and who changed it. Do not "fix" the hash |
| "This record belongs to an earlier AuditRegistry deployment and is read-only" | The record was anchored on a previous registry | It stays verifiable but cannot enter the current funding workflow. Create a new posting |
| Funding or selection buttons are disabled | Escrow not fully funded, a pending transaction, a moderation pause or an expired window | Read the escrow panel's status. Each state names its reason |

## Deploys

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Deploy job fails with `PERMISSION_DENIED` | The deploy service account lacks a role | Add the role named in the error and re-run the job |
| Functions deploy reports `Deadline Exceeded` | Cloud Run was still finishing | The workflow retries three times. Re-run the job if all fail |
| A scheduled function fails to deploy | Cloud Scheduler API disabled | `gcloud services enable cloudscheduler.googleapis.com` |
| "VITE_FIREBASE_APP_CHECK_SITE_KEY is required" | The GitHub secret is missing | Add the secret |
| "VITE_PRIVY_APP_ID is required" | The GitHub variable is missing | Add the variable |
| "Built bundle contains no Firebase project id" | `VITE_FIREBASE_*` secrets missing | Add them |
| "Privy server credentials cannot use the public VITE_ prefix" | A secret was given a `VITE_PRIVY_` name | Rename it and keep it out of the frontend |
| Live CSP check fails after deploy | The CDN has not caught up, or a needed origin is missing from `firebase.json` | The check retries. If it still fails, compare the header with `firebase.json` |
| An old open tab shows a page loading error after a release | Its page chunk was replaced | The app offers to save or copy your work, then refresh |

## Where to look

* Browser DevTools console and network tab, including the Privy wallet iframe.
* Function logs in the Firebase console or Logs Explorer.
* **Admin Audit**, **Service health** for RPC, registry and queue status.
* `docs/firebase-setup.md` and `firebase/README.md` for longer explanations.
