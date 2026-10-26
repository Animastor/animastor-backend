# Stage 143a — Phase 2. Аудит потребителей и план адаптации (исследование)

**Тип:** только исследование. Код, схема, миграции, конфигурация **не изменялись**; коммитов, push, merge, deploy нет.
**Checkpoints:** `stage143a-checkpoint.md` (разделы D, F) — **не переписан**, этот файл существует отдельно.
**Флаг `IU_IMAGE_VERSIONED`: остаётся OFF.** Phase 2 и включение флага — не разрешены этим документом.

## 0. Проверка исходного состояния (задача 1)

| Проверка | Результат |
|---|---|
| Ветка | `stage143a-foundation-phase1` (сверена с `git rev-parse --abbrev-ref HEAD`) |
| HEAD | `f4afa761c266ed9effac8c135f5a46c9af9502e6` |
| Phase 1 | `fef58927` «feat(stage143a): versioned iu_image foundation (phase 1)» — 13 файлов (лимит соблюдён) |
| Документация | `f4afa761` «docs(stage143a): Phase 1 implementation results in checkpoint» — только `stage143a-checkpoint.md` |
| Родитель Phase 1 | `b38f12ba` (main-линия stage 141) |
| Dirty-файлы рабочей копии | `backend/scripts/audit-orphan-books.js` (D), `backend/src/routes/book/generation-routes.cjs` (M), 6 тест-файлов (M), `packages/animastor-orchestration/src/runtime/dispatch-engine.js` (M), untracked `deploy/` и `freebuff-chat-2026-10-11T07-41-12.445Z.md` — **не тронуты, не инспектировались содержательно, не входят в scope Phase 2** |
| Отличие рабочей копии от HEAD | `git diff --stat` = ровно перечисленные 8 файлов (те же, что в исходной постановке) |

## 1. Публичные интерфейсы Phase 1 для чтения текущего опубликованного path/version (задача 2)

### 1.1 Репозиторий (единственный владелец SQL, guardrail PG-1/PG-5)
`backend/src/storage/postgres/repositories/iu-image-pointer-repo.js`:

| Символ | Строка | Сигнатура / семантика |
|---|---|---|
| `versionedEnabled()` | L42 | чтение `IU_IMAGE_VERSIONED` (1/true/on/yes); **все** читатели рано возвращаются при OFF → 0 PG-запросов |
| `getIuImagePointer({bookId,chapterId,sceneId,iuId,buildId})` | L264 | → `{path, publishFence}` \| `null`. `path` — **относительный** (`{build}/.versions/{assetId}/{fence}.png`), только `resolveOutputPath` даёт абсолютный |
| `listPublishedIuIds({bookId,chapterId,sceneId,buildId})` | L276 | → `string[]` (готовность стадии) |
| `listScenePointerPaths({...,limit=50})` | L287 | → `[{iuId, path}]`, `ORDER BY publish_fence DESC` (доказательство сцены) |
| `resolveOutputPath(outputDir, relPath)` | L78 | path safety: traversal/absolute/NUL/symlink escape → `{ok:false,reason}` |
| `versionedRelPath` / `stagingRelPath` | L115 / L124 | `{build}/.versions/{assetId}/{fence}.png`, `{build}/.staging/{assetId}/{fence}.tmp` |

**Отсутствует в Phase 1 (потребуется в Phase 2):** листинг указателей на весь build (для storyboard-export). См. §3.5.

### 1.2 Фасад (единственный путь для контуров orchestration/player)
`backend/src/image/image-service.js:44–51` re-export'ит из `backend/src/image/registry.js`:

| Метод | Строка | Семантика |
|---|---|---|
| `resolveIuImagePath(OUTPUT_DIR, buildId, b, c, s, iuId)` | registry.js:77 | flag OFF → `null` сразу (0 PG); иначе pointer → `resolveOutputPath` → `existsSync` → `{path, fence, relativePath}`; **no row → `null`, missing file → `null`, PG error → throw** |
| `resolveVersionedSceneProof(OUTPUT_DIR, buildId, b, c, s)` | registry.js:105 | legacy-скан уже сделан вызывающим; возвращает первый безопасно резолвимый и существующий на диске pointer сцены, иначе `null`; PG error → throw |

