/**
 * Small seeded PRNG (mulberry32). Anything audible that needs "randomness" (noise, impulse responses)
 * uses this instead of Math.random(), so the same project renders the same way every time, on every
 * machine. That matters for a collaboration tool: forks, remixes and bounces should sound identical.
 */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
