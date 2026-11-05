# Changelog

## 0.3.5 (2026-11-05) — утечка квоты диспатча, reconcile не понижает закоммиченное

Основание: `reports/2026-11-05/live-check-A-B-C.md` §6, §10 и
`reports/2026-11-05/reconcile-quota-leak.md` (BA `ba_1788172242081`: «Вся книга» встала
после 4 сцен, `animastor:runtime:active-audio` = 8/8 без единого job, 13 сцен с
закоммиченным аудио сброшены в `stale`, строка в Генераторе пропала). Описание:
animastor-docs `02-orchestration/DISPATCH_QUOTA_AND_RECONCILE.md`.

### Fixed

- `dispatch-engine.dispatchStage`: исход executor'а `completed` **без jobs**
  (`already_done`, `recovered_via_completeChunk`, `cache_hit`, `scene_not_found`, …)
  теперь финализируется (`finalizeDispatch` outcome `success`, reason
  `completed_without_jobs:<reason>`) — meta + lease + занятый слот квоты снимаются одним
  Lua-claim. Раньше они висели до stale-lease recovery (~31 мин). Повторная финализация
  идемпотентна. Поле `completed` теперь возвращается наверх (планировщик считал такие
  исходы ошибками).
- `dispatch-engine`: после `dispatched:true` meta помечается `jobs_enqueued` (CAS-скрипт,
  без воскрешения уже финализированной meta).
- `scene-orchestrator`: `AUDIO_ALREADY_DONE` (DONE + коммит) завершает стадию через
  `completeStage` под живым dispatch (handler → version gate → PG ready + asset READY),
  а не просто «пропускает»; recovery `completeChunk` вызывается с живым `dispatchId`
  (раньше литерал `'stale-recovery'` → `COMPLETE-STAGE Rejected … stale_dispatch`).
- `reconciliation-engine` `RELEASE_STALE_LEASE`: стадия с подтверждённым коммитом
  текущего поколения (PG `ready` + `isSceneAudioCommitted`) не помечается DIRTY (нет bump
  эпохи и PG stale) — только освобождение lease/квоты и повтор READY в Redis.
- `counter-reconciliation`: перед сверкой — поиск фантомных диспатчей (lease+meta без
  `jobs_enqueued`, без job в хабе (`animastor:running` / `animastor:queue:*`), старше
  2 мин, замечен на двух прогонах подряд) → `cancelActiveDispatch` (`phantom_dispatch`);
  счётчик сверяется с оставшимися живыми lease.

### Added

- `runtime-scheduler`: backpressure при отсутствии живых воркеров типа в любом scope →
  `blockStageNoWorker` (задача `blocked`, «нет воркера»); исходы без движения
  (не dispatched / не completed / не capacity) копятся — ≥3 попыток и ≥5 мин →
  `command-gate.failStageNoProgress` (задача `failed`, `error_class=no_progress`,
  `error_code=<последняя причина>`).
- `worker-health.getAnyAliveCount`; `command-gate.noteNoProgress / clearNoProgress /
  failStageNoProgress`; `counter-reconciliation.sweepPhantomDispatches`;
  `reconciliation-engine.isStageCommittedReady`; `dispatch-engine.markDispatchJobsEnqueued`.

### Host contract (ломающее для хоста: новая обязательная операция порта)

- `ProgressEventsPort.failSceneStage(redis, bookId, chapterId, sceneId, type, info)` —
  объявлена в `OPS` (архитектурный guard O-5: каждая операция порта объявлена и живая);
  `setProgressEventsPort` без неё падает при старте. Backend-адаптер
  (`storage/progress-events-adapter.js`) её реализует в том же релизе — bump на 0.3.5
  только вместе с ним.

## 0.3.4 (2026-11-04) — 0.3.3 + «ready» аудио только при коммите GPU

Одна публикация вместо двух: 0.3.3 (уборка хаба при `/regenerate`, см. ниже) **не
публиковался** в npm отдельно и входит в 0.3.4 целиком. Основание:
`reports/2026-11-04/audio-placeholder-ready.md` (сцена `sc-4bb85e02` — тишина-заглушка
стала `ready` без GPU), интеграция: `reports/2026-11-04/integration-A-B-C.md`.
Описание инварианта: animastor-docs `02-orchestration/AUDIO_READY_SEMANTICS.md`.

### Changed (поведение)

