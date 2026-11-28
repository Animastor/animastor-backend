# Changelog

## 2026-11-28 — удалена legacy-оркестрация (ветка `chore/remove-legacy-orchestration`)

Нормативно — `animastor-docs` `architecture/ORCHESTRATION_V2.md` §4.3, §11.3, §12 этап 4. Все книги — v2.

**Шаг 4 — развязка.** `workerHealth` перенесён в хост (`src/runtime/worker-health.js`), `GET /worker/counts`
работает без пакета (`active_scenes` в ответе — всегда 0). `isV2Book` / `book-flag` убраны: v2-ветки работают без
условия, legacy-ветки удалены (PUT layer-config, cancel-worker — vbook остаётся до задачи H, `DELETE /book/:id/cache`,
каскад удаления книги без хаба, progress-stream, window-generator, read-repair заглушек, generate API и голосовые
референсы без `409 book_not_v2`). Колонка `books.orchestration` (DEFAULT `'v2'`, CHECK) оставлена как след миграции.

**Шаг 7 — удаление.**
- `@animastor/orchestration` **2.0.0** (не опубликован — готов к публикации): удалён `src/legacy/`, корень экспортирует
  только `gen`, зависимостей нет, тесты — только `test/gen`. `gen.createCommand` больше не отвечает `book_not_v2`.
- `@animastor/editor` **0.6.0** (готов к публикации): `GET /book` без read-repair (заглушки + Redis-чанки),
  `read-recovery.cjs` удалён, `editorPorts` без `placeholderAudio` / `recoveryCtx`.
- `@animastor/player` **0.1.6** (готов к публикации): `GET /chunk/:id` без legacy-передиспетчеризации и без чтения
  `asset-state:*`; `state` / `activeScenes` из deps не читаются.
- `@animastor/installer` **0.2.12** (готов к публикации): `job-protocol-v2.cjs` убран из `WORKER_CONFIG_FILES`.
- Хост: удалены 8 адаптеров портов, `task-handler`, `audio-orchestrator`, `video-orchestrator`, `gpu-retry-policy`,
  `audio-recovery`, `stage-cancellation`, `cancel-scene-state`, `generation-progress`, `gpu-error-classifier`,
  `result-publication`, `publication-lock`, `scene-asset-registry`, `runtime-loop`, `gpu-dispatcher`,
  `orchestration-seams`, `queue-idempotency`, `redis-helpers`, `state/*`, `image/iu-processor`, `startup-resume`,
  `orchestration-v2/book-flag`, `contracts/runtime-result`, `storage/asset-registry`, репозитории `task-repo`,
  `generation-cancel-repo`, `iu-image-pointer-repo`.
- Вынесено живое: `runtime/worker-lanes.js` (поиск полос для v2), `helpers/chunk-store.cjs` (записи чанков для
  импорта и плеера), `services/book-snapshot.cjs`, `services/window-sessions-startup.js` (VBook-сессии на старте),
  `image/iu-workflow.js` (`buildIUWorkflow` для v2, `getSceneDuration` для плеера). Retry pending-purge и зеркало
  liveness воркеров в PG — на таймере composition root (60 с).
- Роуты: удалены `POST /gpu/task/result`, `POST /gpu/task/error`, `POST /debug/audio/recover`, вся
  `/debug/runtime/*`, `/debug/scene-states`, `/debug/asset-states`, `/debug/scene-events`, `/debug/asset-registry/*`.
  Хаб `DELETE /queue/clear` больше не вызывается. `/health` — без `loop`, поле `orch_v2`, 200 по Redis PING.
  `/metrics` — только метрики процесса.
