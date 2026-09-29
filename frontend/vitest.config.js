import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["test/components/**/*.test.jsx", "test/a11y/**/*.test.jsx"],
    clearMocks: true,
    reporters: ["./test/reporters/vitest-lines.mjs"],
  },
});
