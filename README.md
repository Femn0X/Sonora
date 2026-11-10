# Sonora — a Git-native, remixable DAW platform

Read **[ARCHITECTURE.md](../ARCHITECTURE.md)** first — it covers product/technical
architecture, the project file format, versioning/remix model, collaboration
design, database schema, API structure, MVP scope, roadmap, wireframes, and
risk mitigations. Everything in this repo implements a slice of that document.

## What's implemented in this pass (MVP foundation)

- **`packages/schema`** — the Project Source Format (PSF): shared TypeScript
  types for the manifest (tracks, clips, MIDI notes, automation, mixer,
  instruments), plus structural diff/merge utilities. Used by web, api, and
  worker so there's exactly one definition of "what a project is."
- **`apps/api`** — Fastify + Prisma backend implementing:
  - Project CRUD (`routes/projects.ts`)
  - **Fork/remix/edit/bootleg/alt-version** (`services/lineage.ts` — the core
    differentiator logic: license enforcement, copy-on-write manifest fork,
    automatic multi-generation credit propagation, lineage graph queries)
  - Version publish/history/restore (`routes/versions.ts`)
  - Content-addressed asset upload with dedup (`routes/assets.ts`)
  - Prisma schema implementing the full relational model from ARCHITECTURE §8
- **`apps/web`** — Next.js DAW client implementing:
  - `daw/engine/transport.ts` — lookahead audio scheduler (the timing-critical
    core of any web DAW)
  - `daw/engine/mixerChannel.ts` + `audioEngine.ts` — Web Audio graph wiring,
    manifest → live audio graph
  - `daw/engine/instruments/sampler.ts` — first built-in instrument
  - `daw/components/arrangement/ArrangementView.tsx` — Canvas-rendered timeline
    with drag-to-move clips, snapping, playhead
  - `daw/components/RemixButton.tsx` — the platform's signature CTA
  - `daw/state/projectStore.ts` — Zustand store shaped to migrate cleanly to a
    Yjs CRDT doc in Phase 2 without a data-model rewrite

## Not yet implemented (intentionally — see ARCHITECTURE §12/§13)

Piano Roll UI, Mixer UI, Browser/asset drag-in, real audio asset
decode/playback pipeline, auth wiring, real S3 storage backend (currently an
in-memory stub in `apps/api/src/services/storage.ts`), public project pages,
family-tree visualization, and all of Phase 2/3 (real-time collab, AI, native
plugin bridge). These are next in the roadmap, in that order.

## Getting started (once dependencies are installed)

```bash
npm install
pnpm install
npm run db:up          # postgres, redis, minio
npm run db:migrate
npm run dev
```
