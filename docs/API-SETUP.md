# API setup and troubleshooting

```bash
pnpm db:up                                         # Start Postgres from docker-compose.yml
cd apps/api && cp .env.example .env               # then set DATABASE_URL to match docker-compose.yml
cd ../.. && pnpm db:migrate                       # create/upgrade tables
pnpm --filter @sonora/api db:seed                 # optional: creates the "demo" user (also created on demand in dev)
pnpm --filter @sonora/api dev                     # API on :4000
```

## Who is "the current user"?
Auth isn't built yet. A request with no `x-user-id` header acts as the built-in **demo user**, found by the username
`demo` (so a `demo` user you created by hand is reused, never duplicated). In development it is created on demand; in
production (`NODE_ENV=production`) it must already exist (`db:seed`). An `x-user-id` that isn't a real user gets a
clean `401`, not a database error. Every route resolves the user through `requireUser()` in
`src/services/currentUser.ts`. Always `await` it; there is deliberately no synchronous variant.

## Where are saved songs stored?
Each saved version's project data is a JSON file under `apps/api/.data/storage/` (override with `STORAGE_DIR`). The
database holds the rows (projects, versions, credits); the files hold the song contents. **Both must be kept
together.** Deleting `.data` makes existing projects fail to open with "The saved data for this version is missing";
resetting the database but keeping `.data` just leaves unused files. `.data/` is git-ignored.

Earlier builds kept these snapshots in server memory, so every API restart (including each `tsx watch` reload)
erased them. Projects created back then can't be recovered; create a new project.

## Common problems
| Symptom | Cause |
|---|---|
| Opening a song shows the demo and a red "Couldn't load this project" banner | read the message in the banner: missing snapshot, API not running, or the project id doesn't exist |
| `Foreign key constraint violated … ownerId/authorId` | something wrote a user id that isn't in `users`; use `requireUser(req)` |
| `Unknown user "…"` (401) | the `x-user-id` header isn't an existing user id |
| `Can't create the built-in demo user … email … already used` (409) | another account already has `demo@sonora.local`; change its email |
