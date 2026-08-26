import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    "dist/**",
    "out/**",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
  },
]);

export default eslintConfig;
