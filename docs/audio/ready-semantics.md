# Audio readiness semantics: `ready` is a fenced commit, not a file

**Status:** adopted 2026-11-04 (fix for `ba_1788172242081` / `ch-5e5a8c76` / `sc-4bb85e02`).
**Owner:** backend audio contour (`backend/src/audio`, `backend/src/services/placeholder-audio.js`)
and the orchestration guards (`@animastor/orchestration` scene-orchestrator / scene-callbacks).

## Why this document exists

A scene’s audio was reported **ready** while the player played 10.85 s of silence, and every
“audio” command answered `already_done` / `already_ready` — no GPU job was ever created:

```
[AUDIO] findExistingSceneChunks: enumerated 0/1 chunks: []
[AUDIO] Audio already ready, no generation needed: …/sc-4bb85e02
[AUDIO-ORCH] … MERGING → DONE
[PLACEHOLDER-AUDIO] Audio in status stale … — updating to ready
[ORCH] [COMPLETE-STAGE] … audio → READY
```

The file was a valid silent MP3 (87 021 bytes, 24 kHz mono, 64 kbps, `max_volume: -91.0 dB`), and
the readiness check only asked “does the canonical file exist and parse”. It did.

## The invariants

1. **A placeholder is never real audio.** Any file produced by
   `audio/silence.js#generateSilentAudio` carries a sidecar marker
   `<canonical>.placeholder.json` (`kind: "animastor-placeholder"`). A marked file is never
   `ready`, never `already_ready`, never `already_done`, regardless of size, duration or DB
   status. The marker survives PG/Redis drift — which is exactly the failure mode.
2. **`ready` requires a fenced GPU commit of the current generation.** The evidence is the
   committed chunk artifact(s) of the scene on disk (`…_0001.mp3`, `…_0002.mp3`, …), produced by
   the staged→canonical publication of a GPU result. `validation.isSceneAudioCommitted()`
   requires:
   - the canonical file exists, parses, and is **not** marked as a placeholder;
   - at least one chunk file exists for the scene (all expected chunks when the count is known);
   - the PG asset record says `ready` (a committed chunk with a `stale`/`placeholder` record is
     still not ready).
3. **Nothing promotes a record to `ready` except the fenced-commit path.**
   `replacePlaceholderWithRealAudio()` requires an explicit `{ committed: true }` proof and
   refuses marked placeholders outright. The former “file is larger than 8192 B ⇒ register it as
   ready” safety branch is **removed**.
4. **The audio FSM `DONE` is not authoritative on its own.** `AUDIO_ALREADY_DONE` (and the stale
   `DONE` guard) only skip dispatch when the committed-audio probe passes; otherwise the DONE
   record is reset and the stage re-dispatches. Without this, one wrong `DONE` blocks every
   later command.
5. **Chunk records mirror files.** The `already_ready` fast path writes `audio_status: 'ready'`
   only for chunk files that exist on disk; it never fabricates progress for a chunk that no GPU
   produced.
6. **One predicate for "is this scene's audio real".** `placeholder-audio#hasRealAudio` — used by
   reconcile (asset-state rebuild), scene-window and scene-restoration to restore the `ready` fact
   — is `status === 'ready'` **and** `isSceneAudioCommitted(...).ready`. A `ready` row over an old
   placeholder that predates the marker (no sidecar, no chunks) is therefore not real audio
   either (integration A+B, 2026-11-04; `reports/2026-11-04/integration-A-B-C.md`).

The canonical copy of this document is animastor-docs `02-orchestration/AUDIO_READY_SEMANTICS.md`.

## Where each invariant lives

| Concern | File |
|---|---|
| Marker read/write | `backend/src/audio/placeholder-marker.js` |
| Marker written on silence | `backend/src/audio/silence.js` (`generateSilentAudio`) |
| Committed-audio probe | `backend/src/audio/validation.js` (`isSceneAudioCommitted`) |
| `already_ready` decision | `backend/src/audio/generation.js` (`generateSceneAudio`) |
| `ready` upgrade / placeholder creation / `hasRealAudio` | `backend/src/services/placeholder-audio.js` |
| Completion callback probe | `packages/animastor-orchestration/src/orchestration/scene-callbacks.js` |
| `AUDIO_ALREADY_DONE` guard | `packages/animastor-orchestration/src/orchestration/scene-orchestrator.js` |

## Data cleanup

Rows that were already promoted to `ready` over a placeholder are **not** flipped to
`placeholder` automatically. `scripts/fix-fake-ready-audio-20261104.sql` prepares (does not run)
a backed-up, reversible `status → 'stale'` update for the scenes found on 2026-11-04. It must run
**after** this fix is deployed: on the old code a `stale` record was still fast-tracked to ready,
because the old probe ignored the record.

## Failure modes this closes

- silent placeholder of any length (“larger than a 2 s placeholder ⇒ real audio”) — removed;
- a DB row lost/stale while the file survives — marker + committed chunk still refuse it;
- a cancelled/interrupted run that left `DONE` without chunks — the guard re-opens the stage;
- a regeneration command blocked by `already_done` for the whole session — same guard.
