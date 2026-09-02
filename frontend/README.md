# QC DAO Frontend

Vite + React app. Sign-in is wallet-only (wagmi + a server-verified signature) — see
the root [README](../README.md) for how that works.

## Run locally

Firestore, Auth, and both Cloud Functions are already deployed — ask the project
owner for the `VITE_FIREBASE_*` values rather than setting up your own project.

```bash
cp .env.example .env.local
# paste in the values you were given
npm install
npm run dev
```

The app will not start Firebase without `VITE_FIREBASE_API_KEY`,
`VITE_FIREBASE_PROJECT_ID`, and `VITE_FIREBASE_APP_ID` — see `.env.example` for which
fields are required versus optional, and why.

## Tests

```bash
npm test
```

196 tests, no emulator or network needed. Covers field validation, the default role
assigned at account creation, the whole-form validator, route-permission resolution,
and the 15-minute idle session.

The deploy pipeline runs a narrower set — only the files it owns:

```bash
node --test test/validation.test.js test/routeAccess.test.js test/idleTimeout.test.js
```

If you add a test file that should block a deploy, add it to that list in
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml); it is not globbed.

## Build

```bash
npm run build
```
Preview the production build locally:

```bash
npm run preview
```

## Source layout

```
src/
├── lib/            # Firebase/wagmi setup, validation, SIWE client calls, roles, stats,
│                  #   profile.js (writes users/ + publicProfiles/ in one batch)
├── context/         # SessionContext — the wallet -> verified -> onboarding/signed-in state machine
├── components/      # Modal shell, connector picker, onboarding form, sign-in button
├── pages/            # AdminPage (only reachable when the signed-in profile has role == 1)
├── App.jsx            # Hash router, marketplace pages, top bar
└── main.jsx             # WagmiProvider -> QueryClientProvider -> SessionProvider -> App
```