Точки подключения:
- orchestration: `lazyHostBinding('media.image')` — `reconciliation-engine.js:159`, `scene-callbacks.js:19`, composition root `backend/src/backend.cjs:146` (`media.image: require('./image')`);
- player: инжектированный `deps.image` — `iu-media.cjs:14`, вызов `image.resolveIuImagePath(...)` (`iu-media.cjs:278–279`), allowlist require **не расширялся**;
- host-модули backend: прямой `require('../storage/postgres/repositories/iu-image-pointer-repo')` (репозиторий, не «сырой» handle → sql-boundary не нарушается; `backend/src/image/iu-processor.js:197` — прецедент из Phase 1).

### 1.3 Что Phase 1 уже адаптировал (для сверки с разделом D checkpoint)
task-handler (счётчик стадии = union канонических имён и `listPublishedIuIds`, L384–390), iu-processor (pointer-aware cache-hit L195–212), scene-callbacks (`handleImageCompleted` proof fallback L280–290), iu-media (`/iu-image` pointer-first + ETag L273–292), cache-routes GC (L105+), gpu-dispatcher (резервирование), schema/репозиторий.

## 2. Методика и общий шаблон минимального изменения

Для всех потребителей действует один паттерн (зафиксирован Phase 1, guardrails его принимают):

1. **Сначала legacy-скан/legacy-путь** (как сегодня) → при флаге OFF поведение побайтно прежнее, PG не вызывается вообще.
2. **Только если legacy-скан пуст и `versionedEnabled()`** → асинхронный запрос доказательства через фасад (`resolveVersionedSceneProof` / `resolveIuImagePath`) или, для host-модулей backend, через репозиторий + `resolveOutputPath` + `existsSync`.
3. **`typeof`-guard** на фасад-методы (тестовые стабы и старые host-биндинги не ломаются).
4. **PG-ошибка ≠ «нет публикации»:** чтение падает → потребитель обрабатывает явно (fail-closed: не выдавать READY, не «чинить» ложный orphan), ни в коем случае не трактует как «файла нет, регенерировать молча» без лога.

**Расхождение контракта, требующее решения владельца (см. §5, B1):** фасад сейчас схлопывает три разных состояния в `null` — «строки нет», «строка есть, файл отсутствует/повреждён», «legacy тоже пуст». Инвариант «повреждённый versioned-файл не должен приводить к ложному READY / выдаче устаревших байтов» в общем виде **не выполняется** без различения этих состояний (например, `iu-media.cjs:273–292` при pointer+битом файле молча падает в legacy-ветку и может отдать устаревшие канонические байты). Требуется решение: fail-closed (404/5xx при flag ON + существующей строке) или явно задокументированный legacy-фолбэк.

## 3. Таблицы по потребителям (задача 4)

### 3.1 `packages/animastor-orchestration/src/runtime/reconciliation-engine.js` (D#7, D#8 + одна незадокументированная точка)

