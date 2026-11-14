# Changelog

## 0.5.0 (2026-11-14, unpublished)

VBook 4 — "one file per hero" (animastor-docs `architecture/VBOOK_FORMAT_V4.md`,
step 1 of §12). **Breaking: VBook 3.1 is not readable and there is no
migration.**

### Format

- Layout on disk and in a `.vbook`, by exact path: `manifest.json`
  (`vbook_version: 4`, integer; `"4"` and `"4.x"` are also read), `book.json`
  (`structure.chapters_order`, `structure.characters_order`), optional
  `bible.json` / `locations.json` / `source.txt`, `behaviour.json`,
  `characters/<id>.json` (schema `animastor.character/1`), `chapters/ch-*.json`.
  `characters.json`, `voices.json`, `behavior.json`, `mentions.json` are gone.
- In memory: `{ manifest, book, bible, locations, behaviour, heroes[],
  hero_issues[], chapters[] }`. `book.characters` / `voices` / `behaviors` /
  `mentions` are removed; a book object that still carries one is refused.

### Added

- `src/heroes.cjs` — `findHero`, `passportHeroes`, `narrator`, `voiceInstruct`,
  `buildAliasIndex`, `heroRules`, `sortHeroes`, `collectBookHeroIssues`,
  `CANONICAL_ID_RE`, `RESERVED_HERO_IDS`, `isCanonicalHeroId`, `isValidHeroId`.
- `src/looks.cjs` — `resolveHeroLook(book, chapter, scene, heroId)`.
- `src/character-store.cjs` — the only writer of hero files: `listCharacters`,
  `inspectCharacter`, `readCharacter`, `writeCharacter`, `updateCharacter`,
  `removeCharacter`, `atomicWriteFile` / `atomicWriteJson`,
  `cleanStaleTempFiles`, `HeroStoreError` (`invalid_hero_id`, `reserved_id`,
  `invalid_character`, `hero_file_broken`, `narrator_required`,
  `path_is_link`). Paths go through `joinInside`; symbolic links are never
  followed; writes are temp file → fsync → rename.
- `src/character-validator.cjs` — `validateCharacterFile(doc, {filename})`,
  `validateBehaviourGlobals(doc)` (also exported from `bundle-validator.cjs`).
- `src/vbook-version.cjs` — `assertSupportedVbookVersion(manifest)`,
  `BookModelError('UNSUPPORTED_VBOOK_VERSION')`, `unsupportedVersionBody`.
- `exportBookBundle(bookId, {skipBroken})`, `bundleFilesFromBook(book)` — one
  serializer for save and export; export goes by the format whitelist.
- Voice port: `resolveReferenceFile(buildDir, ref, heroId?)`,
  `referenceState(buildDir, ref, heroId?)`.
- `schemas/character-1.schema.json` (byte copy of the normative schema),
  `schemas/vbook-bundle-4.schema.json`.

### Changed (breaking)

- `loadBook` / `loadDraftBook` / `bookModel.loadBook` throw
  `BookModelError('UNSUPPORTED_VBOOK_VERSION')` for a 3.1 book, a book without
  a version and a newer one; `null` now means only "no such book".
- `saveBookBundle(book)` saves the object only; the raw-files mode
  (`saveBookBundle(book, files)`) is removed. Everything is validated before
  the first write; hero files are written only when changed, and a broken hero
  file is never overwritten or deleted.
- `extractBookBundle` / `buildBookFromBundle` take exact paths: no suffix
  search, no prefix folder (`MANIFEST_NOT_IN_ROOT`), no chapter files in the
  archive root. An archive with a broken hero file is refused
  (`HERO_FILE_BROKEN`, status 422, `.issues`).
- `safe-paths`: the entry whitelist is the v4 layout; `classifyBundleEntry`.
- Voice port storage: `voices.json[id]` → `characters/<id>.json` → `voice`.
  Names, fields and checks of the port are unchanged; a reference must point
  into the hero's own folder; `model` / `seed` without a value are stored as
  absent keys.
