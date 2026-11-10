# DAW sound engine, drum roll & piano roll

What exists now, why it's built that way, and what is deliberately not done yet.

## Sound

| Piece | File | Notes |
|---|---|---|
| Instrument contract | `engine/instruments/types.ts` | `trigger / allNotesOff / dispose`. Everything (built-ins, future WASM/native plugins) implements it. |
| **Sonora Synth** `sonora.synth` | `instruments/synth.ts` | 2 osc → lowpass (+envelope) → ADSR. Patch = plain JSON in `presetData`. Factory presets: Lead, Bass, Pad, Pluck. `presetData` is sanitized (it comes from forkable project JSON). |
| **Sonora Drums** `sonora.drums` | `instruments/drumKit.ts` | Fully synthesized (no sample files). 8 pads on General-MIDI pitches 36/37/38/39/42/45/46/49. Closed hat chokes open hat. |
| Registry | `instruments/registry.ts` | `pluginId → factory`, plus the "+ Track" templates. Unknown plugin ids stay silent but keep their preset data. |
| Voice tracking | `instruments/voiceTracker.ts` | Lets Stop silence notes already handed to the scheduler; voice cap per instrument. |

## Timing

`engine/transport.ts` is a lookahead scheduler (25 ms timer, 100 ms ahead) built on *segments*
`{audioTime, beat, bpm}`. A tempo change or loop wrap appends a segment — one mechanism keeps
scheduling, the playhead and beat→time conversion consistent. Windows are half-open and gap-free.

`engine/noteScheduling.ts` is the pure "which notes fire in [from, to)" function (supports
looped clips). Notes are scheduled window-by-window from the **live** manifest, so edits during
playback are heard immediately.

`AudioEngine.loadManifest` is called on every edit (including every mouse-move of a drag), so it
**diffs** instead of rebuilding: instruments are only recreated when their `pluginId`/`presetData`
change; mixer channels are created/removed per track.

Modes: song (with optional loop), and **pattern mode** (`playClip`) which loops a single clip alone.

## Editors

* **Drum roll** (`components/drum-roll`) — a 16th-step grid, one row per pad. It is a *view over a
  normal `MidiClip`*, not a separate format: a beat built here opens in the piano roll, diffs and
  merges like any MIDI, and survives forks. Drum clips default to a 1-bar looping pattern; stretch
  the clip in the arrangement and the pattern repeats.
* **Piano roll** (`components/piano-roll`) — create/move/resize/delete, velocity lane, quantize, scale highlight,
  audition, click-drag-to-length, drum names on drum tracks, and **multi-select editing**: shift-click, shift-drag
  marquee (ctrl+shift adds), group move/resize, ctrl+A/C/X/V/D, arrow-key nudge. The group logic is pure
  (`piano-roll/selection.ts`): a group move is clamped *as a whole* so chords keep their shape at the edges. Paste
  lands at the mouse position (clicking an empty cell would create a note). The clipboard is session-wide, so you can
  copy in one clip and paste in another.
* `ClipEditor` picks the right one (drum tracks → step sequencer, with a toggle to piano roll).
* Arrangement: ruler seek, double-click to create a clip, drag to move (also across tracks),
  stretch, Delete, mute/solo.

Every drag is one undo step (`beginGesture/endGesture` → one `BATCH`).

## Effects, mixer & plugins

* **Descriptors** (`engine/plugins/params.ts`) are the single source of truth for what a plugin exposes: a
  list of params (range, default, unit, linear/log, or enum). One list drives sanitizing untrusted
  `presetData`, factory defaults, and the generic editor UI. A future WASM/native plugin only has to publish
  a descriptor to get storage, undo, sanitizing and UI for free.
* **Effects** (`engine/effects/`): EQ, Compressor, Delay, Reverb, Distortion on a shared `BaseEffect`
  (click-free bypass crossfade, cleanup). Catalog/factory in `effects/registry.ts`.
* **Insert chains** (`effects/effectChain.ts`) sit on every channel and on the master. `sync()` diffs the
  project's insert list against the live graph: a knob drag calls `setParams` on the existing effect (no
  rebuild), bypass is a crossfade, and only add/remove/reorder rewires. Unknown plugins are skipped
  (audio passes through) but their settings stay in the project.
* **Mixer panel** (`components/mixer`): a strip per track + master, with instrument and insert editors.
  Every change is a command (undoable); a knob drag is one undo step (`GestureSlider`).
* Instruments update **in place** (`setPreset`) when their settings change, so dragging a synth knob during
  playback doesn't cut ringing notes.