- `scene-orchestrator.executeAudioDispatch`: `AUDIO_ALREADY_DONE` пропускает работу только
  если хост подтверждает коммит (`audio.isSceneAudioCommitted(...).ready === true`:
  канонический файл без маркера заглушки **и** чанки сцены на диске). Иначе — лог
  `AUDIO_ALREADY_DONE rejected … DONE without a committed audio chunk`, FSM-состояние
  удаляется, стадия идёт обычным путём (dispatch на GPU). То же — в safety-net ветке
  «stale `DONE`». Пробник недоступен или упал → считается «не закоммичено» (fail-closed:
  лишняя генерация безопасна, пропуск — нет).
- `scene-callbacks.handleAudioCompleted`: проверка после завершения — `isSceneAudioCommitted`
  (legacy `isSceneAudioReady` только если хост не дал нового пробника); в
  `replacePlaceholderWithRealAudio` передаётся `{ committed: true }` — хост без этого
  доказательства не поднимает запись в `ready`.

### Host contract (новое, обратно совместимо)

- `media.audio.isSceneAudioCommitted(buildId, bookId, chapterId, sceneId, expectedCount|null)`
  → `{ ready, reason, chunks, path }`. Backend ≥ интеграции A+B его даёт; на старом хосте
  пакет откатывается к file-only проверке.
- `placeholderAudio.replacePlaceholderWithRealAudio(…, realDuration, options)` — 7-й аргумент
  `options.committed`.

Инварианты 0.3.3 (sweep только своих dispatch-id, fail-closed book-wide sweep) не менялись;
fence, command-gate и retry-политика — тоже.

## 0.3.3 (2026-11-04, не публиковался — вошёл в 0.3.4) — /regenerate не сносит чужие задачи на хабе

Основание: `reports/2026-11-04/gpu-generation-stall.md` §5.3, §9.1 — `/regenerate`
одной сцены (audio) закончился `clearHubDispatches([], { book_id })` →
`DELETE /queue/clear?book_id=`; хаб удалил running-запись image-задачи другой
сцены (результат отклонён 409 и потерян) и queued-задачу (восстановлена
stale-lease recovery через 7 мин). Отчёт исправления:
`reports/2026-11-04/regenerate-sweep-fix.md`. Описание: animastor-docs
`architecture/COMMAND_ONLY_GENERATION.md` §«Уборка хаба при /regenerate».

### Changed (поведение)

- `dispatch-engine.clearHubDispatches`: book-scoped форма (пустой список id +
  `book_id`) — **fail-closed**: запрос `?book_id=` уходит только при явном
  `allowBookSweep: true`; иначе ни одного запроса, warn
  `book-wide GPU hub sweep … REFUSED`, результат `{requested:0, cleared:0,
  failed:0, refused:1}`. Per-id форма не менялась.
- `orchestrator.resetScenes` возвращает `dispatchIds` — dispatch-id,
  отменённые этим reset'ом (только сбрасываемые сцена×стадия); вызывающий
  повторно убирает на хабе только их.

Fence, command-gate и retry-политика не меняются.

## 0.3.2 (2026-11-02) — эпоха dispatch в audio-orch, без ложного FAILED

Основание: `reports/2026-11-02/gpu-e2e-installer-025-logs.md` §6.1, §8 п.3, п.5 —
состояние audio-orch отменённой попытки (11:09) пережило отмену, новый
dispatch (12:25) унаследовал его `started_at`, и watchdog через 28 с после
dispatch'а пометил здоровый прогон FAILED (`chunk_stall_timeout:4619s`), затем
`[FAIL-STAGE] Rejected … missing_dispatch_id` и `[INVARIANT] 1 audio-orch violations`.
Описание: animastor-docs `architecture/COMMAND_ONLY_GENERATION.md` §«Эпоха dispatch».

### Changed (поведение)

- `scene-orchestrator.executeAudioDispatch` открывает новую эпоху на каждом
  dispatch: `setWaitingChunks(…, { dispatchId, buildId, expectedCount })`.
  Хост пишет `started_at=now`, `dispatch_id`, `expected_count`,
  `chunks_received=0` и убирает `fail_reason`/`failed_at`/`last_chunk_at`
  прошлой попытки. Хост без поддержки 5-го аргумента ведёт себя как раньше.
- `reconciliation-engine.checkStalledAudioScenes`: запись проваливается, только
  если её `dispatch_id` равен живому `dispatch-meta` сцены. Запись без
  `dispatch_id` или другого dispatch — `stale_state_ignored` (одна info-строка
  на запись, не FAILED). `failWaitingScene` получает `dispatchId` записи.
- `orchestrator.failStage` без `dispatchId` → `{failed:false,
  reason:'stale_state_ignored'}` (info), а не `Rejected … missing_dispatch_id`.

