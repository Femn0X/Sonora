/**
 * Read samples out of an AudioBuffer SAFELY (this matters with node-web-audio-api, the Node implementation
 * these checks run on).
 *
 * In that addon, the Float32Array returned by `buffer.getChannelData()` is a view onto native memory that the
 * array does NOT keep alive. If you keep only the array (e.g. `return (await ctx.startRendering()).getChannelData(0)`)
 * the AudioBuffer and context can be garbage-collected, and later reads touch freed memory: stale or garbage values
 * (we saw 1e17), arrays whose contents change between reads, or a hard process crash (SIGSEGV).
 *
 * Measured on the failing scenario: holding the view crashed 34/40 runs; copying immediately crashed 0/40.
 * Browsers tie the view's lifetime to the buffer, so this is specific to the Node test harness, not Sonora's engine.
 *
 * ALWAYS copy right away, while the buffer is still referenced.
 */
export function samples(buffer: { getChannelData(channel: number): Float32Array }, channel = 0): Float32Array {
  return Float32Array.from(buffer.getChannelData(channel));
}