* Reverb impulse and drum noise use a **seeded PRNG** (`plugins/random.ts`): the same project sounds the same
  everywhere. Don't reintroduce `Math.random()` into anything audible.
* The delay/reverb/distortion **tone filters are Butterworth** (`BUTTERWORTH_Q_DB`). The Web Audio default has
  a resonant peak above unity gain, which is audible as a bump and, inside the delay's feedback loop, made
  the loop gain exceed 1 so it ran away at high feedback.
* **Untrusted project data:** note/clip numbers, tempo, time signature, volume/pan and plugin settings are all
  validated before reaching Web Audio (which *throws* on non-finite values), and a failing note or window is
  skipped rather than stalling the scheduler.

## Export (bounce to WAV)

`engine/export.ts` runs the **same `AudioEngine`** on an `OfflineAudioContext` (`scheduleOffline` schedules the
whole song at once instead of using the transport), then `encodeWav` writes 16- or 24-bit PCM. What you export
is what you hear: instruments, effects, mute/solo, pan and the master limiter. Because every audible random
source is seeded, **rendering the same project twice is bit-identical** (pinned by a test).

Things that had to be true for offline rendering to be correct:
* The voice cap only counts voices that are *sounding*. Counting merely-scheduled voices made an offline render
  (which schedules everything up front) steal the early notes.
* `smooth()` sets parameters instantly at `currentTime === 0`; otherwise a 10 ms ramp from the default would
  partly fade the first note or leak a muted track.
* The tail is estimated from the longest instrument release, reverb decay and delay repeats (capped), and
  exports are limited to 30 minutes so a corrupt clip length can't allocate gigabytes.
* Tempo is constant in the engine (no tempo map yet), so exports are too.

## Scheduler heartbeat

The 25 ms tick comes from a tiny Web Worker (`engine/schedulerTimer.ts`), not `setInterval`, because browsers
throttle page timers in background tabs (~1/s), which starves the 100 ms lookahead. It falls back to
`setInterval` when there's no Worker, when creating one fails (strict CSP), or if the worker errors at runtime.
Verified: the real worker script, in a real thread, keeps its own clock while the main thread is blocked.
**Not verified in a real browser's background tab** — please check that once by hand (play, switch tabs, listen).

## Verification note: copy rendered samples

The audio checks in `apps/web/verification` render with `node-web-audio-api`, where the array from
`getChannelData()` does not keep its native memory alive. Holding only that array can read freed memory
(garbage values, changing contents, or a segfault), so every check copies samples immediately via
`verification/helpers.ts: samples()`. Long reverbs are verified by rendering (4 s and 8 s decays, and the
demo's 2.8 s reverb in the bit-identical bounce test); an earlier attempt to blame the convolver and cap
reverb decay in tests was a misdiagnosis and was removed. See `verification/README.md` for the measurements.

## Things worth knowing

* **Web Audio automation:** the synth/drums/voice-kill use only `setValueAtTime` + ramps. Chaining
  `setTargetAtTime` after other automation events was found to blow up held notes in at least one
  implementation; see the comments in `synth.ts`. Don't "simplify" it back.
* **Loop boundary:** the wrap check is `cursor <= end`, not `<`. Audio clocks are quantized, so a
  scheduling window can end *exactly* on the loop end; a strict `<` then never wraps again and
  playback runs past the loop until Stop. Found by running the real engine on a real clock and
  pinned by `transport.fuzz.test.ts` (quantized fake clock). The playhead also wraps arithmetically
  if the scheduler is late — that is display-only and must never be used to hide scheduling bugs;
  assert on the windows the scheduler actually emitted.
* **Pre-limiter headroom:** factory levels are tuned so the demo peaks ≈ −1.3 dBFS. A safety
  compressor sits on the master bus; it's a safety net, not a mastering limiter.

## Not done (next)

* Sends/returns and buses (the schema has `sends`; no UI or routing yet). Tempo-synced delay.
* Automation of parameters over time. Preset save/load/browse for effects and instruments.
* Reverb `decay` regenerates the impulse, so changing it can produce a brief artifact; a crossfaded dual-convolver would fix it.
* Real third-party plugin loading (WASM host / native bridge) — the descriptor/registry seam is ready, the loader is not.
* Audio clips / sample playback (needs the asset decode pipeline; `sonora.sampler` is inert until then).
* Piano roll: ghost notes (see other clips' notes), scale-aware snapping. Drum roll: per-step length, swing.
* Arrangement: multi-clip selection, copy/paste of clips between tracks, splitting clips.
* `DELETE_TRACK` is still not undoable. New tracks use the project's existing author id
  (no client-side user identity exists yet).