| Пункт | Содержание |
|---|---|
| **Текущая логика** | (a) `checkOrphanImageState` L147–177: state image READY/PLACEHOLDER + `image.resolveCanonicalSceneImage(...)` (L160) → `null` → issue `orphan_image_state` → `getFixRecommendations` L1047–1052 `REGENERATE_MISSING_ASSET, safeToExecute:true`. (b) `checkOrphanAssets` L229–268: `assets.image.path && assets.image.ready` → `fs.access` (L250–253) → `missing_image_file` (L254). (c) **не в checkpoint:** `rebuildWorkList` L2262→L2367: `sceneWindow.getSceneFilesStatus(...).image.exists` → `fileValid` → иначе `AssetState.PENDING` (L2380–2386) |
| **Точка несовместимости** | L160 (canonical scan), L250 (`fs.access` по legacy-строке `scene_assets`/Redis), L2367 (через scene-window, см. §3.2) → versioned-only сборка: `null`/ENOENT → **ложная регенерация** и/или массовый PENDING |
| **Минимальное изменение** | (a) после `null` от canonical-скана: `if (!sceneImage && typeof imageModule.resolveVersionedSceneProof === 'function') sceneImage = await imageModule.resolveVersionedSceneProof(artifactRoot(), buildId, b, c, s)` — тот же паттерн, что уже в `scene-callbacks.js:286–292`. (b) перед выпуском `missing_image_file` при flag ON — проверить pointer сцены/билда; есть строка и файл жив → issue не выпускать. (c) лечится автоматически правкой `getSceneFilesStatus` (§3.2) — отдельная правка не нужна |
| **Пустой pointer + legacy-файл** | флаг OFF: без изменений (0 PG). флаг ON: legacy-скан уже вернул файл → доказательство есть → issue не выпускается |
| **Существующий pointer** | фасад возвращает путь → orphan/missing не выпускаются → ложные регенерации прекращаются |
| **Отсутствующий/повреждённый versioned-файл** | `resolveVersionedSceneProof` пропускает битые строки → `null` → issue по legacy → если legacy тоже нет → `regenerate_image` (**корректно**, fail-closed). Если строка есть, файл миссинг, а legacy-файл лежит — сейчас берётся legacy-доказательство → потенциальный ложный READY (см. §5, B1) |
| **PG-ошибка** | `resolveVersionedSceneProof` бросает → верхний try/catch `reconcile*` (L1021–1024) гасит проход → регенерации не запускаются (fail-closed, приемлемо; требуется лог) |
| **Регрессионные тесты** | `backend/tests/reconciliation-engine.test.js` (L305–322: оба кейса orphan_image_state), `backend/tests/image-orphan-generating-repair.test.js` (L656), `packages/animastor-orchestration/test/artifact-root-binding.test.js` (L103–146); **новые**: flag OFF → 0 вызовов фасада; flag ON + pointer → нет orphan; pointer+битый файл → нет READY; PG error → нет orphan |

### 3.2 `packages/animastor-orchestration/src/runtime/scene-window.js` (D#9 — единая точка правды)

| Пункт | Содержание |
|---|---|
| **Текущая логика** | `getSceneFilesStatus` L141–168: `image.exists = files.some(f => f.startsWith(iuImagePrefix) && f.endsWith('.png'))` (L157–158). Потребители: `checkSceneContentCache` L178/L206 (advisory для dispatch), `restoreChunkStatusForScene` L314/L323 (запись `image_status:'ready'`), `reconcileWindowStatuses` L565/L591 (pending→ready), `packages/.../scene-restoration.js:28`, `reconciliation-engine.js:2367` |
| **Точка несовместимости** | L157–158 — единственный источник `image.exists` для **пяти** вызывающих |
| **Минимальное изменение** | В `getSceneFilesStatus` (уже `async`): после пустого legacy-скана — `lazyHostBinding('media.image')` + `typeof`-guard + `await resolveVersionedSceneProof(config.OUTPUT_DIR / hostBinding('artifactRoot'), buildId, b, c, s)` → `result.image.exists = true`. Одна правка закрывает D#9, D#10-часть и (c) в §3.1 |
| **Пустой pointer + legacy** | без изменений (legacy-ветка первой, 0 PG при OFF) |
| **Существующий pointer** | `image.exists=true` → advisory валиден, `restore/reconcile` пишут ready, worklist не помечает PENDING → дубли dispatch исчезают |
| **Отсутствующий/повреждённый versioned-файл** | фасад вернёт `null` → `image.exists=false` → conservative: chunk не ready, worklist → PENDING (без ложного READY); возможен ложный PENDING при живом legacy — преемлемо для advisory, фиксируется в §5 |
| **PG-ошибка** | рекомендация: `try/catch` в `getSceneFilesStatus` → лог + `false` (трактовать как «доказательства нет», НЕ как «файл есть»); проброс наверх сломает `restoreChunkStatusForScene` (L323 без try) |
| **Регрессионные тесты** | `backend/tests/happy-path.test.js` (Д.3: L2015, L2040, L2070, L2096, L2136), `backend/tests/image-ghost-no-jobs-sent.test.js` (L715–723), `packages/.../artifact-root-binding.test.js`; **новые**: flag ON+pointer → ready/valid; flag OFF → побайтно прежний результат и 0 PG |

### 3.3 `backend/src/helpers/redis-helpers.cjs` (D#10)

