# Changelog

## 0.5.1 (2026-11-25)

### Fixed

- Blank book (`POST /book/blank`): `build_id` is `manual_<uuid>`
  (`crypto.randomUUID()`), not `manual_<Date.now()>`. Two blank books created
  in the same millisecond got the same build id, and the build directory
  (`OUTPUT_DIR/<build_id>/`, `voices/` included) is per build id. Nothing
  parses the suffix. No API change.

## 0.5.0 (2026-11-18, unpublished)

VBook 4 step 4 — the hero API (animastor-docs `architecture/VBOOK_FORMAT_V4.md`
§8.2, §9, §10.3; `05-frontend/HERO_CARD.md`). Requires
`@animastor/vbook-runtime ^0.5.0`. **Breaking.**

### Added — `createHeroRoutes` (new registrar, `src/hero-routes.cjs`)

- `GET /book/:id/heroes`, `GET /book/:id/heroes/:heroId`.
- `POST /book/:id/heroes` `{id?, name, role?, aliases?, notes?, passport?, voice?}` —
  201; id from the name (existing transliteration); 409 `hero_exists`,
  409 `hero_file_broken`, 400 `reserved_id` / `invalid_hero_id` / `name_required`.
  `{id: "narrator"}` re-creates a missing narrator.
- `PATCH /book/:id/heroes/:heroId` `{fields, if_rev?}` — white list of §8.2,
  `passport: null` / `voice: null` remove a block, `{}` adds one; 409
  `rev_conflict` (the answer carries the current `rev`); 400
  `field_not_editable` / `name_required` / `alias_equals_name` /
  `too_many_video_tokens` / `too_many_aliases` / `narrator_voice_required` /
  `invalid_character`. Editing `voice.timbre` marks `timbre_source: "user"`.
- `DELETE /book/:id/heroes/:heroId` — 409 `narrator_required`; `?broken=1`
  deletes a broken file under that id (409 `hero_not_broken` for a healthy one).
- `DELETE /book/:id/hero-files?file=<name>` — a broken file whose name is not a
  hero id (owner's decision В14): only a name in the current `hero_issues`
  (404 `not_in_hero_issues`), only one plain name (422 `invalid_file_name`); a
  symbolic link is removed as a link.
- Rules: `POST …/heroes/:heroId/rules` (id `<hero>.<three words>`, unique in
  the book — 409 `rule_exists`), `PATCH …/rules/:ruleId {fields}`,
  `DELETE …/rules/:ruleId` (404 `rule_not_found`).
- Looks: `POST …/heroes/:heroId/looks`, `PATCH …/looks/:lookId`,
  `DELETE …/looks/:lookId` (releases every reference, answers `unassigned`),
  `POST /book/:id/looks/assign` — 400 `look_empty` / `look_label_required` /
  `invalid_look_id` / `base_for_chapter`, 404 `look_not_found` /
  `chapter_not_found` / `scene_not_found`, 409 `look_exists` / `passport_required`.
- `GET /book/:id/behaviour`, `PATCH /book/:id/behaviour {fields}`
  (`defaults.max_per_scene`, `rules`) — 409 `behaviour_file_broken`, 400
  `invalid_behaviour`.
- Writes of one hero go through the runtime's character store
  (`editorModel.heroes(bookId)`: read → change → validate → atomic write,
  synchronously); writes that also touch chapters go through `commit`.
- Error body of every hero route: `{error: <code>, message, …}`.

### Changed

- `GET /book` — heroes carry the computed fields `rev`,
  `voice.reference_state`, `voice.reference_outdated`, `image_refs[].state`
  (never stored); `PUT /book` strips them.
- `PATCH /scene` — `looks.<hero_id>` and `look_patch.<hero_id>.<field>`;
  `passport.*` → 400 `legacy_field`.
- `editorPorts.outputRoot` (read only) — the 9th port: where a hero's reference
  files live, for the computed states.
- `dirty_scenes` of hero / look routes is the array of `{chapter_id, scene_id,
  reason, dirty_layers}`.

### Removed

- `PATCH /characters/:id`, `/voices/:id`, `/behaviors/:id`; `POST` / `DELETE`
  `/characters`, `/voices`, `/behaviors` (they answered 409
  `vbook_v4_pending` since 0.5.0-step 1) and `src/vbook4-pending.cjs`.

## 0.4.0 (2026-11-12, unpublished)

Voice references (animastor-docs `architecture/VOICE_REFERENCES.md`).

- `PATCH /voices/:id` edits only `timbre` / `manner` (others → 400); editing `timbre` sets
  `timbre_source: "user"`. The reference is changed only through the voice-reference API.
- `POST /voices` creates `{timbre, manner, timbre_source:"user"}` (the `instruction` field is gone).
- Both go through the `@animastor/vbook-runtime` voice port (^0.4.0).

## 0.3.0 (2026-11-10, unpublished)

behavior.json schema v2 (animastor-docs `architecture/VBOOK_BEHAVIOUR.md`).
Requires `@animastor/vbook-runtime ^0.3.0`.

### Changed

- `POST/PATCH/DELETE /behaviors…` and the character-delete cascade work on
  `behaviors.characters.<character_id>`; `rules` / `schema_version` are never
  touched; a v2.1 file is migrated on the first write.
- `DELETE /characters/:id` also removes the rules with `scope:"character"`
  and that `character_id` (global rules stay).
- `GET /book/:id` keeps the v2.1 API contract: `behaviors` is the flat
  character map, the rules come as read-only `behavior_rules`.
- `PUT /book/:id` folds a client `behaviors` flat map into the stored v2
  document (rules survive; reserved keys are not characters); an absent
  `behaviors` keeps the stored document (previously it was reset to `{}`);
  `behavior_rules` in the body is ignored.

## 0.2.0 (2026-10-29)

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
