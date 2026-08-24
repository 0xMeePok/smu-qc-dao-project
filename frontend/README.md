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

18 tests over `src/lib/validation.js` — field rules, the default role assigned at
account creation, and the whole-form validator. No emulator or network needed.

## Build

```bash
npm run build
```

## Source layout

```
src/
├── lib/            # Firebase/wagmi setup, validation, SIWE client calls, roles, stats
├── context/         # SessionContext — the wallet -> verified -> onboarding/signed-in state machine
├── components/      # Modal shell, connector picker, onboarding form, sign-in button
├── pages/            # RoleSelection (the one place a role is actually chosen and saved)
├── App.jsx            # Hash router, marketplace pages, top bar
└── main.jsx             # WagmiProvider -> QueryClientProvider -> SessionProvider -> App
```
