# Sonora — Architecture Document
*(working name; a Git-native, remixable DAW platform)*

## 0. Core Product Principle (drives every decision below)

> The fundamental unit is the **Project**, not the song.

A "song" is just the rendered output of a Project at a given commit. Everything — the database schema, the file format, the URL structure, the UI — treats the Project as a living, versioned, forkable graph of musical source material. The MP3 is a build artifact, not the product. This is the same mental shift as "a compiled binary is not the codebase."

This principle rules out several tempting shortcuts:
- We cannot store "a project" as an opaque blob (e.g. a zipped Ableton file) — we need semantic access to tracks/clips/notes so we can diff, merge, and render UI without opening a DAW.
- We cannot treat versioning as an afterthought bolted onto a `projects` table — it has to be a first-class content-addressed graph, like Git.
- We cannot treat collaboration as a "nice to have" real-time layer — the data model has to be CRDT-friendly from day one, even if we ship single-user editing first.

---

## 1. Product Architecture

### 1.1 The three product surfaces
1. **DAW (creation surface)** — Arrangement, Piano Roll, Mixer, Browser. This is the "GitHub Desktop / VS Code" of the product: where work happens locally-first, saved to a project.
2. **Social/Discovery surface** — profiles, feeds, project pages, remix trees, licensing. This is the "GitHub.com" of the product.
3. **Collaboration layer** — presence, cursors, comments, live editing. Cross-cuts both surfaces.

### 1.2 The Project Graph (the "Git" analogy, made precise)

| Git concept | Sonora concept |
|---|---|
| Repository | Project |
| Blob (content-addressed file) | Asset (audio file, sample, preset — hashed, deduped) |
| Tree | Track/Clip manifest (`project.json`) |
| Commit | Version (snapshot of the manifest + metadata + parent pointer(s)) |
| Branch | Named mutable pointer to a Version, used for in-progress edits |
| Fork | New Project with `origin_project_id` + `origin_version_id`, independent history from that point |
| Merge | Track/clip-level 3-way merge where changes don't collide (see §5.4) |
| `git log` | Version History panel |
| `git blame` | Contribution/credit attribution per track/clip |
| Git remotes | Cloud sync (project always has a canonical cloud copy) |

Key distinction from Git: Git diffs text lines. We diff **structured musical objects** (a clip's notes, a track's mixer settings, an automation curve). So instead of a generic text-diff/merge, each object type gets a typed diff/merge strategy (§5).

---

## 2. Technical Architecture

### 2.1 High-level system diagram (described)

```
┌─────────────────────────────┐
│  Web App (Next.js/React)    │
│  - DAW Shell (Canvas/WebGL) │◄──── local-first state (CRDT doc, IndexedDB)
│  - Audio Engine (Web Audio  │
│    + AudioWorklet + WASM)   │
└──────────┬───────────────────┘
           │ HTTPS (REST/GraphQL)  │ WebSocket (Yjs sync, presence)
           ▼                       ▼
┌─────────────────────┐   ┌──────────────────────┐
│  API Gateway         │   │  Realtime Service     │
│  (Fastify/NestJS)    │   │  (Yjs + y-websocket   │
│                      │   │   or Hocuspocus)      │
└─────┬────────┬───────┘   └──────────┬───────────┘
      │        │                      │
      ▼        ▼                      ▼
 ┌────────┐ ┌────────┐         ┌─────────────┐
 │Postgres│ │ Redis   │         │ Redis pubsub │
 │(source │ │(cache,  │         │ (presence/   │
 │ of truth│ │ jobs,   │         │  awareness)  │
 │ metadata)│ queues) │         └─────────────┘
 └────────┘ └────┬────┘
                  ▼
           ┌─────────────┐        ┌────────────────┐
           │ Worker fleet │◄──────►│ Object Storage  │
           │ (BullMQ):    │        │ (S3/R2):        │
           │ - waveform   │        │ - audio assets  │
           │ - render/mix │        │ - samples       │
           │ - transcode  │        │ - stems         │
           │ - stem sep   │        │ - exports       │
           │ - AI jobs    │        └────────┬────────┘
           └─────────────┘                  │
                                             ▼
                                        ┌─────────┐
                                        │  CDN    │
                                        └─────────┘
```

### 2.2 Why this shape

