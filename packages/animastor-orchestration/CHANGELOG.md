# Changelog

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
