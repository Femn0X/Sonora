import { it, expect } from "vitest";
import { Transport } from "../transport";

// mulberry32: deterministic PRNG so any failure is reproducible from its seed
const rng = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

/**
 * Regression: a loop window ending EXACTLY on the loop end used to leave the cursor on `end`, so the
 * strict `cursor < end` wrap check never fired again and playback ran on past the loop forever.
 * Found with the real engine on a real clock; reproduced here with a quantized fake clock.
 */
it("loop never leaks past its end, whatever the (quantized) clock does between ticks", () => {
  const failures: string[] = [];
  for (let seed = 1; seed <= 400; seed++) {
    const r = rng(seed);
    const clock = { currentTime: 10 };
    const t = new Transport(clock);
    const bpm = [120, 240, 600, 1200, 140, 90][Math.floor(r() * 6)];
    t.setBpm(bpm);
    const end = 4 + Math.floor(r() * 28);
    t.setLoop(true, 0, end);
    const wins: [number, number][] = [];
    t.play(0, (f, to) => wins.push([f, to]));
    for (let i = 0; i < 200; i++) {
      // mostly ~25ms, sometimes a long stall (busy main thread)
      // Real audio clocks are QUANTIZED (render quanta / coarse timer resolution), so tick times land on a
      // grid and window boundaries can hit the loop end *exactly*. Random floats never do, which is why
      // an unquantized fuzz misses this class of bug.
      const steps = r() < 0.1 ? 20 + Math.floor(r() * 150) : 1 + Math.floor(r() * 3);
      clock.currentTime = Math.round((clock.currentTime + steps * 0.01) * 1000) / 1000;
      t.tick();
    }
    const bad = wins.find(([f, to]) => to > end + 1e-9 || f > end + 1e-9);
    if (bad) failures.push(`seed ${seed} bpm ${bpm} end ${end}: window ${bad[0].toFixed(3)}..${bad[1].toFixed(3)}`);
  }
  expect(failures).toEqual([]);
});