- **Local-first editing, cloud-canonical storage.** The DAW must feel instant (audio timing can't tolerate network round-trips). So the *editing* state lives in a CRDT document in-browser (and IndexedDB for offline), and syncs to the server asynchronously. This also gives us real-time collaboration "for free" later — Yjs docs are naturally multi-writer.
- **Separate Realtime Service from API Gateway.** Presence/CRDT sync is a different scaling problem (long-lived stateful WebSocket connections, in-memory doc state) than REST CRUD (stateless, horizontally scalable). Coupling them forces the whole API to scale like a WebSocket server. Rejected alternative: shoving everything into one Node monolith — works for MVP demo, breaks under real collaborative load.
- **Workers for anything CPU/time-heavy.** Audio rendering, waveform peak generation, transcoding, AI inference must never block a request thread. Rejected alternative: doing this synchronously in the API — fine for a hackathon, unacceptable once files are >5MB or renders take >2s.
- **Postgres as source of truth for metadata; object storage for bytes.** Never put binary audio in the DB. Postgres holds the *graph* (projects, versions, tracks, clips-as-references, users, social data) — the parts that need relational queries, joins, and transactions. Rejected alternative: MongoDB — the data is highly relational (lineage graphs, permissions, foreign keys everywhere), so document-store flexibility isn't worth losing joins/transactions.

---

## 3. Technology Stack

| Layer | Choice | Why | Rejected alternatives |
|---|---|---|---|
| Frontend framework | **Next.js 15 (App Router) + React + TypeScript** | SSR for social/discovery pages (SEO for public projects), same codebase can host the DAW as a heavy client-rendered route. Huge ecosystem, easy to hire for. | SvelteKit (smaller ecosystem for this scale of app); pure SPA (Vite) — loses SSR for public project pages which need to be crawlable/shareable |
| DAW rendering | **Canvas 2D (timeline/arrangement/piano roll) + React for chrome (panels, mixer controls)** | Timeline with hundreds of clips redraws far faster on Canvas than as DOM nodes. React handles the "app around the canvas." | Full WebGL (PixiJS) — reserved for Phase 2/3 if we need GPU-accelerated waveform rendering at scale; overkill for MVP | Full DOM-based timeline (like early web DAWs) — doesn't scale past ~50 clips smoothly |
| Audio engine | **Web Audio API graph + AudioWorklet for custom DSP + WASM for hot paths** | Native browser API, no plugin install, works everywhere. AudioWorklet runs off the main thread (real-time safe). WASM (via Rust) for sample-accurate scheduling, time-stretching, and future native-plugin-like DSP. | Native desktop engine (JUCE/C++) shipped via Electron — real, and likely a *Phase 3* addition for a desktop app with VST hosting, but wrong for an MVP that must be zero-install and web-first |
| MIDI | **Web MIDI API** for hardware I/O; internal MIDI represented as JSON note events (not raw MIDI bytes) so it's diffable | Native input support without native code; JSON is git-diffable | Raw MIDI file blobs as source of truth — not diffable/mergeable |
| State/CRDT | **Yjs** (Y.Doc, Y.Array, Y.Map) for the live-editing document; persisted via `y-indexeddb` (offline) and a custom Yjs-Postgres provider | Battle-tested CRDT, framework-agnostic, has existing WebSocket provider ecosystem (Hocuspocus). This is the single biggest lever for "collaboration can be added without a rewrite" — we build on Yjs from day 1, we just don't turn on multi-user broadcast until Phase 2. | Automerge (also viable, slightly less mature tooling/perf at the time of writing); OT (operational transform) — much harder to implement correctly, CRDTs are the modern default |
| Backend API | **Node.js + Fastify + TypeScript** (or NestJS if team wants more structure/DI) | Same language as frontend (share types/schema package), Fastify is fast and has a clean plugin model | Go/Rust backend — better raw perf, but slower iteration speed for an MVP and loses type-sharing with frontend. (Rust *is* used for the audio-critical WASM modules and, later, a native render-farm worker.) |
| Realtime transport | **WebSocket via Hocuspocus (Yjs server) + Redis adapter for pub/sub across instances** | Purpose-built for Yjs; handles awareness (presence/cursors) out of the box | Raw Socket.IO with hand-rolled CRDT sync — reinventing a solved problem |
| Database | **PostgreSQL** (with `pgvector` extension later for AI similarity search) | Relational integrity for the version graph, ACID transactions for social actions (fork counts, likes), mature | MongoDB (see §2.2) |
| ORM | **Prisma** | Type-safe, great migrations story, works well with a shared schema package | Drizzle (also good, lighter — reasonable alternative pick, slightly less mature relation API at time of writing) |
| Object storage | **S3-compatible (AWS S3 or Cloudflare R2)** | R2 preferred for MVP cost (no egress fees) — matters a lot when serving audio/CDN traffic | Self-hosted MinIO — fine for local dev (used in docker-compose), not for production day 1 |
| CDN | **Cloudflare** | Fronts both static assets and audio streaming; cheap, fast, works well paired with R2 | — |
| Cache/Queue | **Redis (BullMQ for jobs, pub/sub for presence)** | One piece of infra, two jobs, well-understood | RabbitMQ/SQS — valid, more moving parts than needed at MVP scale |
| Auth | **Auth.js (NextAuth) or Clerk** | OAuth (Google/GitHub/Discord — producers already have these) + email, session handling solved | Rolling custom JWT auth — unnecessary risk for MVP |
| Search | **Postgres full-text search (tsvector) at MVP** → **Meilisearch/Typesense at Phase 2** | Don't stand up a search cluster before you have enough content to search | Elasticsearch from day 1 — heavy ops burden for an MVP with a few hundred projects |
| Background workers | **BullMQ workers (Node) for orchestration; Rust/Python microservices for heavy DSP (stem separation, AI) invoked as jobs** | Node orchestrates, specialized languages do the CPU-heavy work | Doing stem separation in Node — wrong tool; Python (Demucs/Spleeter) or a hosted API is right |
| Infra | **Docker Compose for local dev; Kubernetes or Render/Fly.io for prod at MVP scale** | Fly.io/Render let you ship an MVP without a platform team; migrate to k8s when scale demands it | Full k8s from day 1 — premature operational overhead |

---

## 4. Project File / Data Model — "Project Source Format" (PSF)

### 4.1 Design goals
1. **Diffable & mergeable** — plain JSON manifests, not binary blobs, for anything structural.
2. **Content-addressed assets** — identical samples across projects are stored once (dedup), referenced by hash.
3. **Portable** — a `.sonora` package (a directory, or a zip of one) is enough for another user, or another tool, to reconstruct the project.
4. **Gracefully degrading** — missing plugins/samples shouldn't corrupt the project; they become "unresolved references" the UI can surface.
5. **Cloud-native by default, but exportable offline.**

### 4.2 On-disk / exportable layout

```
my-project.sonora/
├── project.json              # top-level manifest (see 4.3)
├── manifest.lock             # resolved asset hash → storage location map
├── tracks/
│   ├── track_01.json         # track metadata: name, color, type, mixer routing
│   ├── track_02.json
│   └── ...
├── clips/
│   ├── clip_0001.json        # MIDI clip: notes[], velocity, length, loop info
│   ├── clip_0002.json        # audio clip: {asset_ref, offset, gain, fades, warp}
│   └── ...
├── automation/
│   └── automation_0001.json  # parameter, points[], curve type, target
├── instruments/
│   └── instrument_0001.json  # plugin id/version, preset data, or "missing" stub
├── mixer.json                 # channel strips, sends, inserts, master chain
├── assets/                    # content-addressed, deduplicated
│   └── ab/cd/abcd1234....flac # sha256-prefixed dirs, like git objects
├── samples_manifest.json     # maps human names -> asset hashes (for missing-sample UX)
├── presets/
│   └── preset_0001.json
├── stems/
│   └── stem_master_v3_drums.flac
├── thumbnails/
│   └── waveform_overview.png
└── versions/
    └── history.json          # local cache of version graph (canonical copy is server-side)
```

**Why a directory-of-JSON instead of one giant JSON file:** granular diffs. If Alex only edits `clip_0042.json`, we can diff/merge/sync just that file instead of a multi-MB monolith. This is directly analogous to why Git repos are many small files, not one file.

**Why content-addressed assets (`assets/ab/cd/abcd1234...`):** two projects using the same "808 Kick.wav" from a sample pack store it once; hash collision-checked, referenced by hash everywhere. Also gives us free integrity checking (hash mismatch = corrupted/tampered asset) and free CDN cache keys (immutable content → cache forever).

### 4.3 `project.json` (top-level manifest, abbreviated)

```json
{
  "schemaVersion": "1.0",
  "projectId": "proj_9k2j...",
  "title": "Summer Nights",
  "bpm": 124,
  "timeSignature": [4, 4],
  "keySignature": "A minor",
  "sampleRate": 48000,
  "createdAt": "2026-08-01T12:00:00Z",
  "origin": {
    "type": "remix",              // "original" | "fork" | "remix" | "edit" | "bootleg" | "alt_version"
    "parentProjectId": "proj_1a2b...",
    "parentVersionId": "ver_7f3d...",
    "license": "remix-with-attribution"
  },
  "tracks": ["tracks/track_01.json", "tracks/track_02.json"],
  "mixer": "mixer.json",
  "markers": [{ "time": 0, "label": "Intro" }],
  "tempoMap": [{ "beat": 0, "bpm": 124 }, { "beat": 128, "bpm": 128 }]
}
```

### 4.4 Versioning model (Version objects, server-side canonical)

A **Version** is immutable once created (like a Git commit):

```json
{
  "versionId": "ver_7f3d...",
  "projectId": "proj_1a2b...",
  "parentVersionIds": ["ver_5c1a..."],   // array → supports merge commits
  "authorId": "user_44...",
  "message": "Added dark bassline, reworked drop",
  "manifestSnapshot": "s3://.../manifest-ver_7f3d.json.gz",
  "diffSummary": { "tracksChanged": 2, "clipsAdded": 5, "clipsRemoved": 1 },
  "createdAt": "..."
}
```

Branches are just named pointers (`Branch { name, headVersionId }`) scoped to a project — used for a user's in-progress working state before they "publish" a new version, and later for parallel collaborative branches.

**Fork vs. Version vs. Remix — clarified:**
- A **Version** = a commit within the *same* project (same `projectId`), same ownership.
- A **Fork/Remix/Edit/Bootleg/Alt-Version** = a *new* `projectId` whose `origin` field points at a parent project+version. It has its own independent version history from that point forward. The distinction between "fork," "remix," "edit," "bootleg," "alt version" is purely a **label on `origin.type`** plus optional convention on naming (auto-suggested title: `"{parent title} — {user} {type}"`) — architecturally they're the identical operation (snapshot + copy-on-write + new project record). This keeps the system simple: one mechanism, many social meanings.

### 4.5 Asset deduplication & missing-sample handling
- Every asset reference is `{ hash, sizeBytes, mimeType, originalFilename, sourceLibrary? }`.
- On project open, client checks local cache → CDN → origin storage. If a hash 404s (e.g., a producer used a personal unlicensed sample not uploaded), the clip renders as a **"missing asset" placeholder**: greyed waveform, filename shown, a "Locate file" / "Search sample library for match" action. The project still loads and plays other tracks.
- Sample-pack assets get a `sourceLibrary` tag (e.g., `"splice:sp_1234"`) so we can show "This sample is from Splice pack X" instead of just "missing," and eventually deep-link to acquire it.

### 4.6 Compression & large files
- Audio assets stored as-is (FLAC/WAV) for quality; a compressed streaming proxy (Opus/AAC) is generated by a worker for in-browser playback/scrubbing to save bandwidth, while the lossless original remains the source of truth for export/render.
- Waveform peaks pre-computed by a worker and cached (`thumbnails/waveform_*.json` — min/max peak arrays), so the client never has to decode full audio just to draw a waveform.

### 4.7 Backwards compatibility
- `schemaVersion` field + a migration pipeline (like Rails/Prisma migrations) run on project load: `migrateProject(json, fromVersion, toVersion)`. Old clients simply refuse to open a manifest with `schemaVersion` newer than they understand, with a clear "please update" message, rather than corrupting data.

---

## 5. Remix / Attribution / Branching System

### 5.1 Lineage graph
Stored relationally, not just embedded in JSON, because we need to query it (family trees, "who forked what," trending remix chains):

```
projects(id, origin_project_id, origin_version_id, origin_type, ...)
```

This self-referencing FK is enough to walk the tree in either direction (ancestors via recursive CTE up `origin_project_id`, descendants via recursive CTE down). Rendered as a visual family tree (D3/React-Flow) on each project's page.

### 5.2 Automatic attribution
- Every project stores an immutable `credits[]` array, auto-populated by walking the ancestor chain at creation time: `[{ userId, projectId, role: "original_creator" | "remixer", title }]`.
- Rendered as a "Credits" section on every project page; cannot be edited/removed by downstream remixers (integrity guarantee — like a license notice).
- Per-track/clip contribution ("who contributed what") is tracked via `authorId` stamped on each Track/Clip object at creation time, so a merged project can show a per-track attribution badge.

### 5.3 Licensing model
`license` enum on each project: `no-remix | remix-allowed | remix-with-attribution | remix-commercial | cc-by | cc-by-sa | cc-by-nc`. The "Remix this project" button is disabled (with an explanation) if `no-remix`; otherwise forking auto-carries the license forward (a remix of a `cc-by-sa` project must itself be `cc-by-sa` — enforced server-side, same pattern as GitHub's copyleft-aware license nudges, though we don't try to be a legal authority — we display, we don't adjudicate).

### 5.4 Merge strategy (compatible-changes merging)
Full 3-way merge across arbitrary DAW edits is a genuinely hard problem — we scope it deliberately:

- **Track-level merge (MVP-plus):** if Branch A added new tracks and Branch B added different new tracks (no shared track IDs touched), auto-merge is trivial — union of tracks.
- **Clip-level merge (Phase 2):** if the same track had non-overlapping time-region edits, merge by timeline region.
- **Conflict (always deferred to human):** same clip, same track, overlapping edits → show a side-by-side "keep mine / keep theirs / keep both as separate takes" UI, exactly like a Git merge conflict resolution screen, but audio-aware (you can *listen* to both options before choosing).
- We explicitly do **not** attempt automatic note-level MIDI merging or automatic audio-content merging in MVP/Phase 2 — that's a research-grade problem. We ship the honest, useful 80%: structural (track/clip existence and non-overlapping edits) merging, human-in-the-loop for everything else.

---

## 6. Collaboration Architecture

- **Document model:** Each project's editable state (tracks, clips, automation — *not* large binary assets) is a Yjs `Y.Doc`. Binary assets are referenced by hash from within the doc, uploaded separately via signed URLs.
- **Sync path:** Client ⇄ Hocuspocus WebSocket server ⇄ Redis (cross-instance pub/sub) ⇄ periodic snapshot persisted to Postgres/S3 as the canonical Version when the user "publishes."
- **Why this doesn't require a rewrite to add multi-user later:** in MVP, each project simply has exactly one active editor and the Yjs doc is *only* synced to IndexedDB (offline persistence) and periodically flushed to the server as a Version — the WebSocket/Hocuspocus layer isn't even deployed yet. Turning on Phase-2 collaboration is "deploy the realtime service + point the existing Yjs doc's provider at it" — the data model doesn't change.
- **Presence/cursors:** Yjs Awareness protocol (built-in) broadcasts ephemeral state (cursor position, selected clip, user color) — never persisted, purely transient.
- **Track ownership & comments:** relational (Postgres), not part of the CRDT doc — ownership/comments are discrete events with their own lifecycle (notifications, mentions), better modeled as normal rows than CRDT state.
- **Conflict handling:** CRDTs make concurrent structural edits (add/remove/move clips) converge automatically without central locking. True "musical" conflicts (two people edited the same MIDI note simultaneously) resolve via last-write-wins at the field level by default, with the merge-review UI (§5.4) available for reviewing bigger divergences after the fact.

---

## 7. Plugin Compatibility System

Given the browser-first architecture, "plugins" in Sonora are primarily **built-in web instruments/effects** (synth engines, samplers, effect chains implemented in WASM/AudioWorklet) — this sidesteps most of the VST problem for MVP. But projects must still degrade gracefully when they reference something the current user/environment doesn't have (e.g., a Phase-3 native-bridge VST, or a premium instrument pack the user hasn't purchased):

**Detection:** each `instrument_*.json` declares `{ pluginId, pluginType: "native"|"web", version, presetData, isBuiltIn }`. On load, the client checks a local registry of available instruments.

**Graceful degradation flow:**
1. **Detect** — missing instrument flagged at load time, non-blocking.
2. **Show clearly** — track header gets a "⚠ Missing Instrument: Serum (VST)" badge instead of silently muting or crashing.
3. **Preserve settings** — the full `presetData` blob is retained untouched in the manifest even if unusable locally, so if the user later gets the plugin (or a compatible version), it's instantly usable again.
4. **Render/freeze fallback** — if the *original creator* included a frozen audio render (stem) of that track, the missing-plugin track auto-substitutes the frozen stem for playback (clearly marked "using frozen render — original instrument unavailable"), so the song still plays correctly.
5. **Encourage stems on publish** — when publishing a project that uses non-built-in instruments, we prompt: "Include rendered stems so others without this plugin can still hear your track" — a strong nudge, not a requirement.
6. **Suggest alternatives** — a maintained mapping table (`pluginAlternatives: { "serum": ["sonora-wavetable", "vital"] }`) suggests a built-in or common free equivalent, with one click to "swap instrument, keep MIDI notes."

This makes "missing plugin" a first-class, designed-for UI state rather than an edge case.

---

## 8. Database Schema (core tables, Postgres/Prisma-style)

```
users
  id, username, email, display_name, avatar_url, bio, created_at

projects
  id, owner_id -> users.id, title, slug, description, bpm, key_signature,
  visibility ENUM(private, unlisted, public),
  license ENUM(no_remix, remix_allowed, remix_attribution, remix_commercial, cc_by, cc_by_sa, cc_by_nc),
  origin_project_id -> projects.id (nullable),
  origin_version_id -> versions.id (nullable),
  origin_type ENUM(original, fork, remix, edit, bootleg, alt_version) NULL,
  head_version_id -> versions.id,
  cover_image_url, play_count, like_count, remix_count, created_at, updated_at

versions
  id, project_id -> projects.id, parent_version_ids UUID[], author_id -> users.id,
  message, manifest_url (S3 pointer to snapshot), diff_summary JSONB, created_at

branches
  id, project_id, name, head_version_id, created_by, created_at

tracks
  id, project_id, name, type ENUM(midi, audio, bus), color, order_index,
  author_id -> users.id, mixer_settings JSONB

clips
  id, track_id, type ENUM(midi, audio), start_beat, length_beats,
  content_ref (points to clip_XXXX.json or asset hash), author_id, created_at

assets
  hash (PK), size_bytes, mime_type, storage_url, original_filename,
  source_library, uploaded_by, created_at

instruments / presets
  id, project_id, plugin_id, plugin_type, version, preset_data JSONB, is_builtin BOOL

credits
  id, project_id, user_id, role ENUM(original_creator, remixer, collaborator), source_project_id

comments
  id, project_id, author_id, body, timestamp_in_project (nullable, for time-coded comments),
  parent_comment_id (threads), created_at

likes / follows / project_collaborators (permission-role table)
  standard join tables with role ENUM(owner, editor, viewer) for project_collaborators

notifications
  id, user_id, type, payload JSONB, read_at, created_at
```

Indexes worth calling out: partial index on `projects(visibility) WHERE visibility='public'` for feed queries; GIN index on a `tsvector` search column for MVP search; recursive-CTE-friendly index on `projects(origin_project_id)` for lineage tree queries.

---

## 9. API Structure (REST, versioned; GraphQL considered — see below)

**Why REST over GraphQL for MVP:** simpler caching (CDN-friendly GET endpoints for public project pages), simpler auth per-route, and the client data needs are well-known upfront rather than exploratory. GraphQL becomes attractive in Phase 2+ once the discovery feed needs flexible, client-driven queries (feed personalization, nested comment/like counts) — worth revisiting then, additively (a `/graphql` endpoint alongside REST, not a rewrite).

```
POST   /api/v1/auth/...                     (handled by Auth.js)

GET    /api/v1/projects/:id
POST   /api/v1/projects                     create new (blank) project
PATCH  /api/v1/projects/:id                 update metadata
POST   /api/v1/projects/:id/fork            → creates new project, origin set
POST   /api/v1/projects/:id/versions        publish a new version (snapshot)
GET    /api/v1/projects/:id/versions        version history
GET    /api/v1/projects/:id/versions/:vid/diff
POST   /api/v1/projects/:id/versions/:vid/restore
GET    /api/v1/projects/:id/lineage         family tree (ancestors + descendants)
GET    /api/v1/projects/:id/manifest        current manifest.json (signed asset URLs resolved)

POST   /api/v1/assets/upload-url            get a signed S3 PUT URL (dedup-checked by hash first)
GET    /api/v1/assets/:hash

POST   /api/v1/projects/:id/render          enqueue export job → 202 + job id
GET    /api/v1/jobs/:id                     poll job status

GET    /api/v1/feed?type=trending|new|following
GET    /api/v1/users/:username
GET    /api/v1/users/:username/projects

POST   /api/v1/projects/:id/comments
POST   /api/v1/projects/:id/like
POST   /api/v1/projects/:id/collaborators   (invite/permission mgmt)

WS     /realtime/:projectId                 (Hocuspocus, Phase 2)
```

All mutating endpoints require auth; project GETs check `visibility` + collaborator ACL.

---

## 10. Security Considerations

- **Signed, short-lived URLs** for all asset upload/download (never public-write buckets); download URLs for *private* projects are per-request signed and permission-checked server-side before signing.
- **Ownership & ACL checks at the service layer**, not just at the route — every project mutation re-verifies `owner_id` or `project_collaborators` role, defense in depth against IDOR.
- **Hash verification on upload** — client computes SHA-256 client-side, server re-verifies before accepting, preventing hash-spoofing/cache-poisoning of the content-addressed store.
- **Rate limiting** on fork/publish/render endpoints (Redis token bucket) — prevents render-farm abuse and spam-forking.
- **Sanitize all user-generated JSON** (project manifests, comments) — a malicious manifest must not be able to inject arbitrary code into another user's client (e.g., preset data is treated as data, never `eval`'d).
- **License enforcement is advisory, not DRM** — we're explicit with users that licensing controls social/platform behavior (attribution, remix button availability) but isn't a technical copy-protection guarantee, same posture as GitHub's license field.
- **CSP + sandboxed rendering** for any user-uploaded cover art/AI-generated content.

