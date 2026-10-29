# Changelog

## 0.2.0 (2026-10-27)

Version-line split for `stage143a-foundation-phase1`: the branch line moves
`0.1.6 → 0.2.0` so it can never collide with, or be shadowed by, the hotfix
line. **No functional change** — the content is the `0.1.6` code below (D1 +
A1 already in this branch).

**The hotfix line is separate:** `0.1.7` (branch `hotfix/d1-d2-a1`) is cut
from `0.1.4`, not from this line, and carries only D1 + the A1 version-gate
fallback (D2 and the host side of A1 live in `backend`). `^0.1.x` therefore
resolves within the `0.1.x` line, while this branch's backend depends on
`^0.2.0`.

## 0.1.7 (2026-10-27) — hotfix line (содержимое входит в 0.2.0)

Hotfix line (branch `hotfix/d1-d2-a1`, base `78e8f1ae` = `0.1.4`): only the
D1 and A1-gate fixes are carried in this package. It is a **separate line from
the `0.1.6` entry of the `stage143a-foundation-phase1` branch** — this package
is `0.1.4` + the two fixes, not a descendant of `0.1.5`/`0.1.6`.

**In this package:** D1, A1-gate. **In `backend` (not here):** D2 and the host
side of A1 (`scene-assets-repo.getAssetNullBuild` + runtime adapter + port op).

### Fixed

- `orchestration/orchestrator.js` (D1, stage 146) — the
  `require('@animastor/generation').artifactNaming` binding lived INSIDE
  `beginStage()`, but `resetScenes()` also reads it in the stale-PNG/preview
  pre-delete branch (step 6). Any regeneration that passed `cleanPngUnitIds`
  therefore threw `ReferenceError: artifactNaming is not defined`, and
  `/regenerate` returned HTTP 500. The binding now sits at module scope, next
  to the other module-level requires; `beginStage()` keeps its own
  `dispatchEngine` lazy require. Behavior is otherwise unchanged.
- `orchestration/orchestrator.js` (`completeStage` version gate, A1 /
  stage 146 §5.4) — when `sceneAssets.getAsset(..., buildId)` found no row for
  THIS build, the gate went fail-closed (DIRTY) even though the key's only row
  was a legacy `build_id IS NULL` row: `getAsset` filters `build_id = $5`, and
  `markReady` — the only writer able to stamp `build_id`
  (`buildIdFromArtifactPath`) — runs BEHIND the gate. The scene then
  re-dispatched every 5 s tick (`cache_hit` → callback → `stale` → DIRTY)
  forever. The gate now performs exactly ONE additional read of the SAME key
  with `build_id IS NULL` (never another build's row, never "latest any row")
  through the PersistencePort op `sceneAssets.getAssetNullBuild`, applies the
  SAME version rules (`scene_content_version`, plus
  `scene_audio_config_version` for audio), and lets `markReady` stamp
  `build_id` as before. A NULL row whose version is below the scene version
  still fails the gate (DIRTY), so the loop converges after the next real
  dispatch instead of spinning. PG errors stay fail-closed.

### Shipped by backend, not by this package

- D2 — `/api/v1/debug/runtime/*` middleware now calls `next()`
  (`backend/src/routes/debug-routes.cjs`).
- A1 host side — `sceneAssets.getAssetNullBuild` implementation and delegation
  (`backend/src/storage/postgres/repositories/scene-assets-repo.js`,
  `backend/src/storage/runtime-persistence-adapter.js`) plus the op
  declaration in `runtime/persistence-port.js`.

## 0.1.6 (2026-10-26)

Stage 146 — D1 fix: `artifactNaming` hoisted to module scope.
Stage 147 — A1 fix: version-gate sees the legacy `build_id IS NULL` row.

### Fixed

- `orchestration/orchestrator.js` — the `require('@animastor/generation')
  .artifactNaming` binding lived INSIDE `beginStage()`, but
  `resetScenes()` also reads it in the stale-PNG/preview pre-delete branch
  (step 6). Any regeneration that passed `cleanPngUnitIds` therefore threw
  `ReferenceError: artifactNaming is not defined`, and `/regenerate`
  returned HTTP 500. The binding now sits at module scope, next to the
  other module-level requires; `beginStage()` keeps its own
  `dispatchEngine` lazy require. Behavior is otherwise unchanged.
- `orchestration/orchestrator.js` (`completeStage` version gate, A1 /
  stage146 §5.4) — when `sceneAssets.getAsset(..., buildId)` found no row
  for THIS build, the gate went fail-closed (DIRTY) even though the key's
  only row was a legacy `build_id IS NULL` row: `getAsset` filters
  `build_id = $5`, and `markReady` — the only writer able to stamp
  `build_id` (`buildIdFromArtifactPath`) — runs BEHIND the gate. The scene
  then re-dispatched every 5 s tick (`cache_hit` → callback → `stale` →
  DIRTY) forever. The gate now performs exactly ONE additional read of the
  SAME key with `build_id IS NULL` (never another build's row, never
  "latest any row") through the same PersistencePort op
  `sceneAssets.getAssetNullBuild`, applies the SAME version rules
  (`scene_content_version`, plus `scene_audio_config_version` for audio),
  and lets `markReady` stamp `build_id` as before. A NULL row whose
  version is below the scene version still fails the gate (DIRTY) — the
  correct version arrives from `stampSceneVersionsForDispatch` (dispatch
  step 5.5 stamps ALL rows of the key, incl. `build_id IS NULL`, before
  every generation/cache_hit), so the loop converges after the next real
  dispatch instead of spinning. PG errors stay fail-closed.

### Changed (host adapter, A1)

- `backend/src/storage/postgres/repositories/scene-assets-repo.js` — new
  `getAssetNullBuild` (same key, `build_id IS NULL`, latest NULL row).
- `backend/src/storage/runtime-persistence-adapter.js` — delegates the new
  op; `runtime/persistence-port.js` — declares `sceneAssets.getAssetNullBuild`
  in `OPS` (no SQL crosses the port).

## 0.1.5 (2026-10-26)

Stage 143a — versioned-pointer readers + atomic publication. See the
player 0.1.2/0.1.3 entries (same stage) for the flag-gated IU-media
contour this package complements.
