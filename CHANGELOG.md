# Changelog

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
- Tests: `backend/tests/audio-placeholder-ready.test.js`.