---

## 11. Storage Strategy Summary

| Data | Store | Notes |
|---|---|---|
| Relational/graph metadata | Postgres | source of truth |
| Live-editing doc | Yjs (client) → snapshotted to Postgres/S3 on publish | ephemeral until committed |
| Binary assets (audio/samples/stems) | S3/R2, content-addressed | deduped, immutable, CDN-fronted |
| Compressed streaming proxies | S3/R2, derived (regenerable) | can be purged/regenerated, not source of truth |
| Waveform peaks / thumbnails | S3/R2 or Postgres JSONB (small) | derived, cacheable |
| Search index | Postgres tsvector → Meilisearch (Phase 2) | derived from Postgres |
| Session/cache/queue | Redis | ephemeral |

---

## 12. MVP Feature Breakdown

**MVP goal:** a solo producer can sign up, make a short track in the browser DAW (MIDI + audio clips, a few built-in instruments, basic mixer), save it to the cloud, publish it publicly, and another user can open its public page, click "Remix," get an editable copy, modify it, and publish their own version — with automatic attribution and a visible version history. No real-time multi-user editing yet, no AI, no VST bridging.

- [x] Auth (email + 1 OAuth provider)
- [x] Project CRUD + cloud autosave (debounced, versioned as "checkpoints")
- [x] DAW: Arrangement view — tracks, audio clips, MIDI clips, timeline, zoom/snap/grid, markers, loop region
- [x] Piano Roll — note add/edit/delete/resize, velocity lane, basic quantize, scale highlighting
- [x] 2–3 built-in instruments (sampler, basic subtractive synth) + a small factory sample pack
- [x] Basic mixer — per-track volume/pan/mute/solo, master channel, basic peak meter
- [x] Manual "Publish version" (explicit commit, not full auto-versioning yet) with a message
- [x] Version history list + restore
- [x] Fork/Remix button → copies manifest, sets origin, opens editable copy
- [x] Public project page — playback (rendered preview), credits, lineage (parent link only, full tree in Phase 2), license selector, fork button, comments (basic)
- [x] Audio export (render to WAV/MP3, background job)
- [x] Missing-asset graceful placeholder (even in MVP, since forks will hit this immediately)

