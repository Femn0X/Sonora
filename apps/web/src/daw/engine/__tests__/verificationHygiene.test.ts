import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Guards a pitfall that cost real debugging time: with node-web-audio-api, the Float32Array from
 * `getChannelData()` does not keep its native memory alive, so a render helper that returns the bare view causes
 * flaky garbage values and segfaults. Rendered audio must be copied immediately (verification/helpers.ts: samples()).
 */
const dir = fileURLToPath(new URL("../../../../verification", import.meta.url));
const files = readdirSync(dir).filter((f) => /\.check\.tsx?$/.test(f));

describe("verification checks never hold a bare getChannelData() view", () => {
  it("found the check files to scan", () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of files) {
    it(file, () => {
      const src = readFileSync(join(dir, file), "utf8");
      // reading straight off a render result: (await ctx.startRendering()).getChannelData(0)
      expect(src, "use samples(await ctx.startRendering())").not.toMatch(/startRendering\(\)\s*\)\s*\.getChannelData/);
      // a helper that returns the view: `return buf.getChannelData(0)` / `=> b.getChannelData(c)`
      expect(src, "helpers must return a copy").not.toMatch(/\breturn\b[^;\n]*\.getChannelData\(/);
      expect(src, "arrow helpers must return a copy").not.toMatch(/=>\s*[\w.]+\.getChannelData\(/);
    });
  }
});
