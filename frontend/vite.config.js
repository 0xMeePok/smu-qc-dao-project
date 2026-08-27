import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
  },
});