- Слой IU `IU_IMAGE_VERSIONED` (pointer-таблицы) удалён: читатели `image/registry` отвечают как при выключенном флаге.
- PG: миграция `dropLegacyOrchestrationTables()` (`schema.js`) удаляет `generation_tasks`, `asset_states`,
  `generation_cancellations`, `reconciliation_events`, `cache_entries`, `asset_dependencies`, `output_manifests`,
  `iu_image_fence_reservations`, `iu_image_pointers`; живая строка → ошибка `legacy_tables_not_empty`, ничего не
  удаляется. Книги и `book_generation_sessions` не трогаются.
- Redis: `scripts/purge-legacy-redis.cjs` (dry-run по умолчанию, `--apply --confirm=<host:port/db>`,
  `--include-hub-v2`). Реестр `tests/architecture/redis-registry.js` сокращён до остатка (94 → 39 семейств).
- Тесты: удалены тесты удалённого кода; стражи переписаны; новый страж
  `tests/architecture/legacy-orchestration-removed.test.js`.

## 2026-11-28 — удалены legacy-эндпоинты генерации и импорта (ветка `chore/remove-legacy-endpoints`)

Нормативно — `animastor-docs` `architecture/ORCHESTRATION_V2.md` §11.3. Решение владельца 27.11: APK ≤ 0.3.4 не
поддерживаются.

- **Удалены роуты** (отвечают 404 стандартным обработчиком): `POST /api/v1/generate`, `POST /book/:id/generate-next`,
  `POST /book/load-vbook`, `POST /book/import-txt`, `POST /book/import-text`, `POST /book/:id/recover-placeholders`,
  `GET /book/:id/generation-state`, `GET /worker/status`, `POST /book/:id/regenerate`,
  `POST /book/:id/cancel-generation`, `GET /book/:id/progress-panel` — вместе с v2-обработчиками `regenerate`,
  `cancelGeneration`, `progressPanel` (`orchestration-v2/routes.js`) и `panel()` адаптера прогресса.
- **Удалены файлы:** `routes/book/progress-panel.cjs`, `routes/book/recovery-routes.cjs`,
  `services/regenerate-hub-sweep.cjs`. Оставлены живые: `routes/book/status-routes.cjs` (`/status` — web и Android,
  `/chapters-summary` — Android), `routes/book/iu-progress-utils.cjs` (`computeIuReady` → `@animastor/player`).
- **Оставлены до задачи H / шага 6:** `progress-stream`, `cancel-worker`, `bootstrap`, `bootstrap-next-window`,
  `resume-bootstrap`, `trigger-next-window`, `worker/counts`, `/gpu/task/*`. Импорт — единый `POST /book/import`.
- `no-store`: из регэкспа убраны `progress-panel` и `generation*`; `CREATE_BOOK_SUBPATHS` — только `import`, `blank`.
- Тесты: v2-интеграционные сьюты (`orch-v2-integration`, `-image`, `-video`) переведены на generate API v2
  (`tests/helpers/v2-generate.js`); тесты удалённых роутов удалены; страж `tests/removed-legacy-endpoints.test.js`.

## 2026-11-27 — LISTEN `gen_progress` переживает обрыв PG; no-store для `/book/:id/generate/*` (ветка `fix/gen-listen-nostore`)

- **`@animastor/orchestration` 1.4.3** (`packages/`, **опубликован**; `backend/package.json` → `^1.4.3` + lock,
  установлен из реестра — без ручной синхронизации `node_modules`): `listenProgress(onEvent, {onReconnect, onDisconnect, delaysMs})` —
  обработчик `'error'` на выделенном клиенте, `release(err)` + повторный `LISTEN` с паузой 1→2→5→10→30 с,
  `close()` останавливает переподключения; состояние — на получение клиента, а не на клиенте пула. Тест пакета
  `test/gen/listen-reconnect.test.js` (7).
- **Хост:** `orchestration-v2/index.js` передаёт колбэки — одна строка `[ORCH-V2] progress LISTEN lost: … —
  reconnecting` (warn) на обрыв, одна `[ORCH-V2] progress LISTEN restored — fresh progress sent for N book(s)` на
  восстановление; `progress-hub.resync()` рассылает подписчикам свежий агрегат (`reason:"resync"`) и текущие события
  старого `/progress-stream`. `host.progressListener()` — ручка слушателя (диагностика). Со старым ядром 1.4.2 второй
  аргумент игнорируется.
