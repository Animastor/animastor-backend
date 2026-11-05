# Changelog

## Unreleased — orchestration v2, stage 1b: audio on the gen core for `books.orchestration='v2'`

ADR animastor-docs `architecture/ORCHESTRATION_V2.md` (редакция 06.11). Branch `orch-v2/1b`; not
deployed; `@animastor/orchestration` 1.0.0 consumed from `packages/` (`file:` link +
`backend/.npmrc install-links=true`) until the owner publishes it.

- Master flag `ORCH_V2_ENABLED` (off by default): migration + sweeper + local runner + `/internal/gen/*`
  only when on, with `ORCH_V2_UPLOAD_SECRET` (>= 32 bytes) and ffmpeg present (`src/orchestration-v2/index.js`).
- Audio ports (`src/orchestration-v2/audio-ports.js`) call the existing code: vbook `collectScenes`,
  `audio/segments.buildSegments`, `audio/generation.buildMergedDialogueWorkflow` /
  `buildSegmentWorkflow` (extracted from `sendPerSegmentAudio`, legacy payload byte-identical),
  `artifactNaming`, `audio/pipeline.buildSceneAudio`, `placeholder-marker.clearPlaceholderMarker`.
- Routes for v2 books: `/regenerate` (audio only; image/video → 409 `v2_layer_not_supported_yet`),
  `cancel-generation`, `cancel-worker` (type / `task_id` = `command_id`), `PUT layer-config`,
  `progress-panel` (same response contract), progress-stream (NOTIFY → existing Redis channel),
  book deletion (gen_* + `.incoming`, hub untouched). Internal: `POST /internal/gen/claim`,
  `POST /internal/gen/beacon` (x-api-key required), `PUT /internal/gen/jobs/:id/result`,
  `POST /internal/gen/jobs/:id/error` (Bearer upload token). Legacy books: unchanged.
- Legacy isolation — one predicate `orchestration-v2/book-flag` (fail-closed): command gate,
  reconcile phases A/B1/B2/C1/C1b/C2/C4/C8/D, scheduler, scene window, gpu-retry-policy,
  startup-resume, window-generator skip v2 books.

## Unreleased — audio: `ready` means a fenced GPU commit, not a file

**Fixed (2026-11-04, `ba_1788172242081` / `ch-5e5a8c76` / `sc-4bb85e02`):** a scene whose
audio was a 10.85 s silent placeholder (87 021 B, `max_volume: -91.0 dB`) was reported `ready`
with `worker_id = NULL`; every “audio” command answered `already_ready` / `already_done` and no
GPU job was ever created.

- Added an explicit placeholder sidecar (`<canonical>.placeholder.json`) written by
  `generateSilentAudio`; a marked file is never treated as real audio.
- Added `validation.isSceneAudioCommitted()`: `ready` now requires the scene’s committed chunk
  artifact(s) of the current generation, a valid canonical file without a placeholder marker,
  and a `ready` asset record. `generateSceneAudio`, the completion callback and the
  `AUDIO_ALREADY_DONE` guard all use it; the guard resets a `DONE` record that no commit backs.
- Removed the `size > 8192 B ⇒ register as ready` safety branch in
  `services/placeholder-audio.js`; an existing file is left untouched and **not** registered as
  ready. `replacePlaceholderWithRealAudio` refuses marked placeholders and requires a
  `{ committed: true }` proof before upgrading a `stale`/`pending` record.
- The `already_ready` fast path no longer writes `audio_status: 'ready'` for chunks that do not
  exist on disk.
- Docs: `docs/audio/ready-semantics.md`. Data cleanup (not executed):
  `scripts/fix-fake-ready-audio-20261104.sql`.
- `hasRealAudio` (reconcile / scene-window / scene-restoration) uses the same predicate:
  `status='ready'` **and** `isSceneAudioCommitted` — an old placeholder without a sidecar under a
  `ready` row is not real audio (integration A+B).
- Publishing real audio (merge / recovery / single-chunk fallback) over a placeholder clears its
  sidecar marker — otherwise the scene would read `placeholder_marker` forever (integration A+B+C).
  Note: the commit proof is the chunks on disk — `KEEP_AUDIO_CHUNKS` must be set wherever this
  backend runs (code default: off).
- Ships in `@animastor/orchestration` **0.3.4** (together with the unpublished 0.3.3 hub-sweep fix).
- Tests: `backend/tests/audio-placeholder-ready.test.js`, `backend/tests/worklist-rebuild.integration.test.js`
  (real-audio fixture now carries its chunk; new case: `ready` row + canonical file without chunks).
