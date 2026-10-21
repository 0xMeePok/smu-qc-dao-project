import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { publicPrivyEnvironment } from "./scripts/privy-build-config.mjs";

export default defineConfig({
  plugins: [publicPrivyEnvironment(), react()],
  resolve: {
    alias: [
      // Privy bundles a fiat on-ramp screen this app never shows, and Stripe's
      // default entry starts downloading Stripe.js the moment it is evaluated -
      // on every page view, from every visitor. The pure entry has the same API
      // and loads nothing until a payment is actually started.
      { find: /^@stripe\/crypto$/, replacement: "@stripe/crypto/pure" },
    ],
  },
  // Component tests need a DOM.
  test: {
    environment: "jsdom",
  },
  build: {
    // Builds into the Firebase project directory rather than frontend/dist.
    //
    // firebase.json lives in firebase/, and firebase-tools refuses a hosting
    // `public` path outside the directory holding it - "../frontend/dist is outside
    // of project directory". Pointing the build inward is the smaller change: the
    // alternative is moving firebase.json to the repo root, which would break the
    // emulator invocations, deploy.sh, and the test scripts that all resolve
    // relative to firebase/.
    outDir: "../firebase/public",
    // Required because outDir sits outside Vite's project root; without it Vite
    // refuses to clear the directory and stale assets accumulate between builds.
    emptyOutDir: true,
    // Pages load on navigation. Keep the vendor graph together so viem's CCIP
    // and signing helpers are already loaded before any wallet operation: an
    // open tab must not fetch a deleted helper chunk after a Hosting release.
    // LazyPage handles a stale *page* URL without automatically reloading an
    // open wallet session or discarding a draft.
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Optional peer dependencies Privy never loads in this app (Farcaster
          // mini-app wallets) resolve to Vite stubs outside node_modules. Kept
          // with the vendor graph so no dependency is ever fetched lazily.
          if (id.includes("/node_modules/") || id.startsWith("__vite-optional-peer-dep:")) return "vendor";
          if (/\/src\/lib\/(escrow|independentEscrow)\.js$/.test(id)) return "wallet-actions";
        },
      },
    },
  },
});
