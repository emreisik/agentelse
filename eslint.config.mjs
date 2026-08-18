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
    // apps/* are independent npm workspace packages (own tsconfig, own
    // lint setup if/when added) — never lint their source or build output
    // from the root, same reasoning as tsconfig.json's "apps" exclude.
    "apps/**",
  ]),
]);

export default eslintConfig;
