# @sonora/worker — not yet implemented

This directory is a placeholder for the background-job worker described in
`ARCHITECTURE.md` (§2/§12): rendering/export, waveform peak generation,
transcoding, and (later) AI jobs, run via BullMQ consumers separate from the
API's request/response path.

**There is currently no `package.json`, no dependencies, and no working code
here.** It is intentionally excluded from the pnpm workspace (the
`apps/*` glob in `pnpm-workspace.yaml` only picks up directories that
contain a `package.json`, so this one is simply skipped rather than erroring).

Do not add a `dev:worker` script back to the root `package.json` until this
package is actually implemented — see `ARCHITECTURE.md` §13 roadmap step 8
("Export/render worker") for when this is scheduled to be built.
