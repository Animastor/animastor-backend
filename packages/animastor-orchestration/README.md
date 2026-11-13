# @animastor/orchestration

## 1.x — orchestration v2 (`gen`)

ADR: animastor-docs `architecture/ORCHESTRATION_V2.md`. The new core lives in
`src/gen/` and is exported as `gen`. The 0.3.x contour described below ships
unchanged in `src/legacy/` (same root exports) until migration stage 4.

```js
const { gen } = require('@animastor/orchestration');
await gen.migrate(pool);                       // idempotent; needs books/workers/scene_assets
const orch = gen.createOrchestration({
    pool,                                      // pg Pool supplied by the host
    ports: { planUnits, buildPayload, artifactPath, validateResult, runLocal,
             laneFor, timeoutFor, retryPolicy },   // see src/gen/ports.js
    uploadSecret,                              // >= 32 bytes, HMAC of upload tokens
    outputDir,                                 // {build}/.incoming cleanup
    sharedLimit: null,                         // ADR §10; NULL = off
});
await orch.createCommand({ workspaceId, userId, bookId, kind: 'regenerate',
                           scope: { level: 'scene', chapter_id, scene_id },
                           layers: ['audio'], clientActionId });
await orch.claim({ workerId, workerType: 'audio', mode: 'private', workspaceId });
await orch.acceptResult(jobId, attempt, uploadToken, readableStream);
orch.startSweeper(10_000);
```

**1.1.0 (images, stage 2a).** `iu_image` results are checked by `inspectPng`
(structure + CRC, dimensions > 0, pixel data, not a blank frame — luma stddev ≥
`minLumaStddev`, default 2.0); a unit may carry `input.part_hash` (part-level
«already done» skip) and `input.scene_parts` (scene asset `ready` once every
listed part is accepted — for part kinds without a merge stage).

**1.2.0 (observability).** Pass `logger` (`{ info | log, error }`) to
`createOrchestration`: the core writes one line per step —
`[gen-v2] command-created | claim | accept | error | requeue | command-finished`
with `book_id`, `command_id`, `job_id`, `kind`, `unit_key`, `attempt`,
`worker_id`, `sha256`, sizes and durations (allowlisted fields only: no upload
tokens, paths or task params). Image acceptance records `width`/`height`;
accepted files are `0644`.

**1.3.0 (video, stage 3a).** `planUnits(book, scope, layer, ctx)` gets
`ctx.db` (the command / acceptance transaction); for `video` it may answer
`{units, waits, skipped}` — waits join the live images / audio of the scene,
skip reasons (`skipped_*`) land in the command summary and in
`gen_command_skips` (migration 004, `progress().commands[].skipped`). Stage
transitions: `audio_merge → video`, `iu_image → video`, `video_group →
video_merge` by `input.merge_parts`; all parts done, no merge → the merge alone.
`onArtifactPlaced(job, path, {db, meta})` (meta = what `runLocal` returned);
optional port `inputFiles(job)` → `task.input_files` + `orch.openInput(…)` for
`GET /internal/gen/jobs/:id/input/:name` (ADR §8.1).

`gen` requires only node builtins and its own files: no `src/legacy`, Redis,
Express or ComfyUI. Tests: `npm run test:gen` (env `PG_*` of the animastor-test
stack; refuses a DB not ending in `_test` or port 5432).

## 0.3.x contour (`src/legacy/`)

Generation orchestration and runtime contour of the Animastor backend,
physically extracted from the host (`backend/src/orchestration/**` +
`backend/src/runtime/**` — §32.30; recon:
`docs/architecture/generation-module-extraction-reconnaissance.md` §32.29).

The package owns:

- the orchestration facade (stage executor + FSM-safe scene writers)
- the dispatch engine and its lease/quota/retry managers
- the reconciliation engine and counter reconciliation
- scene window/scheduler/worker-health
- the runtime-result emitter/consumer
- the eight O-2…O-10 port contracts (Persistence, SceneData,
  PlaceholderAudio, ProgressEvents, AudioFsm, VideoFsm, HubCancel,
  LayerConfig)

## Dependency direction

```
backend host → @animastor/orchestration → ports / host-bindings / contracts
```

The package reaches the host (runtime config, Redis-domain state, media
facades, S-5 seam registry, artifact root, PW-2 workspace resolver)
**only** through the composition-root host-bindings seam — no
`backend/src` require, no storage/book/routes/services, no Redis, no PG,
no Express inside.

Runtime dependencies: `@animastor/contracts`, `@animastor/generation`,
`music-metadata`.

## Public API

```js
const orchestration = require('@animastor/orchestration');
```

| Export | Kind | Description |
|---|---|---|
| orchestration facade | lazy | stage executor + FSM scene writers (begin/plan/dispatch/complete/fail/rollback) |
| `createRuntimeResultConsumer` | eager | Phase-5 result-reporting consumer |
| `ports` | eager | `{ persistence, sceneData, placeholderAudio, progressEvents, audioFsm, videoFsm, hubCancel, layerConfig }` |
| `bindHostModules` | eager | composition-root binding surface |
| `hostBinding` | eager | host-binding accessor |
| `runtime` | lazy namespace | `{ scheduler, activeScenes, reconciliation, dispatch, leaseManager, counterReconciliation, metrics, workerHealth, sceneWindow, failureTaxonomy, runtimeResultEmitter }` |

Facade exports are **lazy getters** — the FSM-writer re-exports resolve
the `stateOps` host binding on access. `Object.defineProperties` on the
root prevents eager evaluation at `require()` time.

Deep imports (`@animastor/orchestration/runtime/…` etc.) are NOT part of
the public surface — the exports map exposes only `'.'`.

## Host responsibilities (composition root)

1. Call `bindHostModules(…)` to wire config/state/media/seams/artifact
   root/PW-2 resolver before accessing any lazy export.
2. Register `createRuntimeResultConsumer` via
   `runtimeResultEmitter.setConsumer(…)`.

Without host binding, lazy getters throw on first access. This is
intentional — the package is a pure domain contour until the composition
root wires it.

## Tests

```bash
npm test            # package-own suite (standalone, no backend required)
```

Backend-side guards: `backend/tests/architecture/physical-move-gate.test.js`
(PM-G suite) ensures the moved files are gone from `backend/src/runtime`
and the barrel is not consumed.
