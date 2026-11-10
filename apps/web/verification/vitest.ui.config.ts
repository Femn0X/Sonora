import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("."),
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@sonora/schema": here("../../../packages/schema/src/index.ts") } },
  test: { include: ["editors-ui.check.tsx", "mixer-ui.check.tsx", "export-ui.check.tsx", "selection-ui.check.tsx", "clip-duplicate-ui.check.tsx", "demo-banner-ui.check.tsx"], environment: "jsdom" },
});