- **no-store:** `middleware/no-store.js` — `/book/:id/generate(/…)` (не `/generate-next`); `GET /book/:id/generate/progress`
  теперь `Cache-Control: no-store` без ETag (О1).
- **Тесты:** `orch-v2-generate-api` +1 (обрыв LISTEN через `pg_terminate_backend` → строка в лог, переподключение,
  SSE `resync` с командой, созданной во время обрыва, NOTIFY снова доходит; пропускается, если ядро в `node_modules` < 1.4.3)
  и заголовок `no-store` на реальном роуте; `no-store-headers` +5. Прогон `test-backend.sh --install-packages` на
  реестровом 1.4.3: 4380 passing / 29 pending / 0 failing, пакеты 10/10 (`test:gen` 94), страж `packages-published`
  зелёный (`@animastor/orchestration@1.4.3 (lock)`).

## Unreleased — generate API v2 (ADR ORCHESTRATION_V2 §11.1, этап 2 API; ветка `feat/generate-api-v2`)

Основание: `animastor-docs architecture/ORCHESTRATION_V2.md` §11.1–11.2, `reports/2026-11-26/legacy-removal-recon.md`
§2, §6.1, §8 шаг 1. Legacy-код и старые роуты не удалялись (шаг 5); пакет `@animastor/orchestration` не менялся (1.4.2).

- **Новые эндпоинты** (тонкие обёртки над теми же вызовами ядра, что и v2-ветка старых имён;
  `orchestration-v2/routes.js` `mountGenerateRoutes`, монтируются в `backend.cjs` после гарда
  `/api/v1/book/:bookId` — те же права, что у `/regenerate`; ошибки `{code, error}`):
  - `POST /api/v1/book/:bookId/generate` `{scope, layers, mode: "missing"|"all", client_action_id}` →
    `{command_id, existing, status, mode, layers, scope, summary, skipped_layers}`. `mode` по умолчанию
    `missing`, `all` = `force`; `client_action_id` обязателен (400 `client_action_id_required`), повтор → тот же
    `command_id`, `existing:true`, без новых работ. `scope.level`: `book|chapter|scenes|scene|unit` + хостовый
    `from_current_scene` (разворачивается в `scenes`, как у `/regenerate`); `unit_key` — синоним `unit_id`.
    Те же отказы, что у `/regenerate` v2: 422 `book_has_no_text`, 409 `layer_disabled`, `v2_image_unavailable`,
    `v2_video_unavailable`, `orch_v2_disabled`. `build_id` в ответе нет.
  - `POST /api/v1/book/:bookId/generate/stop` `{command_id}` | `{layer}` | `{}` — стоп команды (только своей книги:
    чужая → 404 `command_not_found`), слоя, всей книги (+ VBook-сессии, как `cancel-generation`).
  - `GET /api/v1/book/:bookId/generate/progress` — агрегат ADR §9: команды (активные + завершённые за 10 мин) ×
    слои (`queued/running/done/failed/cancelled/retrying`, `ready/total/percent`) × сцены, `mode`, `summary`,
    `skipped`, метки главы/сцены.
  - `GET /api/v1/book/:bookId/generate/stream` — SSE: `{type:"gen_progress", reason:"connect"|"notify",
    command_ids, progress}`; при подключении и переподключении — сразу свежий агрегат.
  - Legacy-книга → **409 `book_not_v2`** на всех четырёх.
