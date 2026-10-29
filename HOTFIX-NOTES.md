# HOTFIX D1 + D2 + A1 (branch hotfix/d1-d2-a1, base 78e8f1ae)

Source commits (branch stage143a-foundation-phase1):
- 683592a4 — D1 (artifactNaming hoisted to module scope) + D2 (next() in /api/v1/debug/runtime middleware)
- 2754bc0f — A1 (sceneAssets.getAssetNullBuild + completeStage version-gate fallback via versionsConfirm)

## What was carried over

Source changes: the +/- lines are byte-identical to the source commits (`git apply -3`, every hunk applied cleanly):
- packages/animastor-orchestration/src/orchestration/orchestrator.js — D1 + A1
- backend/src/routes/debug-routes.cjs — D2
- backend/src/storage/postgres/repositories/scene-assets-repo.js — A1
- backend/src/storage/runtime-persistence-adapter.js — A1
- packages/animastor-orchestration/src/runtime/persistence-port.js — A1 (OPS)

Tests: copied verbatim from the source commits. They needed no adaptation to the base:
- packages/animastor-orchestration/test/stage146-d1-artifact-naming.test.js
- backend/tests/stage146-d2-debug-runtime.test.js
- packages/animastor-orchestration/test/stage147-a1-null-build-gate.test.js
- backend/tests/stage147-a1-null-build-gate.test.js

## Divergences from the source commits

1. **Omitted on purpose (versions/locks are handled by another agent):** packages/animastor-orchestration/CHANGELOG.md, the orchestration package.json bump 0.1.5→0.1.6 (plus `"files"`), packages/animastor-orchestration/package-lock.json, backend/package.json (`^0.1.6`), backend/package-lock.json.
2. **Delivery gap (important):** at 78e8f1ae the backend consumes `@animastor/orchestration@0.1.4` **from the npm registry** (backend/package-lock.json). The D1 and A1-gate fixes in `packages/animastor-orchestration/src` therefore reach the production backend only after a version bump and publish of the package. D2 and the host side of A1 (repo + adapter) apply to the backend directly. The adapter's new `sceneAssets.getAssetNullBuild` is harmless alongside the published 0.1.4: the op is simply never called there.
3. **Patch context:** at the base, the touched files lack later hunks from stages 122 (`idem.releaseTaskDoneIfOrphan`) and 133 (`/debug/audio/recover` dispatch_id). The patch context differs, but the changes themselves are identical. Nothing from stages 114–147 beyond D1/D2/A1 was pulled in.
4. **Test environment (not committed):** the base has no `backend/tests/monorepo-source-bindings.cjs`. The backend tests ran with `backend/node_modules/@animastor/orchestration` symlinked to this tree's `packages/animastor-orchestration` source, mirroring the monorepo layout of the source branch. Otherwise they would test the registry copy 0.1.4. The other node_modules are symlinks into the main checkout. No npm ci was run.
5. **A1 backend test, PG-integration layer:** the `describe('Stage 147 (A1): PG-интеграция …')` layer was NOT run (`--grep "PG-интеграция" --invert`) because it would write to the local DB. The file is kept intact; another agent runs the layer on staging. On the unit layer, 2 of 7 tests fail before the fix. The source commit's "5 fail" count included the PG layer.
6. HOTFIX-NOTES.md is a new file that is not in the source commits.

## Proof (each file run on its own)

| Test | 78e8f1ae (tests only) | after fix |
|---|---|---|
| pkg stage146-d1-artifact-naming | 0/1 — `ReferenceError: artifactNaming is not defined` (orchestrator.js:534) | 1/1 |
| backend stage146-d2-debug-runtime | 0/1 — `AbortError` (request hangs) | 1/1 |
| pkg stage147-a1-null-build-gate | 4/6 (tests 1, 3 fail) | 6/6 |
| backend stage147-a1-null-build-gate (unit layer) | 5/7 (A1 repro and "other build" fail) | 7/7 |