**Explicitly deferred out of MVP:** real-time multi-user, family-tree visualization, merge UI, AI features, plugin/VST bridging, mobile, search beyond basic title match, sample marketplace, tutorials.

### Phase 2
- Real-time collaboration (deploy Hocuspocus, presence, cursors, live comments/mentions)
- Visual project family tree (lineage graph UI)
- Track/clip-level auto-merge + conflict-resolution UI
- Full automation lanes + tempo/time-sig changes mid-project
- Discovery feed (trending, following, remix chains), profile pages, likes
- Meilisearch-backed search (projects, samples, users)
- Plugin-missing UX (badges, frozen-stem fallback, alternative suggestions)
- Stem export & stem-based collab (upload/replace individual stems)
- Notifications (mentions, forks-of-your-project, comments)

### Phase 3
- AI features: melody/drum/chord generation, stem separation, mixing/mastering suggestions, "explain this project," AI-assisted remix starting points
- Native desktop app (Tauri/Electron) with real VST/AU hosting bridge for pro users
- Sample pack marketplace + creator monetization
- Mobile companion (viewing/commenting, lightweight sketch-capture)
- Advanced merge (region-aware audio merge, take comparison/"listen to both")
- Collaborator marketplace ("projects looking for collaborators" discovery)

---

## 13. Development Roadmap (rough sequencing)

