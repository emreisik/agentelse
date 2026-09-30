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
  // Guided setup is a dialog full of ARIA state (aria-pressed rows, labelled
  // groups, alerts): eslint-config-next only warns on these rules, and a warning
  // never fails CI, so a wrong attribute would ship. Errors here.
  {
    files: [
      "src/components/guide/**",
      "src/components/commands/guided-setup-card.tsx",
    ],
    rules: {
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
    },
  },
]);

export default eslintConfig;
