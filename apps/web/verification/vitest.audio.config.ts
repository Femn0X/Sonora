import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("."),
  resolve: { alias: { "@sonora/schema": here("../../../packages/schema/src/index.ts") } },
  test: { include: ["audio-render.check.ts", "effects-render.check.ts", "effect-chain.check.ts", "engine-live.check.ts", "export-render.check.ts", "scheduler-worker.check.ts"], testTimeout: 60000 },
});
