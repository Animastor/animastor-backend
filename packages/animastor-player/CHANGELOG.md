# Changelog

## 0.1.2 (2026-10-26)

Stage 143a phase 2a — versioned-pointer readers in the IU-media contour
(B0 / N3 / N4): with `IU_IMAGE_VERSIONED` on, the published pointer is the
authority; with the flag off every path is byte-identical and issues zero
new PG calls.

### Changed

- `GET /iu-image` — the route answers from the three-way verdict of
  `resolveIuImagePath`: ok → serve the versioned file (200 + ETag), absent
  → the legacy fallback exactly as before, missing (row present, target
  unsafe/absent) → **404 + log** (a broken publication can never be masked
  by stale legacy bytes), pointer-store outage → **503 + log**.
- `/chunk/:id` (N3) — auto-redispatch fires only when NEITHER the legacy
  scan NOR a live pointer proves the image; a pointer-store outage blocks
  the repair instead of silently re-dispatching.
- `image_ready` (N4) — the ready verdict accounts for the published
  pointer and never reports READY on a pointer-store outage.

### API

- No breaking changes: consumers reach the pointer only through the
  injected image facade (the package itself never requires PG); with the
  flag OFF the behavior matches 0.1.1 byte for byte.

## 0.1.1 (2026-10-17)

BOOK-RECOVER registry gate (stage 59, released via stage 61): the scene
storyboard read path self-healed PG for any disk book — when no PG durations
existed it computed them and upserted `image_units` keyed only on disk
presence, re-creating rows for deleted books on every client poll.

### Fixed

- `GET /scene/:b/:ch/:sc/storyboard` — the `image_units` PG upsert
  (duration self-heal) now runs only when the book is still registered
  (owns a `books` row). Durations are still computed and returned in the
  response; only the PG WRITE is suppressed for unregistered books.

### API

- No breaking changes. The gate rides on the existing injection seam:
  `playerRoutes(app, redis, deps)` accepts an optional
  `deps.isBookRegistered(bookId) → Promise<boolean>` and threads it into the
  shared contour context (`playerShared.isBookRegistered`). When the host
  does not inject it, behavior is identical to 0.1.0 (fail-open, legacy
  recovery). Root exports unchanged.

## 0.1.0 — 2026-09-08

### Release preparation (npm publication)

- `@animastor/vbook-runtime` dependency switched from the monorepo
  `file:` link to the published registry range `^0.1.0` (0.1.0 is live on
  npm) — `npm install @animastor/player` now resolves cleanly on a fresh
  environment. The host backend is unaffected: it injects the bookModel,
  so the package's default facade instance is inert inside the backend
  process; the monorepo `file:` links at `backend/package.json` are
  unchanged.
- Consumer metadata completed: keywords, homepage, README installation
  section + Node >= 18 requirement + absolute doc links (relative
  `../../docs/...` links do not resolve on npmjs.com).
- `files` narrowed to production content (`src/` + metadata) — tests stay
  in the repository checkout and run via `npm test`, matching the
  repo-wide package standard (no tests in published tarballs).

### Physical extraction (route split 4d1f6f0e → boundary audit → move)

- The playback HTTP contour physically moved from the backend host into
  `src/` of this package: the registrar (`player-routes.cjs`), shared
  contour helpers (`player-shared.cjs`), scene media (`scene-media.cjs`),
  scene data (`scene-data.cjs`), IU media (`iu-media.cjs`), playback queue
  (`playback-queue.cjs`), the artifact-naming grammar
  (`artifact-naming.cjs`) and the Player Model facade (`player-model.cjs`,
  from the host `backend/src/player/index.cjs`) — final boundary audit
  MOVE list.
- Behavior, URLs, headers (Range / 206 / ETag / If-Range / 304 / 416),
  status codes and response bodies unchanged (17 frozen endpoints, pinned
  by `backend/tests/architecture/player-route-split.test.js` P1).
- Legacy backend copies deleted: `backend/src/routes/player/`,
  `backend/src/player/`, and the empty `routes/book/chunks-routes.cjs`
  registrar stub.
- Every host dependency arrives as an injected port (composition-root
  contract in the README); the package's only dependency is
  `@animastor/vbook-runtime` (Player Model facade).
- Behavior tests moved into the package: `test/scene-timings.test.js`,
  `test/scene-audio-range.test.js`.