| Пункт | Содержание |
|---|---|
| **Текущая логика** | `recoverChunksFromDisk` L176–230: gated только наличием scene-mp3 (L186); `hasIuImages` = диск-скан `scenePrefix*.png` (L190–193); безусловный `unsafeRestoreAssetStates({audio,image,video: READY})` (L201–206); chunk `image: hasIuImages`, `image_status: hasIuImages?'ready':'pending'` (L222–223). Вызывается из `recoverAllBooksFromDisk` (L240–335) c registry-gate |
| **Точка несовместимости** | L190–193: versioned-only → `hasIuImages=false` → чанк `image=false/pending` → `/assets-state` недоcчитывает, recovery не восстанавливает image |
| **Минимальное изменение** | L193: `hasIuImages = legacyScan \|\| (flag ON && у сцены есть pointer с живым файлом)` — host-модуль: `require('../storage/postgres/repositories/iu-image-pointer-repo')` + `listScenePointerPaths` + `resolveOutputPath` + `existsSync`; обернуть в `versionedEnabled()` (0 PG при OFF) |
| **Пустой pointer + legacy** | без изменений |
| **Существующий pointer** | `hasIuImages=true` → chunk ready, счётчики `/assets-state` корректны |
| **Отсутствующий/повреждённый versioned-файл** | строка есть, файл миссинг → не засчитывать (fail-closed: `pending` → поздний re-dispatch), не `ready` |
| **PG-ошибка** | `try/catch` → `hasIuImages = legacyScan` + `console.warn` (recovery не должен падать; ложного READY не возникает, т.к. legacy-скан уже был) |
| **Регрессионные тесты** | `backend/tests/startup-recovery-registry-gate.test.js` (gate не трогаем); **новые**: recover при flag OFF (0 PG, прежний результат), flag ON+pointer (ready), pointer+битый файл (pending), без аудио-файла (сцена по-прежнему skip) |

### 3.4 `backend/src/image/preview.js` — `getOrCreatePreview` (D#11)

