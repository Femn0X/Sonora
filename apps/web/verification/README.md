# DAW verification suites

Heavier checks that go beyond the normal unit tests (`pnpm test`). They are named
`*.check.*` so a plain `vitest run` does **not** pick them up — they need two
extra dev dependencies that the app itself doesn't use:

```bash
pnpm --filter @sonora/web add -D node-web-audio-api jsdom@24
pnpm --filter @sonora/web verify:audio   # real instrument code, rendered offline; asserts on the samples
pnpm --filter @sonora/web verify:ui      # drum roll / piano roll / arrangement driven with mouse events
```

**`audio-render.check.ts`** renders the synth, drum kit and the demo song through an
`OfflineAudioContext` (via `node-web-audio-api`) and asserts on the actual samples:
pitch is correct (Goertzel), kick is low / hat is high, closed-hat chokes open-hat,
every pad is audible and bounded, long held chords stay bounded (regression for an
envelope blow-up), and the full mix stays under 0 dBFS before the master limiter.

**`effects-render.check.ts`** renders real audio through every effect and measures it: EQ boost/cut at
the right frequencies, compressor narrowing dynamics, delay echo timing and energy decay, reverb decay and
determinism, distortion harmonics, bit-transparent bypass, and abusive/garbage parameters.

**`effect-chain.check.ts`** checks the insert-chain wiring on real audio: order matters, add/remove/reorder,
unavailable plugins pass audio through, and the demo song *with* its effects keeps headroom.

**`export-render.check.ts`** bounces the demo through the real engine on an `OfflineAudioContext` and checks the
file: right length, notes on the beat (including the very first one), mute/solo honoured from sample 0, effect
tails not chopped, **bit-identical across renders**, WAV size/contents, and hostile project data.

**`scheduler-worker.check.ts`** runs the real tick-worker script in a real thread and checks its cadence and that
its clock is independent of a busy main thread (it cannot reproduce a browser's background-tab throttling).

**`engine-live.check.ts`** runs the real `AudioEngine` on a headless real-time clock and
checks scheduling, pause/resume/stop, song loop, pattern mode, live edits during
playback, manifest diffing, and seek.

**`selection-ui.check.tsx`** drives piano-roll multi-select: shift-click, marquee (and ctrl+shift to add), group
move/resize clamped as a unit, copy/cut/paste (at the mouse, across clips), duplicate, arrow-key nudging, and that
every action is a single undo step with no phantom steps at the edges. **`clip-duplicate-ui.check.tsx`** covers Ctrl+D
on arrangement clips.

**`export-ui.check.tsx`** drives the Export button: download name, progress, double-click guard, inline errors,
unmounting mid-render.

**`mixer-ui.check.tsx`** drives the mixer panel: adding/bypassing/reordering/removing effects, knob drags as one
undo step (including releasing the mouse outside the slider), instrument editing, faders, master bus.

**`editors-ui.check.tsx`** drives the real React components in jsdom (canvas stubbed with a
no-op context so every draw path executes): step painting, note create/drag/resize,
gesture-grouped undo, clip create/move/stretch/delete, the editor header, and "+ Track".

### Known defect in the test environment: long reverbs

### Gotcha: always copy rendered samples (`helpers.ts`)

In `node-web-audio-api` (the Node library these checks render with), the `Float32Array` from
`buffer.getChannelData()` is a view onto native memory that **the array does not keep alive**. A helper that returns
only that array (e.g. `return (await ctx.startRendering()).getChannelData(0)`) lets the buffer and context be
garbage-collected, and later reads hit freed memory: stale or garbage values (we saw `1e17`), arrays whose contents
change between reads, or a hard crash (`SIGSEGV`). It shows up as flaky Reverb tests because that is where the
timing happens to bite; it is not a Reverb or ConvolverNode problem.

Measured on a 4-second-reverb render in plain Node (no test runner): holding the view crashed 34/40 runs; copying
immediately crashed 0/40. So use `samples(buffer, channel)` from `helpers.ts`, which copies right away, and never
return a bare `getChannelData()` view from a helper. Browsers tie the view's lifetime to the buffer, and Sonora's own
code (`encodeWav`, the engine) always uses the buffer while it is alive, so this is specific to these checks.

If a check here ever looks flaky or crashes, look for a retained view first. Do not paper over it with retries.

These verify behaviour by measurement and simulated input. They cannot tell you how
something *sounds* — that still needs ears.