- **Прогресс только через PG NOTIFY** (ADR §4.3/§9): `orchestration-v2/progress-hub.js` — один
  `LISTEN gen_progress` на процесс, раздача клиентам книги внутри процесса (агрегат для `/generate/stream`,
  прежние события для `/progress-stream`), склейка NOTIFY одной книги за `ORCH_V2_PROGRESS_COALESCE_MS`
  (150 мс). Redis pub/sub `animastor:progress:*` для v2 больше не публикуется (`publishProgress` из v2-хоста убран).
- **Старый `GET /progress-stream`** v2-книги берёт генерационные события из того же слушателя; Redis-подписка
  осталась для VBook/импорта (pipeline-runner, bootstrap) и legacy-книг и для v2-книги больше не закрывает поток
  при недоступном Redis. `/regenerate`, `cancel-worker`, `cancel-generation`, `progress-panel` — без изменений.
- **Тесты:** `tests/orch-v2-generate-api.test.js` (16: успех, повтор `client_action_id` (последовательный и
  параллельный), `missing`/`all`, `from_current_scene`, 400, `layer_disabled`, стоп ×3 + чужая команда, 409
  `book_not_v2` ×4, агрегат, SSE «работа завершена → событие», SSE при недоступном Redis (оба стрима),
  SSE-переподключение, старый стрим без Redis pub/sub, старые имена); `orch-v2-observability` — строка
  предупреждения в `progress-hub.js`. Прогон `scripts/test-backend.sh --install-packages`: 4374 passing / 29 pending /
  0 failing, пакеты 10/10.

## Unreleased — stage166: worker logs always reach the owner (WLOG-2) + workflow model names follow the manifests

Owner decision 2026-11-07; ADR `animastor-docs architecture/ORCHESTRATION_V2.md` §8.5.
Branch `feat/worker-logs-owner` merged via `release/stage166` into `main`; deployed in the stage166
release (migration WLOG-2 runs at backend start).

- **stage166 (A):** `backend/ai/workflows` model names follow the install manifests — `img-qwen-image`
  node `1010 LoraLoaderModelOnly.lora_name` → `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0-bf16.safetensors`;
  `video-ltx-{1,2,3,4}p` node `141 UnetLoaderGGUF.unet_name` → `LTX-2.3-22B-distilled-1.1-Q4_K_M.gguf`
  (HF API tree: `size 17763015328`, sha256 `cfebeb7ac973230d61f6f51ba668c236587571461a4f57c72bb6d71ce1f75fbd`
  = manifest `video/ltx-2.3.json`). Guarantee test `tests/workflow-model-names-manifest.test.js`: every
  model-file `*_name` of a manifested workflow must be a `filename` dependency of that manifest;
  manifest-less `old_*` workflows are an explicit list; known exceptions are `KNOWN_EXCEPTIONS`
  (TODO + report link), never a skipped suite. Manifests: only derived fields — `baseline_sha256`
  recomputed for 5 artifacts, `revision` `2026.08.27-r1` → `2026.11.07-r1`; `@animastor/installer`
  0.2.8 → **0.2.9** (registry `dist.shasum 5ebe25137e91365ebb209effb7b9e900dbfeab0c`).
- **stage166:** `backend/package.json` → `"@animastor/installer": "^0.2.9"` + lockfile
  (`integrity sha512-PM29ECk8H4r9Ahu165rLLlheXLptBjXyThYKk6EpWcEIQF0WXH2u5Olqe6g6tUu4TwnlUxhmweH6ouNB/J0Tqw==`);
  `npm ci` installs 0.2.9 from the registry (no local copy).
- `storage/postgres/schema.js`: **WLOG-2** — `workers.log_shipping` default → `TRUE`, plus a one-time
  `UPDATE … WHERE revoked_at IS NULL AND log_shipping = FALSE` (logged with the row count). The
  update runs only while the column default is still `FALSE`, so an operator's later `false` is
  never re-flipped on restart. The column stays as the kill switch: `false` → ingest answers `204`
  without writing a byte.