- lazy-book: a new book is created with `characters/narrator.json` and
  `behaviour.json`; `create.js` writes heroes through the character store, no
  longer writes `mentions.json`, keeps the voice of an existing hero, and
  writes `scene.look_patch` instead of `scene.passport`. `getCharactersPath`,
  `getMentionsPath`, `getVoicesPath`, `getBehaviorPath` are removed
  (`getCharactersDir`, `getBehaviourPath`).

### Removed

- `src/behavior-schema.cjs` (subpath `./behavior-schema.cjs`, `behaviorSchema`
  on the root), `addDirToZip`, `schemas/vbook-bundle-3.1.schema.json`.

## 0.4.0 (2026-11-12, unpublished)

Character voice port + voice references (animastor-docs
`architecture/VOICE_REFERENCES.md`).

### Added

- Stricter input validation for book storage (same change as 0.2.1 / 0.3.1,
  see 0.3.1 below).

- `src/voice.js` (subpath export `./voice`, also `voice` on the root) — the ONE
  access point to a character's voice: `getCharacterVoice`, `listVoiceIds`,
  `setCharacterVoiceReference`, `setCharacterVoiceDescription`,
  `narratorVoiceId`, `voiceDesignDescription`, `cleanVoiceDescription` /
  `voiceFromDescription` (rule-based cleanup, no LLM), `referenceProblem`.

### Changed (breaking)

- `voices.json[id]` is `{timbre, manner, timbre_source, reference}`; the
  `instruction` field is no longer read or written. Lazy-book create stores
  analysis descriptions through `voiceFromDescription` (timbre_source
  `cleaned`); the default narrator is `{timbre, manner}`.
- Bundle validator checks `timbre` / `manner` / `timbre_source` and the
  `reference` link (`voices/<id>/<candidate>.wav`, sha256, source,
  verification, locked). Audio files are never part of the bundle.

## 0.3.1 (2026-11-13)

Stricter input validation for book storage.

- Book ids and build ids are checked against a fixed grammar before any disk
  access; resolved paths must stay inside the configured root
  (`./safe-paths`: `assertBookId`, `assertBuildId`, `assertInside`, `joinInside`).
- `.vbook` import accepts only the format 3.1 file set; other entries are
  skipped and never written; malformed archives are refused. Archive size and
  entry count are limited.
- `resetBook` removes only a book directory inside the books root.
- Book export skips links.
## 0.2.1 (2026-11-13)

Same input-validation fix, published as 0.2.1 for the incident hotfix; see
0.3.1 above for the full list.

## 0.3.0 (2026-11-10, unpublished)

behavior.json schema v2 (behaviour rules, phase 0 — animastor-docs
`architecture/VBOOK_BEHAVIOUR.md`).

### Added

- `src/behavior-schema.cjs` (subpath export `./behavior-schema.cjs`, also
  `behaviorSchema` on the root): `normalizeBehaviors`, `ensureBehaviorsV2`,
  `behaviorCharacters`, `toApiBehaviors`, `projectBookBehaviorsForApi`,
  `mergeIncomingBehaviors`, `flatToCharacters`, `BEHAVIOR_RESERVED_KEYS`.
- `removeCharacterBehaviors(book, characterId)` — character-delete cascade:
  drops `characters.<id>` and every rule with `scope:"character"` bound to it.
- Lazy-book create keeps optional IU fields `state`, `behaviour`,
  `behaviour_locked` and a pre-assigned unit `id`.

### Changed

- behavior.json on disk and in memory is
  `{schema_version: 2, rules: [], characters: {<id>: …}}`. A file without
  `schema_version` (v2.1) is migrated on load (`loadBook`, `.vbook` import):
  every top-level key becomes a `characters` entry. `saveBookBundle` always
  writes v2; a new book is seeded with an empty v2 document instead of `{}`.
- Bundle validator checks the v2 shape (`schema_version === 2`, `rules[]` with
  unique non-empty `id`, `characters` object); v2.1 files are still accepted.

## 0.2.0 (2026-09-26)

