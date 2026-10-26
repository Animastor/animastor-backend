# Changelog

## 0.1.6 (2026-10-26)

Stage 146 — D1 fix: `artifactNaming` hoisted to module scope.

### Fixed

- `orchestration/orchestrator.js` — the `require('@animastor/generation')
  .artifactNaming` binding lived INSIDE `beginStage()`, but
  `resetScenes()` also reads it in the stale-PNG/preview pre-delete branch
  (step 6). Any regeneration that passed `cleanPngUnitIds` therefore threw
  `ReferenceError: artifactNaming is not defined`, and `/regenerate`
  returned HTTP 500. The binding now sits at module scope, next to the
  other module-level requires; `beginStage()` keeps its own
  `dispatchEngine` lazy require. Behavior is otherwise unchanged.

## 0.1.5 (2026-10-26)

Stage 143a — versioned-pointer readers + atomic publication. See the
player 0.1.2/0.1.3 entries (same stage) for the flag-gated IU-media
contour this package complements.