- `repositories/worker-repo.js`: `createWorker` no longer derives the initial value from the
  workspace owner's `role` — every new worker starts with `log_shipping = TRUE`.
- `tests/worker-logs.test.js`: defaults are `TRUE` for tenant, admin-owned and system workers; the
  kill switch is exercised explicitly (set `false` → `204` + nothing on disk); the WLOG-2 column
  default is pinned; the access matrix is pinned — workspace owner `200`, platform admin `200`,
  `users`-grant holder `404`, `public`-policy participant `404`, anonymous `401`, both for
  `GET /api/v1/workers/:id/log` and `POST /api/v1/workers/:id/request-log`.

## Unreleased — orchestration v2, stage 2a: images (IU) on the gen core for `books.orchestration='v2'`

ADR animastor-docs `architecture/ORCHESTRATION_V2.md` (§12 «2a», §13 п.9); recon
`ORCHESTRATION_V2_RECON_IMAGE.md`. Branch `orch-v2/2a-image`; not deployed. **Needs
`@animastor/orchestration` 1.1.0** (this repo, `packages/`): publish it, then bump
`backend/package.json` to `^1.1.0` + lockfile — until then the backend keeps 1.0.0 from the
registry and the image layer of a v2 book answers 409 `v2_image_unavailable` (fail-closed).

- **stage165:** `backend/package.json` → `"^1.1.0"` (registry shasum `40722394495eb15f313af9acac8ac7e36589c6d5`),
  lockfile resolves the 1.1.0 tarball with the registry integrity; the image layer of a v2 book
  runs on the gen core.

- `orchestration-v2/image-ports.js`: `planUnits(image)` — one `iu_image` per scene unit
  (`units[]` + `dialogue_blocks[].units[]`, legacy order), `unit_key` = unit id, payload = the
  workflow of `image/iu-processor.buildIUWorkflow` (extracted from `processSingleIU`, no behaviour
  change; same bytes as the legacy dispatch), `input.part_hash` = sha256 of that workflow,
  `input.scene_parts`; `artifactPath` = `{OUTPUT_DIR}/{build}/{book}_{ch}_{sc}_{unit}.png` (the
  canonical IU file every reader serves); `onArtifactPlaced` drops the stale preview `…_pr…png`.
  No side effects at planning (no `image_units`, no Redis).
- `orchestration-v2/index.js`: audio + image ports by kind; PNG check threshold
  `ORCH_V2_MIN_LUMA_STDDEV` (default 2.0); `imageUnsupportedReason()` — `IU_IMAGE_VERSIONED` on, or
  a core without `inspectPng` → image refused.
- `/regenerate` of a v2 book: `worker_types` ⊂ {audio, image, video}; video → no work,
  `summary.skipped_unsupported` + `skipped_worker_types`; only video → 409
  `v2_layer_not_supported_yet`; image unavailable → 409 `v2_image_unavailable`; unknown type → 400;
  `tasks[]` one row per layer; `skipped_worker_types` = requested layers the command does not run
  (video + disabled in layer-config); `layer_disabled` lists the requested layers.
  `cancel-worker {task_id}` → `cancelled` = the command's layers.
- `progress-adapter`: the image layer has no merge — `total` = planned IUs.
- Tests: `orch-v2-image.test.js` (fake image worker over HTTP + player read routes),
  `orch-v2-image-isolation.test.js` (every legacy image point), `orch-v2-integration` (video → 409).

## Unreleased — fix (legacy): `cleanBookRedisKeys` covers the legacy key families of a book

reports/2026-11-06/orch-v2-1d-release.md §18: after `DELETE /api/v1/book/<id>` a book generated
through the legacy path kept 35 Redis keys — `artifact-manifest` (TTL −1), `assets` (TTL −1),
`fence-journal`, `fence-publish`, `intent`, `dispatch-intent`, `idempotency:ref`,
`idempotency:stage-epoch`, `job`, `result-processed`, `dispatch-completed`, `cancelled-workers`.
`helpers/redis-helpers.cjs` now has a MATCH pattern for each family, scoped to THIS book id
(formats taken from the writers; book id glob-escaped, percent-encoded where the writer encodes it):