Parser Core physically moved out of this package into the standalone
[`@animastor/parser`](https://www.npmjs.com/package/@animastor/parser)
package (C13–C15 extraction). This is a breaking release for consumers of the
removed subpath exports; the book-model surface is unchanged.

### Breaking

- Removed `src/parser-core.js`, `src/language-detector.js`,
  `src/contracts/parser-contract.js`, `src/contracts/legacy-projection.js`
  and `src/lazy-book/parser.js` — the parser implementation now lives in
  `@animastor/parser`.
- Removed subpath exports `./language-detector` and `./lazy-book/parser`.
  Migrate to `@animastor/parser` (root) or
  `@animastor/parser/language-detector` — the re-exported API is identical.
- Dependency change: `tinyld` removed (moved with the language detector);
  `@animastor/parser ^0.1.0` added (registry dependency, replaces the
  monorepo `file:` link).

### Unchanged

- The canonical Book Model facade (`./book-model.cjs`), bundle CRUD,
  lazy-book lifecycle, bundle validation, snake-guard / character-identity /
  scene-title-utils and the JSON schemas are untouched; the parser contract
  DTOs keep flowing through the same call signatures (now re-exported from
  `@animastor/parser`).

### C13 Parser contract (pre-release state, superseded by the move above)

- The contract work that first landed here (canonical `ParserResult`/
  `ChapterMap` DTO + validators, legacy chapter projection,
  `buildChapterMap` port alias) moved with the parser into
  `@animastor/parser` 0.1.0.

## 0.1.0 — 2026-09-07

### Physical extraction (relocation checklist §2 COMPLETE)

- The runtime physically moved from `backend/src/book/` into `src/` of this
  package: bundle CRUD (`index.js`), Book Model facade (`book-model.cjs`),
  validator (`bundle-validator.cjs`), booksRoot port (`books-root.js`),
  lazy-book runtime (`lazy-book/`), and the extraction companions
  (`language-detector.js`, `character-identity.js`, `snake-guard.js`,
  `scene-title-utils.js`) — audit §1.1.
- `exports` map for every legacy host entry point; dependencies:
  `adm-zip` + `tinyld` only (guarded by `backend/tests/architecture/vbook-package-boundary.test.js`).
- The host keeps one-line re-export shims at the legacy paths
  (`backend/src/book/**`, `backend/src/services/language-detector.js`,
  `backend/src/utils/{character-identity,snake-guard,scene-title-utils}.js`).
- `backend/src/book/book-deletion.cjs` moved to host services
  (`backend/src/services/book-deletion.cjs`) — deletion orchestration is
  host doctrine, outside the package scope.
- Package-owned standalone test suite (`npm test`): booksRoot fail-closed
  port, id grammar, draft lifecycle → bundle round-trip, Book Model facade,
  validator C1 rules, doctrine companions (audit E1/E2).

### Preparation (previous commit)

- `booksRoot` port — `configureBooksRoot()` (static string or live
  `() => config.BOOKS_DIR` provider), fail-closed getters; the package
  never imports host config nor reads `process.env`.
- `structureDetector` port — `setStructureDetector()` injectable binding
  (Parser ≠ VBook); the ChapterMap contract is the seed of C13.
- `schemas/vbook-bundle-3.1.schema.json` mirroring the validator rule by
  rule; public-API freeze + ownership map in the README.

## 0.1.0-rc1 — PREPARATION (superseded by 0.1.0)

Package boundary preparation for the extraction of `backend/src/book/` into
`@animastor/vbook-runtime`. No physical move in that commit — the code lived
in the backend tree, wired through the ports.

- Package manifest (`package.json`) with the frozen dependency surface:
  `adm-zip` + `tinyld` only.
- Public API freeze list (README, audit §4.1).
- `booksRoot` port: `configureBooksRoot()` / fail-closed getters; host
  composition root binds `config.BOOKS_DIR`; `runtime-config` require removed
  from the book domain.
- `structureDetector` port: `setStructureDetector()` / fail-closed getter;
  host composition root binds the real `services/structure-detector`.
- `schemas/vbook-bundle-3.1.schema.json` — canonical bundle contract mirroring
  `bundle-validator.cjs` (audit A1), pinned by the validator↔schema sync test.
- Ownership map frozen: bundle/book canonical state → package; snapshots,
  deletion orchestration, Redis/PG/GPU Hub → host.
- Boundary guards: `backend/tests/architecture/vbook-package-boundary.test.js`,
  `backend/tests/architecture/vbook-bundle-schema.test.js`.
