// Shared ESLint flat config for the whole monorepo. ESLint v9 walks upward
// from each package's cwd looking for this file, so `apps/api`, `apps/web`,
// and `packages/schema` all pick it up automatically when their `lint`
// script runs `eslint src` — no per-package config duplication needed.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/*.d.ts"],
  },
  {
    rules: {
      // Kept intentionally lenient for MVP-stage code (see ARCHITECTURE.md
      // "prefer maintainability over cleverness" / "don't overbuild"):
      // flag genuinely unused code, don't fight `any` in early scaffolding.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