- `animastor:assets:{book}:*` (asset-registry, no TTL);
- `animastor:artifact-manifest|fence-journal|fence-publish|fence-unrecoverable:{enc(book)}:*`
  (`fence-unrecoverable` has the same durable shape as the manifest and was unreachable too);
- `animastor:intent:{enc(book)}:*`, `animastor:dispatch-intent:*:{enc(book)}_*`
  (the receipt is keyed by `dispatch_id` first, the book lives inside the encoded job id);
- `animastor:idempotency:stage-epoch:{enc(book)}:*`;
- `animastor:job:*:{book}_*` — the hub dedup key is `job:{dispatch_id}:{job_id}`, so the old
  `job:{book}_*` pattern could never match (that is why the §18 `job` keys survived);
- `animastor:result-processed:{book}_*`, `animastor:dispatch-completed:{book}:*`,
  `animastor:cancelled-workers:{book}`.

`animastor:idempotency:ref` is **not** a raw pattern: the ref is the ownership index of the
7-day completion marker (Stage 118 · B1), so it is released together with claim + marker by
`queue-idempotency.releaseClaimsForBook` — via the new `options.releaseClaims` of the helper,
passed only by `services/book-deletion.cjs` (the book is gone). The cache-clear route keeps the
default: it releases claims only AFTER the hub lane clear (Stage 116/118 ordering).

`book-deletion.cjs` re-arms `cancelled-workers:{book}` (1 h TTL) right after the purge, so the
cancellation signal still reaches a running VBook agent. Tests:
`tests/book-cleanup-legacy-key-families.test.js` (two books + a prefix-neighbour book; only the
deleted book reaches 0; no global pattern; glob escaping; paired ref/claim/marker release).

## Unreleased — orchestration v2, stage 1d: `@animastor/orchestration` 1.0.0 from the registry

- `backend/package.json`: `"@animastor/orchestration": "^1.0.0"` (published 2026-11-06, shasum
  `780370157265e203c84c8903f8d7e6ee3832ac18`); `backend/.npmrc` (`install-links`) removed; the lockfile
  resolves the registry tarball with its integrity. The image builds from the `./backend` context again.

## Unreleased — orchestration v2, stage 1c: tails of 1b (scope `from_current_scene`, cache clear)

ADR animastor-docs `architecture/ORCHESTRATION_V2.md` (§11.1, §13 п.8). Branch `orch-v2/1c`; not deployed.

- `/regenerate` of a v2 book with `scope: from_current_scene` (+ `chapter_id`, `scene_id`) is expanded
  in the route into `{level:'scenes', scene_ids}` — book order, from the current scene to the last one
  (the legacy `services/gen-scope.scopeBounds`); unknown scene → 404 `scene_not_found`, missing ids → 400.
  Core: `scope.level='scenes'` + migration `003-scope-scenes`.
- `DELETE /api/v1/book/:id/cache` of a v2 book never calls the hub (no `/queue/clear`, no legacy claim
  release): the book's gen commands / jobs are cancelled first (`orchV2.cancelBook`), then the cache is
  wiped; answer `{cleared, orchestration:'v2', hub_skipped, commands_cancelled, jobs_cancelled}`.
  Legacy books: unchanged.
- Tests: from_current_scene and cache clear (integration), window-generator isolation (legacy-isolation).
- Fix (legacy, stage 1d, owner decision): `services/window-generator.cjs` — `let chunkCount = 0;` was
  inside the comment line «— 3. Create chunks…» since 779cc3e, so a legacy book's next window threw
  ReferenceError right after `saveChunk` (no placeholder, no scene counters). Split into two lines; the
  isolation test's legacy control now expects the placeholders and the counters.

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
