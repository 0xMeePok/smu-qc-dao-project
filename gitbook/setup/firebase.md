# Firebase

The live project is `qcdao-a0c7a`. Firestore and Cloud Functions run in `asia-southeast1`, and Storage uses the bucket `qcdao-a0c7a.firebasestorage.app`.

## Joining the existing project

1. Ask a project Owner to add you in the Firebase console under **Project settings**, **Users and permissions**. Owner, or Editor with Firebase Admin, is enough for deploys.
2. Copy the web app config from **Project settings**, **General**, **Your apps**. You need `apiKey`, `projectId`, `appId` and `storageBucket`. These values are public identifiers, not secrets.
3. Ask for the App Check site key and the Privy app id, which are also public.
4. Put them in `frontend/.env.local` as described in [Environment variables](../reference/environment-variables.md).
5. Run `npx firebase login` and copy `firebase/.firebaserc.example` to `firebase/.firebaserc` with the project id.

Never put the Privy app secret or any private key in a frontend env file.

## Standing up a fresh project

Follow these steps in order. The console labels are the ones in use in October 2026 and may move.

### 1. Create the project and enable billing

1. In the [Firebase console](https://console.firebase.google.com), create a project. Google Analytics is not needed.
2. Upgrade to the **Blaze** plan. Cloud Functions, Secret Manager and Cloud Scheduler need it.
3. Set a budget alert when prompted. The free allowances cover a demo, but a card is required.

### 2. Set up Authentication

1. Open **Authentication** and select **Get started**.
2. Under **Sign-in method**, enable **Anonymous**. The team's setup notes found this is what activates the Identity Toolkit API that `signInWithCustomToken` needs. Do not enable Email/Password: email login happens in Privy.

Sessions are minted by `exchangePrivySession` as custom tokens. Cloud Functions refuse any uid that is not a wallet address.

### 3. Create the Firestore database

Create the `(default)` database in **`asia-southeast1`**, in production mode. The location cannot be changed later and must match the functions region, which is set in two places: `REGION` in `firebase/functions/index.js` and `FUNCTIONS_REGION` in `frontend/src/lib/firebase.js`.

You can skip this step: `firebase/deploy.sh` creates the database in the right region, with delete protection, if none exists.

Do not create collections by hand. They appear on first write.

### 4. Create the Storage bucket

1. Open **Storage** and select **Get started**.
2. Choose production mode. Test mode makes the bucket world-writable for 30 days.
3. Note the bucket name, normally `<project-id>.firebasestorage.app`.
4. Apply CORS and the lifecycle rule with `gcloud`, as described in [Google Cloud](google-cloud.md#storage-bucket-settings).

### 5. Register the web app

1. Open **Project settings**, **General**, **Your apps** and add a **Web** app. Do not tick Firebase Hosting here.
2. Copy the config values into `frontend/.env.local` and, later, into the GitHub Actions secrets.

### 6. Set up App Check

The callable functions enforce App Check outside the emulator, so production sign-in fails without it.

1. In the Google Cloud console, open **reCAPTCHA** (shown under Security, or as **Fraud Defense**) and enable the API if asked.
2. Create a key of type **Web**. List the Hosting domains, `<project-id>.web.app` and `<project-id>.firebaseapp.com`, plus any custom domain. Do not add `localhost` to a production key. Leave **Use checkbox challenge** off, because App Check needs a score-based key.
3. In the Firebase console, open **App Check**, select the **Apps** tab and register the web app with the **reCAPTCHA Enterprise** provider and that site key. The default token lifetime of one hour is fine.
4. Put the site key in `VITE_FIREBASE_APP_CHECK_SITE_KEY` for builds.
5. Leave App Check enforcement for Cloud Storage off until you have confirmed tokens are being issued. Turning it on early makes every upload fail.

### 7. Point the repository at your project

These files name `qcdao-a0c7a` directly. Change them for a new project in the same pull request:

| File | Change |
| --- | --- |
| `firebase/firebase.json` | `storage.bucket`, and the functions endpoint `https://asia-southeast1-<project-id>.cloudfunctions.net` in the CSP `connect-src` |
| `firebase/storage.cors.json` | The two Hosting origins |
| `firebase/scripts/check-csp.mjs` | The expected functions endpoint |
| `firebase/scripts/preview-deploy.mjs` | `PROJECT` |
| `.github/workflows/deploy.yml` | `FIREBASE_PROJECT_ID` and the service account secret name |
| `firebase/functions/scripts/reset-dev-data.mjs` | `LIVE_PROJECT`, the only project a production reset may target |
| `firebase/functions/scripts/mock_data.mjs` | Default `PROJECT_ID`, or set `MOCK_PROJECT_ID` |
| `firebase/test/security-config.test.mjs` and other tests that assert the old id | Expected values |

### 8. Link the CLI

```bash
cd firebase
npx firebase login
cp .firebaserc.example .firebaserc   # then set "default" to your project id
```

### 9. Write the functions environment

Create `firebase/functions/.env.<project-id>` (git-ignored):

```bash
PRIVY_APP_ID=<public Privy app id, same as VITE_PRIVY_APP_ID>
ARBITRUM_SEPOLIA_RPC_URL=https://sepolia-rollup.arbitrum.io/rpc
ARBITRUM_SEPOLIA_RPC_BACKUP_URLS=https://arbitrum-sepolia-rpc.publicnode.com
ADMIN_BOOTSTRAP_EMAILS=you@example.com
```

CI writes its own `firebase/functions/.env` on every deploy from repository variables, so this file only matters for deploys from your laptop. The public Arbitrum RPC is the default because some free provider plans limit log queries to a few blocks, which breaks funding history.

### 10. Store the secrets

From `firebase/`, enter each value when prompted. Never pass a secret on the command line or commit it.

```bash
npx firebase functions:secrets:set PRIVY_SECRET --project <project-id>
npx firebase functions:secrets:set ESCROW_PLATFORM_PRIVATE_KEY --project <project-id>
```

* `PRIVY_SECRET` is the app secret from the Privy dashboard.
* `ESCROW_PLATFORM_PRIVATE_KEY` must belong to the platform signer recorded in the escrow factory. On the current contracts that is `0x1c608C148F64Fb9657bA4e5fB8992345277371C0`. Do not run two backends with the same signer at the same time, because their transaction outboxes cannot coordinate nonces. A second environment should get its own contracts and signer.

Redeploy the functions after creating or rotating a secret.

### 11. Deploy the backend

```bash
cd firebase
./deploy.sh --project <project-id>
npx firebase deploy --only storage --project <project-id>
```

`deploy.sh` installs dependencies, checks `PRIVY_APP_ID`, creates the database if needed, then deploys Firestore rules, indexes and functions. It does not deploy Storage rules, hence the second command. The first deploy asks to enable the Cloud Functions, Cloud Build, Artifact Registry, Eventarc and Cloud Scheduler APIs. Accept, and allow several minutes.

Later backend deploys can use one command:

```bash
npx firebase deploy --only firestore:rules,firestore:indexes,storage,functions --project <project-id>
```

### 12. Check the deploy

```bash
npx firebase functions:list --project <project-id>
```

All 93 functions should be listed in `asia-southeast1`. To check that sign-in is reachable:

```bash
curl -o /dev/null -w "%{http_code}\n" -X POST -H "Content-Type: application/json" \
  --data '{"data":{}}' https://asia-southeast1-<project-id>.cloudfunctions.net/exchangePrivySession
```

A `404` means the function is not deployed. Any other code means it exists. The request itself is refused on purpose, because curl has no App Check token or Privy token.

### 13. Deploy the web app

Normally GitHub Actions does this, see [GitHub Actions](github-actions.md). By hand:

```bash
VITE_FIREBASE_USE_EMULATORS=false npm run build --prefix frontend
cd firebase && npx firebase deploy --only hosting --project <project-id>
node scripts/check-csp.mjs https://<project-id>.web.app
```

The shell variable matters: it overrides `.env.local`, which is usually set for the emulators.

### 14. Create the first administrator

The wallet address does not exist until the person signs in, so the first administrator is granted by email:

1. Make sure their email is in `ADMIN_BOOTSTRAP_EMAILS` and the functions were deployed after you set it.
2. They sign in on the live site and complete onboarding.
3. `stampPrivyIdentity` sets their `role` to `1`. Only the first account holding that email is promoted.

Remove an email from the list before demoting that account, or the next sign-in promotes it again. Further administrators and evaluators are granted in **Admin Audit**, **Users & access**.

### 15. Turn on the attachment sweeper

`sweepAttachments` runs daily in dry-run mode. Read one run's logs, check the counts, then set `ATTACHMENT_SWEEP_ENABLED=true` in the functions environment and redeploy.

## Checks before you call it done

* Signing in by email on the live site opens onboarding, and a second sign-in returns the same profile.
* The browser console on the live site shows no CSP or App Check errors.
* An administrator can open **Admin Audit**, and **Service health** shows the RPC and registry as healthy.
* A test posting publishes, and its audit receipt shows **Verified match**.

More detail on each step, including troubleshooting, is in `docs/firebase-setup.md` and `firebase/README.md`.