1. **Foundations:** monorepo scaffold, auth, Postgres schema + Prisma, S3/R2 bucket, project CRUD API, empty DAW shell page.
2. **Audio engine core:** Web Audio graph, transport (play/stop/loop), track scheduling, one built-in instrument.
3. **Arrangement UI:** Canvas timeline, track lanes, clip rendering, drag/resize/snap.
4. **Piano Roll:** note editing, velocity, quantize, MIDI recording via Web MIDI.
5. **Mixer:** channel strips wired to real Web Audio gain/pan nodes, metering.
6. **Project format + save/load:** manifest serialization, asset upload/dedup, version snapshot on publish.
7. **Fork/Remix + public project page + credits + license field.**
8. **Export/render worker + version history UI + restore.**
9. **Polish pass, missing-asset handling, empty states, onboarding.**
10. → Phase 2 kicks off with collaboration infra.

---

## 14. Wireframe-Level Screen Descriptions

**1. DAW Workspace (primary screen)**
- Top bar: project title (click to rename), Save/Publish button, BPM/time-sig, transport (play/stop/record/loop), zoom control, **prominent "Remix" indicator** if viewing someone else's project as a remix source, "Version History" icon.
- Left: **Browser panel** (tabs: Samples / Instruments / Presets / My Projects) — searchable, drag-out to timeline.
- Center: **Arrangement view** — vertical track lanes (name, color, mute/solo/record-arm on the left of each lane), horizontal timeline with clips, ruler with markers/loop-brace on top.
- Bottom (toggle): **Piano Roll** (opens full-width when a MIDI clip is double-clicked) — keyboard on left, note grid, velocity lane below, tool selector (draw/select/slice/mute) top-left, scale-highlight toggle top-right.
- Right (toggle): **Mixer** — vertical channel strips (one per track + master), fader/pan/mute/solo/insert slots/send knobs.
- Far right (toggle, Phase 2): **Collaboration panel** — presence avatars, comments thread, activity log.

