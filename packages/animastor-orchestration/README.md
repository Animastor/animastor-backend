# @animastor/orchestration

## 2.0.0 — orchestration v2 (`gen`) only

ADR: animastor-docs `architecture/ORCHESTRATION_V2.md`. The core lives in
`src/gen/` and is exported as `gen` — the only export of the package root.
The 0.3.x legacy contour (`src/legacy/`: dispatch / reconcile / lease / FSM,
O-2..O-10 ports, host bindings, `runtime` namespace, orchestrator facade) is
removed in 2.0.0 (ADR §12 stage 4). No runtime dependencies.

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

**2.0.0 (stage 4).** `createCommand` no longer reads `books.orchestration`
(no `409 book_not_v2`): every book is v2 since `006-default-v2`; the column
stays as a migration trace.

`gen` requires only node builtins and its own files: no Redis, Express or
ComfyUI. Tests: `npm test` (`test/gen/*.test.js`; env `PG_*` of the
animastor-test stack; refuses a DB not ending in `_test` or port 5432).
