# Changelog

## Unreleased

`POST /api/v1/book/blank` — ownership is now mandatory and the scaffold is
localized.

### Fixed

- Ownership failure is no longer "non-fatal": when
  `editorPorts.resolveOwnership` returns `null` or throws, the route answers
  `503 { error: 'ownership_unavailable' }` and commits nothing (previously an
  unowned book was written to disk).
- A failed `editorModel.commit` after a successful ownership resolve rolls
  the registry row back through the new `editorPorts.rollbackOwnership(bookId)`
  port, then answers 500 — no `books` row without a book on disk.
- Identified request (user or guest) without `req.workspace` → 401; it no
  longer falls back to the default (developer) workspace. Pre-auth requests
  (no identity) keep the default-workspace behaviour.

### Added

- Body field `language` (`'ru' | 'en'`, anything else → `'ru'` for backward
  compatibility). Default book/chapter/scene labels follow it
  (`Новая книга / Новая глава / Сцена 1` or `New book / New chapter / Scene 1`)
  and `book.language` is set to it. An explicit `title` still wins.

### API

- `createEditorPorts` gains the `rollbackOwnership` port (8 ports). The
  backend composition root wires it to `bookRepo.deleteBookSnapshots`.

## 0.1.2 (2026-10-17)

BOOK-RECOVER registry gate (stage 59, released via stage 61): a deleted book
whose disk `book.json` remained was resurrected on every client poll —
`GET /book/:id` unconditionally ran both read-time recovery legs (placeholder
audio + Redis chunks) keyed only on disk presence, re-creating registry state
the cleanup intentionally removed.

### Fixed

- `GET /book/:id` — placeholder-audio recovery and the `recoverMissingRedisChunks`
  call now run only when the book is still registered (owns a `books` row).
  The book read itself still succeeds; only the recovery WRITES are suppressed,
  logged as `[BOOK-RECOVER] … skipped — book not registered`.
- `read-recovery.cjs` — `recoverMissingRedisChunks` re-checks the gate
  internally (defense in depth).

### API

- No breaking changes. The gate rides on the existing optional
  `editorPorts.recoveryCtx.isBookRegistered(bookId) → Promise<boolean>`
  port; when the host does not inject it, behavior is identical to 0.1.1
  (fail-open, legacy recovery). Hosts that inject it (backend composition
  root, stage 59) get the gate; a lookup error is treated as unregistered
  fail-closed host-side.

## 0.1.1 (2026-09-26)

Documentation-only release: the repository `CHANGELOG.md` mistakenly held a
copy of the `@animastor/player` changelog (carried over with the Player
extraction commit and never replaced). The published 0.1.0 npm tarball was
not affected — it contained no CHANGELOG at all (not in `files`). The
runtime code in 0.1.1 is identical to the published 0.1.0 tarball.

### Fixed

- `CHANGELOG.md` — replaced the wrong (Player) changelog with the Editor
  history (see 0.1.0 below).
- `files` — `CHANGELOG.md` added to the published tarball metadata, so the
  correct changelog ships with 0.1.1.

## 0.1.0 (2026-09-08)

First release — the book-editing HTTP contour physically extracted from the
Animastor backend host (editor extraction audit, Phase 4 — physical move
COMPLETE).

### API

- Root entrypoint exports `createEditorModel`, `createEditorRoutes`,
  `createEntityCrudRoutes`, `createEditorPorts` (root-only export map;
  deep imports blocked by the package `exports` map and the deep-import
  guard, PB1–PB4).
- `createEditorModel` — facade over the Canonical Book Model
  (`@animastor/vbook-runtime/book-model.cjs`).
- `createEditorPorts` — frozen host-port seam (Phase 2, guard E5):
  `sceneAssetsRepo`, `placeholderAudio`, `auditCoverage`, `promptLimit`,
  `purge`, `resolveOwnership`, `recoveryCtx`; mandatory ports fail-closed.

### Surface

- Core book GET/PUT/PATCH/DELETE with read-time enrichment and the
  post-commit derived-state fan-out.
- Targeted PATCH endpoints: scenes / metadata / locations / characters /
  voices / behaviors.
- Entity CRUD (characters / locations / voices / behaviors) with the
  entity-id grammar (transliteration → snake_case over the pure cyr-latin
  map), duplicate-id 409, missing-name 400, full-passport delete plus the
  dangling same-id voice cleanup.
- Structure CRUD (chapters / scenes / units) and blank-book scaffolding
  (`POST /book/blank`).
- Scene-patch utils (pure) and read-recovery (chunk repair ctx).

### Boundary

- No backend-host imports: book content is reached only through the
  injected `editorModel`; every host dependency arrives as an injected
  port at registration time.
- Runtime dependency: `@animastor/vbook-runtime ^0.1.0` (Book Model facade
  + `lazy-book/paths` id grammar).