**2. Public Project Page**
- Hero: title, cover art/waveform, owner avatar+name, play button (renders/streams the current head version).
- **Prominent "Remix this Project" button** (primary CTA, visually dominant — this is the single most important button on the page) next to a secondary "Open in DAW" (if owner/collaborator) or "Fork" button.
- Lineage strip: "Remix of [Summer Nights] by [Original Artist]" with click-through, small family-tree preview icon → expands to full tree view.
- Tabs: Overview (description, tracks used, license) / Version History / Comments / Remixes (children in the tree) / Credits.
- Sidebar: license badge, stats (plays, likes, remix count), collaborator avatars.

**3. Version History panel**
- Vertical commit list (message, author avatar, timestamp, diff summary badges "+3 clips / ~2 tracks"), current HEAD highlighted, click any entry → "Preview" (non-destructive) or "Restore."

**4. Family Tree view (Phase 2)**
- Node-graph (React Flow/D3), root = original project, each node = a project version thumbnail/title/author, edges labeled with origin_type (fork/remix/edit/bootleg), click a node to jump to that project page.

**5. Discovery Feed**
- Standard social feed cards: waveform thumbnail, title, artist, play-inline, like/comment/remix counts, "Remix" button visible directly on the card (not buried in a detail page) — remix is discoverable at every touchpoint, not just the detail page.