Fence, command-gate (Stage 155) и retry-политика не меняются.

## 0.3.1 (2026-11-01) — результат GPU обрабатывается один раз

Основание: `reports/2026-11-01/gpu-audio-image-run-analysis.md`, P1 — каждый
результат обрабатывался дважды (HTTP-push hub → backend, затем Phase A
reconcile подбирал оставшийся `animastor:result:*` мимо
`animastor:result-processed:*`). Описание: animastor-docs
`architecture/GPU_HUB_CONTRACT.md` §«Result ACK».

### Changed (поведение)

- `reconciliation-engine.recoverResultKeys` (Phase A): перед
  `handleTaskResult` читает маркер `animastor:result-processed:{job}:{build}`.
  Значение `done:<dispatch_id>` того же dispatch, что в result-ключе, —
  ключ удаляется молча (без лога), handler не вызывается.
  Маркер `'1'` (в работе / старый формат), маркер другого dispatch
  (перегенерация audio/video в пределах TTL) или его отсутствие — как
  раньше, через fenced handler.
- Терминальный отказ (`no_active_dispatch` и др.) для дубля доставленного
  результата (маркер есть) — уровень info; для сироты (маркера нет) — warn.
- `orchestrator.resetScenes` вместе с `iu-progress` удаляет
  `animastor:iu-progress-ids:*` (множество IU×fence, хост task-handler).

Fence, dedup-ключ маршрута и command-gate (Stage 155) не меняются.

## 0.3.0 (2026-10-31) — генерация только по явной команде

Правило владельца: GPU-генерация запускается только кнопками «аудио» /
«картинки» / «всё»; никаких автозапусков следующих стадий и фоновых
запусков; задачи только на включённые слои. Основание — разбор
`reports/2026-10-31/auto-image-task-ba-incident.md` (§6, §8). Описание:
animastor-docs `architecture/COMMAND_ONLY_GENERATION.md`.

**Инвариант:** сцена×стадия попадает в active index / dispatch только при
активной задаче реестра (создана явной командой, стадия = type задачи), при
включённом слое и без отмены (cancel flag / tombstone).

### Added

- `runtime/command-gate.js` — единственная точка вычисления инварианта
  (`getAuthorizedStages`, `isStageAuthorized`), force-набор сцена×стадия,
  `rollbackGeneratingToDirty`, `blockStageNoWorker`. Экспорт
  `runtime.commandGate`.
- ProgressEventsPort: операция `blockSceneStage` (хост помечает команду
  blocked в реестре и PG).

### Changed (поведение)

- `active-scenes-index.addActiveScene` — запись в active index только при
  авторизованной стадии; иначе `{ added:false, denied:true }`.
- `runtime-scheduler.shouldScheduleAssets` — стадии только по гейту; убраны
  fallback на layer-config без задачи и `isInFlight`-override.
- `runtime-scheduler.tick/attemptDispatch` — force только для сцен×стадий
  команды (ключ `animastor:force-dispatch-stages:<book>`, вместо книжного
  `animastor:force-dispatch:<book>`); `no_worker_available` → стадия blocked
  (GENERATING → DIRTY, задача blocked), без автоповтора.
- `markVersionStaleDirty` — только помечает stale, в работу не ставит.
- `orchestrator.resetScenes` — пишет force-набор вместо книжного флага.
- `scene-orchestrator.dispatchStage` — NEW-сцена переводит в PENDING только
  диспатчимую стадию; при `no_worker_available` откат в DIRTY, не PENDING.
- `reconciliation-engine`:
  - удалены `PROGRESS_TO_IMAGE` / `PROGRESS_TO_VIDEO`; partial build — только
    диагностика;
  - `REGENERATE_MISSING_ASSET`, `MOVE_TO_PENDING`, `RELEASE_STALE_LEASE`,
    перезапуск аудио в `RECOVER_ORPHAN_ASSETS` — только под активной командой
    стадии, иначе диагностика; осиротевший GENERATING без команды → DIRTY;
  - C5 вызывает `deps.interruptIncompleteSessions` (возобновления нет);
  - C8 `rebuildWorkList` пересобирает только факты asset-state, PENDING и
    active index не пишет.
- `scene-window.startScene` — без авторизованной стадии сцену не стартует;
  `trySlideWindowOnComplete` — за флагом хоста `windowAutoNextEnabled()`
  (по умолчанию выкл.).
- `dispatch-engine.repairOrphanGeneratingStates` — опция `target: 'dirty'`.

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