| Пункт | Содержание |
|---|---|
| **Текущая логика** | L12–49: names из `makeIUImageFilename`/`makePreviewFilename`; обход `{OUTPUT_DIR}/*` (запрошенный build первый, затем все остальные), `existsSync(preview)` → вернуть, иначе `existsSync(source)` → `sharp` resize → запись; иначе `warn('preview source not found')` → `null` → роут `/api/v1/preview/...` (`iu-media.cjs:300–310`) → **404** |
| **Точка несовместимости** | L26–38: источник ищется только по каноническому имени → versioned-only источник не найден → превью 404 (для web/android thumbnail'ов) |
| **Минимальное изменение** | В конец цикла (после legacy-обхода, чтобы флаг OFF не менял порядок): при flag ON → `registry.resolveIuImagePath(config.OUTPUT_DIR, buildId, b, c, s, iuId)` (host-модуль, прямой require registry) → source = `resolved.path`, превью пишется в **канонический** `previewPath` билда (производный кэш, в pointer-схему не входит) |
| **Пустой pointer + legacy** | legacy-обход первым → результат идентичен сегодняшнему (и при OFF — 0 PG) |
| **Существующий pointer** | источник найден → превью создаётся из опубликованных байтов → 404 устранён |
| **Отсутствующий/повреждённый versioned-файл** | `resolveIuImagePath` → `null` → legacy-обход → если пусто → `null` → 404 (без ложного превью) |
| **PG-ошибка** | исключение из фасада выходит из `getOrCreatePreview` → роут `iu-media.cjs:311` (`catch` → 500) — fail-closed, приемлемо |
| **Ограничение (зафиксировать)** | имя превью не зависит от fence: после инверсии фенса старое превью живёт до удаления (существующий `oldPreview`-unlink в `iu-processor.js:274–281` покрывает dirty-regen). Вариант «имя превью с fence» — отдельное решение, вне минимального scope |
| **Регрессионные тесты** | тестов превью в репозитории **нет** (grep: только упоминания `makePreviewFilename` в `player-route-split.test.js:364`) → **новый** `backend/tests/preview-versioned.test.js`: 4 кейса по таблице + `X-Preview-Created` и 404 |

### 3.5 `backend/src/routes/book/export-routes.cjs` — `/storyboard` (D#12)

| Пункт | Содержание |
|---|---|
| **Текущая логика** | L73–95: `dir = OUTPUT_DIR/{buildId}`; `pngs = readdirSync(dir).filter(f => startsWith(`${bookId}_`) && endsWith('.png'))` (L82–84); 0 файлов → 404 `no storyboard images to export`; иначе `zip.addLocalFile` |
| **Точка несовместимости** | L82–84: versioned-файлы лежат в `{build}/.versions/{assetId}/{fence}.png` (подкаталог, скрытый от плоского скана) → zip пуст/неполон → 404 или потеря кадров |
| **Минимальное изменение** | (1) **новый reader** `listBuildPointerPaths({bookId, buildId, limit})` в `iu-image-pointer-repo.js` (SQL: `SELECT iu_id, path FROM iu_image_pointers WHERE book_id=$1 AND build_id=$2 ORDER BY publish_fence DESC LIMIT $3`) — это расширение репозитория, а не retro-расширение Phase 1; (2) union: legacy-скан ∪ (flag ON → pointer-строки, `resolveOutputPath` + `existsSync`, имя в zip = `{iu_id}.png` — `iu_id` уже является `assetId` вида `{book}_{ch}_{sc}_iu-N`); (3) при PG-ошибке → legacy-only + `log` (экспорт — read-only, availability предпочтительнее 500; ложного READY это не создаёт) |
| **Пустой pointer + legacy** | union = legacy → побайтно прежний zip |
| **Существующий pointer** | файлы попадают в zip (включая свежайший fence), legacy-дубликаты исключаются/дедуплицируются по имени |
| **Отсутствующий/повреждённый versioned-файл** | пропустить entry + `log` warn (не битый zip, не 500); если после этого 0 файлов → существующая 404 |
| **PG-ошибка** | см. выше: legacy-only + warn |
| **Регрессионные тесты** | тестов `/storyboard` **нет** → **новый** `backend/tests/export-storyboard-versioned.test.js`: flag OFF → тот же список; union; битый pointer пропущен с warn; 0 → 404; `/download` (.vbook) и `/export` (video) — контроль «не тронуты» |

### 3.6 D#13, D#16, D#17, D#18, D#19, D#20 — без изменений (подтверждено)
`/download` (.vbook) — `BOOKS_DIR`, не `OUTPUT_DIR`; generation-routes callback — цепочка приёма перенесена в `task-handler.cjs` (Phase 1, чтобы не ломать require-базисную линию); gpu-dispatcher — уже с резервированием; audio-recovery — только audio; result-publication — legacy-потоки; debug-routes replay — идёт через тот же writer.

## 4. Потребители, не учтённые в checkpoint (задача 5)

| # | Файл:строки | Что делает | Последствие при flag ON (versioned-only) | Приоритет |
|---|---|---|---|---|
| N1 | `packages/animastor-orchestration/src/orchestration/scene-callbacks.js:340–348` | очистка `dirty_unit_ids`: `fs.existsSync(sceneImageName(...))` по каноническому имени | **P1 — петля:** uid не подтверждается → `setDirtyUnitIds` не чистит → на каждом проходе `force=true` (`iu-processor.js:199`) → бесконечная регенерация | Phase 2a |
| N2 | `scene-callbacks.js:351–362` | сброс счётчика `animastor:iu-progress:*` по диск-скану | счётчик не сбрасывается (checkpoint D#6 помечен «ADAPT phase 1», но Phase 1 этот код **не трогал** — расхождение план/факт) | Phase 2a (нефатально) |
| N3 | `packages/animastor-player/src/iu-media.cjs:67–87` | auto-redispatch: `c.image && !existsSync(sceneImageName)` и пустой iuPrefix-скан → сброс `c.image=false` + `del jobKey` + re-add active scene | **P1 — петля redispatch** (D#14 помечен «ADAPT phase 1», Phase 1 менял только роут `/iu-image` L273–292 — расхождение) | Phase 2a |
| N4 | `iu-media.cjs:97–110` | `image_ready` в `/api/v1/chunk/:id` (state → disk → iuPrefix-скан) | клиент видит `image_ready:false` → спиннеры/повторные запросы | Phase 2a |
| N5 | `backend/src/routes/book/generation-routes.cjs:552–561` | cover-сцена: `files.length >= iuCount` по каноническому скану → иначе prepend в dirty | cover регенерируется **каждый** `/regenerate` whole_book (лишние GPU-задачи) | Phase 2b |
| N6 | `packages/animastor-player/src/playback-queue.cjs:209–216` | boost `cover_iu_ready` диск-сканом | недоcчёт прогресса обложки (advisory, API-поле `cover_iu_ready`) | Phase 2c |
| N7 | `packages/animastor-player/src/scene-data.cjs:50–58` | `imageReady` fallback диск-сканом для `/scene/...` статуса | клиентская статус-строка «не готово» (player-контур → только через фасад `image`, allowlist не расширять) | Phase 2c |
| N8 | `backend/src/image/iu-processor.js:266–303` | dirty-regen: `unlink(oldPng)` + `unlink(oldPreview)` | no-op на каноническом (`.versions/` не трогается — immutable в безопасности); **удаление превью корректно** | Phase 2b (минимально: оставить как есть + задокументировать) |
| N9 | `backend/src/storage/filesystem-store.js:193–210` `probeIUImage` | дублирующий legacy-пробник, вызывается только из экспорта + архитектурных тестов | не влияет; **не трогать** (архитектурные тесты держат сигнатуры) | вне scope |
| N10 | `reconciliation-engine.js:2216` | ссылка на `services/startup-recovery.js` — файла не существует (recovery живёт в `redis-helpers.cjs`) | устаревший комментарий (безопасно) | вне scope (docs) |

Проверка полноты: `grep endsWith('.png')` по `backend/src` + `packages/*/src` даёт 13 строк — все учтены (registry L51, export L83, generation-routes L557, redis-helpers L193, task-handler L388 [Phase 1], scene-callbacks L355, scene-window L158, scene-data L57, iu-media L73/L105, playback-queue L212, scene-media L39/L94 [сцен-уровень — **вне scope по инвариантам**]).

## 5. Инварианты и guardrails (задачи 6)

### 5.1 Совместимость с guardrails — ДА, нарушений не выявлено
| Guardrail | Статус для Phase 2 |
|---|---|
| PG-1/sql-boundary | Phase 2 добавляет **0** новых `require('storage/postgres/database')`; новые обращения идут через `iu-image-pointer-repo` (репозиторий) |
| PG-5 (DDL только в schema.js) | Phase 2 **не создаёт** таблиц/индексов — новых DDL не требуется (`listBuildPointerPaths` — только SELECT) |
| Player require-allowlist / player-route-split | player-файлы работают через инжектированный `deps.image` (`typeof`-guard); allowlist не расширяется |
| §32.30 host bindings (orchestration) | `reconciliation-engine`/`scene-window`/`scene-callbacks` достигают PG **только** через `lazyHostBinding('media.image')` — новых `require` в пакет не добавляется |
| Immutable-файлы / публикация / fencing | Phase 2 — **read-only**: ни одного `unlink` в `.versions/`, правил публикации и `publish_fence <= EXCLUDED` не трогаем |
| Scene-level image / audio / video | `scene-media.cjs`, `probeSceneImage`, audio/video recovery — не изменяются |
| Flag OFF контракт | каждый новый вызов расположен **после** legacy-ветки и/или за `versionedEnabled()` → при OFF 0 PG-запросов; `stage143a-flag-off.test.js` (149 строк) остаётся верификатором |
| Dirty-файлы рабочей копии | не входят в scope; правки их не затрагивают |

### 5.2 Блокеры до включения флага
- **B1 (контрактный):** фасад не различает «нет строки» / «строка есть, файл битый/отсутствует» → инвариант «legacy не маскирует versioned-публикацию» и «битый файл не даёт ложный READY/устаревшие байты» не обеспечивается в общем виде (проявление: `iu-media.cjs:283–292` fallback на legacy при битом target). Требуется решение владельца: fail-closed vs задокументированный fallback (Phase 1-файлы `registry.js`/`iu-media.cjs` править **после** решения, не задним числом).
- **B2 (корректность, P1):** N1 (dirty-unit петля) и N3 (redispatch петля) — без их правки включение флага даёт бесконечные регенерации.
- **B3 (масштаб):** подтверждённый scope §4+§3 — 9–11 реализационных файлов и 5–6 новых тест-файлов; это заметно больше «~5 файлов» из checkpoint §D (там не учтены N1–N7 и новый build-level reader).

### 5.3 Прочие риски
- `listScenePointerPaths(limit=50)` — для сцены с >50 IU доказательство существует (любая строка), но для **полного** подсчёта/экспорта нужен build-level листинг с явным лимитом и логом при усечении.
- `resolveVersionedSceneProof` ищет первый существующий файл — для «proof of completion» достаточно; для «все IU опубликованы» использовать `listPublishedIuIds` (уже есть).
- Тестовая инфраструктура Phase 1 (изолированный PG 127.0.0.1:55432 / Redis 56379) для Phase 2 потребуется снова; в этой исследовательской задаче **тесты не запускались** (ничего не менялось).

## 6. Поэтапный план Phase 2 (задача 7)

Оценка scope по подэтапам (реализация — **только после отдельного разрешения**):

**2a — P1-петли (предусловие включения флага), 4 файла + 2–3 тест-файла**
1. `packages/animastor-orchestration/src/runtime/scene-window.js` — pointer-aware `getSceneFilesStatus` (единая точка: закрывает D#9, §3.1(c), часть D#10).
2. `packages/animastor-orchestration/src/runtime/reconciliation-engine.js` — fallback в `checkOrphanImageState` + guard в `checkOrphanAssets`.
3. `packages/animastor-orchestration/src/orchestration/scene-callbacks.js` — подтверждение dirty-unit по `resolveIuImagePath` + счётчик из `listPublishedIuIds` (N1, N2).
4. `packages/animastor-player/src/iu-media.cjs` — auto-redispatch и `image_ready` объединяются с фасадом (N3, N4).
   *Тесты:* `happy-path` (Д.3), `reconciliation-engine`, `image-orphan-generating-repair`, `image-ghost-no-jobs-sent`, `artifact-root-binding`, новый `stage143a-phase2-readers.test.js` (flag OFF 0 PG / flag ON pointer / битый файл / PG error).

**2b — recovery и dispatch-адвизоры, 3 файла + 1–2 тест-файла**
5. `backend/src/helpers/redis-helpers.cjs` — `hasIuImages` из pointer'ов.
6. `backend/src/routes/book/generation-routes.cjs` — cover-скан (N5); файл **dirty в рабочей копии** → правка только после разрешения работы с dirty-файлами (иначе переbase/merge-конфликт с локальными изменениями).
7. `backend/src/image/iu-processor.js` — документированное поведение `oldPng`/`oldPreview` в versioned-ветке (N8, минимально).
   *Тесты:* новый `redis-recovery-versioned.test.js`, cover-кейс в существующем regenerate-тесте.

**2c — read-only представление, 4–5 файлов + 2 тест-файла**
8. `backend/src/image/preview.js` — pointer-источник (D#11).
9. `backend/src/routes/book/export-routes.cjs` + `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js` (`listBuildPointerPaths`) (D#12).
10. `packages/animastor-player/src/playback-queue.cjs`, `packages/animastor-player/src/scene-data.cjs` (N6, N7).
   *Тесты:* `preview-versioned.test.js`, `export-storyboard-versioned.test.js`, player-статусные кейсы.

**2d — (отдельное разрешение) решение B1 + включение флага:** правка fail-closed семантики в `registry.js`/`iu-media.cjs` (2 файла), затем включение `IU_IMAGE_VERSIONED` в staging → soak → production. **Merge в main и deploy — отдельно.**

Итого подтверждённый scope: **9–11 impl-файлов + 5–6 тест-файлов** → разделение на 2a/2b/2c обязательно; расширять Phase 1 задним числом нельзя (13-файловый лимит фиксирован коммитом `fef58927`).

## 7. Открытые вопросы владельцу
1. B1: fail-closed (pointer есть → только versioned-байты) или задокументированный legacy-fallback при битом target?
2. Разрешить правку dirty-файла `generation-routes.cjs` в 2b или вынести cover-скан в отдельную ветку?
3. Имя превью с fence (инвалидация) — в scope 2c или отдельно?
4. Лимит/усечение build-level листинга для экспорта (ограничение `LIMIT` + warn).

---

**Статус:** исследование завершено. Реализация, коммиты, push, merge, deploy и включение флага **не выполнялись и не разрешены этим документом.**