**6. Profile Page**
- Avatar/bio, tabs: Projects / Remixes / Samples / Presets / Tutorials, each as a grid of cards matching the feed card style.

---

## 15. Biggest Technical Risks & Mitigations

| Risk | Why it's hard | Mitigation |
|---|---|---|
| **Web Audio timing precision under load** (drift, glitches with many tracks/plugins) | Browser audio scheduling is not truly real-time; GC pauses/JS main-thread jank can cause dropouts | Use AudioWorklet (runs on the audio render thread, not main thread) for anything timing-critical; schedule audio events well ahead of playback time (lookahead scheduling pattern, not `setTimeout`-per-note); WASM for hot DSP loops; load-test with synthetic 50+ track projects early, not at the end |
| **CRDT doc size / performance at scale** (long project history, huge Yjs docs) | Yjs docs can grow unbounded with edit history if not managed | Periodic snapshot + garbage-collect old CRDT update history once a Version is published (published Version becomes the compacted baseline); keep large binary data *out* of the Yjs doc entirely (asset refs only) |
| **True musical merge is not fully solvable** | Two people editing overlapping MIDI/audio has no universally "correct" auto-merge | Deliberately scope automation to structural/non-overlapping cases (§5.4); make conflict resolution a good, fast, listen-and-choose UI rather than chasing full automerge |
| **Plugin/instrument fragmentation** | Different users have different capabilities (browser support, purchased instrument packs, eventually native VSTs) | Built-in-first instrument strategy sidesteps most of this for MVP/Phase 2; explicit degrade-gracefully design (§7) rather than assuming parity |
| **Storage cost growth** (lots of large lossless audio, many forks) | Naive "copy the whole project on fork" duplicates huge files fast | Content-addressed dedup (§4.2/4.5) means forking is cheap — only *new/changed* assets consume new storage; lossless masters kept once, streaming proxies regenerable/purgeable |
| **Abuse: rapid forking / storage or render-farm spam** | Fork is one click and cheap to call repeatedly | Rate limiting, per-user storage quotas, background job concurrency caps per user |
| **Real-time collab correctness under network partition** (offline edits reconciling later) | Classic distributed-systems problem | This is precisely what CRDTs solve well — Yjs updates commute and merge deterministically; still needs good UX for "you were offline, here's what changed" |
| **Licensing is a social contract, not enforceable DRM** | Users can always export audio and re-upload elsewhere | Be explicit about this scope with users (§10); focus platform value on the *structured project* experience (which is much harder to strip and pass off) rather than trying to DRM audio bytes |
| **Scope creep vs. shipping an MVP** | This spec is enormous | Ruthless MVP cut (§12) — ship single-user DAW + fork/remix + version history first; everything else is explicitly sequenced, not deferred by accident |

---

## 16. Why not just wrap an existing open-source DAW?

Briefly considered and rejected: projects like Tone.js-based web DAWs or embedding an existing native DAW exist, but none combine (a) a structured, diffable project format, (b) a relational lineage/versioning graph, and (c) CRDT-ready collaboration. Retrofitting those onto an existing DAW's internal data model would fight the tool the whole way; building the data model around Git-like versioning from the start is the entire differentiator, so it has to be native to our own schema, not bolted onto someone else's.
