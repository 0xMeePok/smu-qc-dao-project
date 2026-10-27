# Google Cloud

Every Firebase project is also a Google Cloud project with the same id. Firebase covers most of the setup. You need the Google Cloud console and the `gcloud` CLI for billing, APIs, IAM, secrets, logs and the Storage bucket settings.

## Joining the existing project

Your Firebase role gives you access to project `qcdao-a0c7a` in the [Google Cloud console](https://console.cloud.google.com). Install the CLI and point it at the project:

```bash
# macOS. Other systems: https://cloud.google.com/sdk/docs/install
brew install --cask google-cloud-sdk
gcloud auth login
gcloud config set project qcdao-a0c7a
```

Admin scripts such as `reset-dev-data.mjs` use Application Default Credentials. Set them up once, and give them a quota project:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project qcdao-a0c7a
```

Skip the second command and Firestore and Storage still work, but every Firebase Auth call fails with a message that ends in `adc-troubleshooting/user-creds`. The Auth API refuses user credentials that have no quota project. The credentials file grants your full access to any local script, so remove it with `gcloud auth application-default revoke` when you no longer need it.

## Billing and budget

1. Link a billing account (the Blaze upgrade does this).
2. Under **Billing**, **Budgets & alerts**, create a monthly budget with email alerts. A small amount is enough for a testnet demo.
3. Check the budget owner when the project changes hands. Alerts go to billing administrators.

## APIs

The first functions deploy offers to enable the APIs it needs. To enable them up front:

```bash
gcloud services enable \
  cloudfunctions.googleapis.com run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com eventarc.googleapis.com cloudscheduler.googleapis.com \
  secretmanager.googleapis.com iamcredentials.googleapis.com \
  recaptchaenterprise.googleapis.com firebaseappcheck.googleapis.com \
  --project <project-id>
```

| API | Why |
| --- | --- |
| Cloud Functions, Cloud Run, Cloud Build, Artifact Registry | Build and run second-generation functions |
| Eventarc | Deliver Firestore events to the 17 triggered functions |
| Cloud Scheduler | Run the seven scheduled functions. A deploy with scheduled functions fails without it |
| Secret Manager | `PRIVY_SECRET` and `ESCROW_PLATFORM_PRIVATE_KEY` |
| IAM Service Account Credentials | Lets the Admin SDK sign custom tokens without a key file |
| reCAPTCHA Enterprise, Firebase App Check | App Check for the web app |

## Storage bucket settings

Run once per project from `firebase/`, after the bucket exists:

```bash
# Browsers call the bucket cross-origin for uploads and getBlob() downloads
gcloud storage buckets update gs://<project-id>.firebasestorage.app --cors-file=storage.cors.json

# Abort incomplete uploads after a day so cancelled uploads do not pile up
gcloud storage buckets update gs://<project-id>.firebasestorage.app --lifecycle-file=storage.lifecycle.json
```

`storage.cors.json` lists only the two production origins. Preview channel origins are added automatically by `npm run deploy:preview`, which is why that script needs `gcloud`.

## IAM

### Deploy account for GitHub Actions

GitHub Actions deploys with a service account key stored as the secret `FIREBASE_SERVICE_ACCOUNT_QCDAO_A0C7A`.

1. Under **IAM & Admin**, **Service accounts**, create an account, for example `github-deployer`.
2. Grant it the roles the current deploy account uses, listed in `firebase/README.md`:
   * Firebase Hosting Admin
   * Firebase Rules Admin
   * Cloud Functions Developer
   * Service Account User
   * Cloud Run Admin
   * Artifact Registry Writer
   * Cloud Build Editor
3. A full deploy also creates Firestore indexes, Cloud Scheduler jobs and secret bindings. If a fresh account fails on those, the error names the missing permission. Typical additions are Cloud Datastore Index Admin, Cloud Scheduler Admin and Secret Manager Viewer. Add the role and re-run the job.
4. Create a JSON key for the account, paste the whole file into the GitHub secret, then delete the file from your laptop.

If your organisation blocks service account keys, switch the workflow to Workload Identity Federation. That needs a change to `deploy.yml`.

### Runtime service account

Second-generation functions run as the default compute service account, `<project-number>-compute@developer.gserviceaccount.com`.

| It needs | Why | Normally granted by |
| --- | --- | --- |
| Secret Manager Secret Accessor on both secrets | Read `PRIVY_SECRET` and `ESCROW_PLATFORM_PRIVATE_KEY` | The Firebase CLI, when it deploys a function that binds the secret |
| `iam.serviceAccounts.signBlob` on itself (Service Account Token Creator) | Mint custom tokens in `exchangePrivySession` | Default grants. Add it if sign-in fails with a `signBlob` permission error |
| Firestore and Storage access | Read and write records and attachments | Default grants. If your organisation disables automatic grants to default service accounts, add Cloud Datastore User and Storage Object Admin |

### Public access to callable functions

Callable functions must accept requests from anyone on the internet. The functions check the caller themselves. The CLI sets this up. If calls return `403` after a deploy, grant invoker access to that service, for example:

```bash
gcloud run services add-iam-policy-binding exchangeprivysession \
  --region=asia-southeast1 --member=allUsers --role=roles/run.invoker
```

An organisation policy that blocks `allUsers` will stop the app from working. Use a project outside such an organisation, or ask its administrators for an exception.

## Logs and monitoring

| To see | Go to |
| --- | --- |
| Function logs and errors | Firebase console, **Functions**, **Logs**, or **Logs Explorer** in Google Cloud filtered by the function name |
| Scheduled jobs and their last run | **Cloud Scheduler** |
| Secret versions | **Security**, **Secret Manager** |
| App Check traffic | Firebase console, **App Check**, **APIs** |
| Platform health from the app | **Admin Audit**, **Service health** |

`adminGetPlatformStatus` powers the in-app health view. It checks the RPC, the registry, the audit queue and Firestore.
