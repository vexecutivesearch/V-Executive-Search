import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The Python worker is not part of the Next app; a couple of CommonJS JS
    // helper scripts there legitimately use require().
    "worker/**",
  ]),
  {
    rules: {
      // Advisory React rule — the app relies on effect-driven state sync in a
      // few components; keep it as guidance, not a build-blocking error.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
