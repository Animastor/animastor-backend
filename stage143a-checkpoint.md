# Stage 143a — B-lite Foundation. Контрольная точка (этап 1 — только исследование)

**Статус:** разведка и фиксация контракта, обновлено по результатам архитектурного ревью. Код, схема БД, миграции, тесты и production не изменялись. Коммитов нет, ветка не создана. Этап 2 (реализация) — только после отдельного разрешения владельца.

Цель stage 143a: безопасный переход `iu_image` на immutable versioned artifact paths с PostgreSQL pointer как единственной authority для текущего опубликованного пути и версии.

**Scope:** только `iu_image`. Реализация фундамента ≤15 файлов. Включение feature flag — BLOCKED до адаптации внутренних потребителей (раздел D, фаза 2). Audio, video, recovery и остальные писатели не мигрируются.

---

## A. Карта читателей image artifact paths

Ключевой вывод: **ни один читатель не консультирует `scene_assets.path` при отдаче картинки** — путь выводится по именной грамматике `artifact-naming.cjs` из `OUTPUT_DIR/<buildId>/<файл>`; `buildId` берётся из манифеста книги (`player-shared.cjs getEffectiveBuildId`, manifest выигрывает у `?build_id`). Переход на versioned paths без обновления читателей приведёт к отдаче старого файла или 404.

| # | Компонент | Файл | Как получает путь | URL/API | Подтвердимо | Что сломается при versioned |
|---|-----------|------|-------------------|---------|-------------|------------------------------|
| 1 | Player пакет | `packages/animastor-player/src/scene-media.cjs` (`GET /api/v1/scene/:b/:c/:s/image`) | `getEffectiveBuildId`; скан сборки `sceneArtifactPrefix+*.png`, `files[0]` | API | Да (player-route-split.test.js P1) | Устаревшая картинка или 404 |
| 2 | Player пакет | `packages/animastor-player/src/iu-media.cjs` (`GET /api/v1/iu-image/...`) | `getEffectiveBuildId` + `naming.iuImageName(...)`, прямой stream | API | Да (EditPage.tsx вызывает `mediaUrl(`/iu-image/...`)`) | 404 или старые байты |
| 3 | Player пакет | `packages/animastor-player/src/iu-media.cjs` (`/preview`, `getOrCreatePreview`) | Через хостовый деп `image.getOrCreatePreview` | API | Да | Превью от неверсионированного исходника |
| 4 | Android | `animastor-android/.../BackendApi.kt` | Retrofit `@GET /api/v1/iu-image/...`, `/scene/.../image` | API (HTTPS) | Да (интерфейс; UI-привязка — runtime) | Старое содержимое |
| 5 | Web редактор | `animastor-web/.../EditPage.tsx` | `mediaUrl(`/iu-image/...`)`, `/preview/...` | API | Да | То же |
| 6 | Web плейбэк | `playerAdapters.ts`, `navigatorAdapters.ts` | `mediaUrl(...)` | API | Да | То же |
| 7 | Экспорт | `backend/src/routes/book/export-routes.cjs` | Скан папки сборки, zip PNG | API | Да | Versioned файлы пропадут из архива |
| 8 | Писатель | `task-handler.cjs`, `cleanup-service.cjs resolveAssetPath` | Пишет `OUTPUT_DIR/<buildId>/<assetId>.png`; `scene_assets.path` не используется | внутренний | Да | Расхождение писателя/резолвера |
| 9 | Nginx | `backend/proxy/conf/default.conf` | Проксирует `/api/`; `Cache-Control: max-age=0, must-revalidate` | прокси | Да | Сам не ломается |
| 10 | Внешние URL | — | Прямых внешних image-URL в коде нет | — | Нет в коде | Вне кода — старый контент |

Непроверяемые: UI-прослойка Android (Glide/Coil), клиентский кэш медиа (MediaCache/IndexedDB), внешние интеграции с сохранёнными URL.

---

## B. Контракт публикации и fence

### B1. Durable fence — одна таблица резервирований + глобальная SEQUENCE (READY; реализация и SQL-валидация — этап 2)

**Фактический поток (проверен по коду):** диспатч (`gpu-dispatcher.js:288–425`): `resolveJobEpoch` → `idemKey = computeIdemKey(...)` (sha256 hex) → `guardEnqueue` → `rememberTaskRef` → `ensureIntentAndReceipt` (intent 14 d + immutable receipt `(dispatch_id, job_id) → idemKey`, SET NX, 48 h) → только при `created`/`reused` → hub POST; сбой → `rollbackOwnEnqueue`, задача не отправлена. Callback (`generation-routes.cjs:440–570`): workspace/identity → dedup → `resolveDispatchFence` (нет receipt → `receipt_missing`, fail-closed) → `taskHandler.handleTaskResult`.

**Схема (новые durable объекты; переживают сброс Redis):**

```sql
CREATE SEQUENCE IF NOT EXISTS iu_image_fence_seq AS BIGINT;

CREATE TABLE IF NOT EXISTS iu_image_fence_reservations (
    idem_key    TEXT PRIMARY KEY,        -- sha256 idem_key = hex fence из receipt
    book_id     TEXT NOT NULL,
    chapter_id  TEXT NOT NULL,
    scene_id    TEXT NOT NULL,
    iu_id       TEXT NOT NULL,
    build_id    TEXT NOT NULL,
    fence       BIGINT NOT NULL,
    created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint)
);
```

**Транзакционный порядок до отправки в GPU Hub:**

1. `resolveJobEpoch` + `computeIdemKey` (Redis, существующие шаги);
2. `guardEnqueue`/claim (Redis, существующий);
3. **PG-резервирование (новый шаг, ДО POST), один атомарный statement:**

```sql
INSERT INTO iu_image_fence_reservations
    (idem_key, book_id, chapter_id, scene_id, iu_id, build_id, fence)
VALUES ($idem_key, $1, $2, $3, $4, $5, nextval('iu_image_fence_seq'))
ON CONFLICT (idem_key) DO NOTHING
RETURNING fence, build_id, book_id, chapter_id, scene_id, iu_id;
-- RETURNING пуст (повторный dispatch того же намерения) →
-- SELECT fence, build_id, ... FROM iu_image_fence_reservations WHERE idem_key = $idem_key
-- → используется ИСХОДНЫЙ fence; nextval из отклонённой вставки сгорает (допустимый пробел).
```

   Сбой/недоступность PG → задача **не отправляется** (retryable; тот же принцип, что `intent_receipt_unavailable`, gpu-dispatcher.js:394–407). После этого шага выполняется откат собственных enqueue-эффектов по образцу существующего `rollbackOwnEnqueue`.
4. `ensureIntentAndReceipt` (Redis hex receipt, существующий; сбой → не отправлено; резервирование остаётся привязанным к idem_key и переиспользуется retry'ем);
5. hub POST.

**Зафиксированные свойства:**

- **Атомарная неизменяемая привязка** `idem_key → fence + resource identity`: одна строка пишется одним INSERT; `PRIMARY KEY(idem_key)` исключает повторную привязку; ресурсные колонки (`book_id…build_id`) хранятся в той же строке и проверяются callback'ом на совпадение с parsed job/build. UPDATE резервирований контрактом запрещён (нет пути кода).
- **Конкурентный dispatch (разные намерения):** `nextval` конкурентно-безопасен, все получают различные возрастающие значения; порядок fence = порядок резервирования.
- **Повторный dispatch одного намерения:** конфликт по `idem_key` → исходный fence из SELECT; новое поколение не создаётся; сгоревший `nextval` — пробел безвреден. **SEQUENCE сама по себе идемпотентность НЕ обеспечивает** — она даёт только уникальность/монотонность номеров; идемпотентность обеспечивают `UNIQUE(idem_key)` + `ON CONFLICT DO NOTHING` + последующий SELECT.
- **Порядок публикаций между ресурсами и build_id:** сравнение fence происходит только внутри одной строки указателя (один ресурс+билд); глобальная монотонность строго сильнее per-resource — порядок внутри ресурса гарантирован, межресурсные значения интерливируются безвредно.
- **Потеря/сброс Redis:** резервирования durable в PG; in-flight callbacks без hex receipt → `receipt_missing` fail-closed (существующее поведение, generation-routes.cjs ~543–552); новые dispatch после сброса консервативно создают новое намерение (новый idem_key, больший fence) — безопасно.
- **Отмена/supersede:** `readIntentStrict` (queue-idempotency.cjs:853, существующая): `state='active'` и `fence == hex receipt`, иначе reject; Redis-сбой → retryable fail-closed.
- **Поздний callback:** hex receipt → резервирование → fence F_old; pointer UPDATE: `publish_fence <= F_old` для более старого fence ложно → `rowCount=0` → reject, удаляется только temp-файл; повторная доставка того же fence → idempotent-success (`rowCount=1`, указатель не меняется).
- **Роли Redis и PostgreSQL (явно):** Redis intent/receipt отвечает за **допуск, отмену и supersede** (авторизация диспатча и живость намерения); **PostgreSQL fence — единственный источник порядка версий публикаций**. Redis НЕ даёт и не должен давать гарантию порядка публикаций.

**Статус:** ИМПЛЕМЕНТИРОВАНО в Phase 1 (коммит fef58927, ветка stage143a-foundation-phase1). Таблицы `iu_image_fence_reservations` + `iu_image_fence_seq` и writer реализованы; DDL ausgeführt на изолированном PostgreSQL; тесты гонок, сброса Redis, позднего callback и отмены пройдены (раздел "Phase 1 Implementation Results").

### B2. Публикация указателя — таблица `iu_image_pointers` (READY; SQL-валидация — этап 2)

**Принято архитектурное решение ревью:** указатели IU — **отдельная таблица**, а не колонки в `scene_assets`. Обоснование и проверка совместимости — раздел C.

```sql
CREATE TABLE IF NOT EXISTS iu_image_pointers (
    book_id      TEXT NOT NULL,
    chapter_id   TEXT NOT NULL,
    scene_id     TEXT NOT NULL,
    iu_id        TEXT NOT NULL,
    build_id     TEXT NOT NULL,
    path         TEXT NOT NULL,
    publish_fence BIGINT NOT NULL,
    created_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    updated_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::bigint),
    PRIMARY KEY (book_id, chapter_id, scene_id, iu_id, build_id)
);
```

Ключ полностью NOT NULL → обычный PK, никаких NULL-арбитров и частичных индексов (сложность B3 предыдущей версии устранена). Единственный writer этапа 143a — callback `iu_image`; сцен-уровневые image указателей не имеют (вне scope) и остаются на legacy-пути.

**Атомарный pointer UPDATE (первая публикация и обновление — один statement):**

```sql
INSERT INTO iu_image_pointers
    (book_id, chapter_id, scene_id, iu_id, build_id, path, publish_fence, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, EXTRACT(EPOCH FROM NOW())::bigint)
ON CONFLICT (book_id, chapter_id, scene_id, iu_id, build_id)
DO UPDATE SET
    path          = EXCLUDED.path,
    publish_fence = EXCLUDED.publish_fence,
    updated_at    = EXTRACT(EPOCH FROM NOW())::bigint
WHERE iu_image_pointers.publish_fence <= EXCLUDED.publish_fence
RETURNING publish_fence;
```

`$7` — целое из резервирования B1. Первая публикация: строки нет → INSERT. Повторная доставка того же fence: конфликт, WHERE истинно (same-fence replay) → `rowCount=1`, указатель не меняется (идемпотентно). Более новый fence → `rowCount=1`, указатель продвигается. Устаревший fence: WHERE ложно → `rowCount=0`, указатель не меняется, писатель удаляет только свой temp-файл (B4). Конкурентные публикации арбитрируются PK — проигравший вычисляет `WHERE` против закоммиченного значения.

**Результат по случаям:** admission chain не пройдена → SQL не выполняется (отказ в приложении); первая публикация → `rowCount=1`; более новый fence → `rowCount=1`; устаревший/повторный → `rowCount=0` + удаление temp.

### B3. IU-ключ (READY; ревизия: отдельная таблица, `scene_assets` не изменяется)

**Проверка фактической схемы:** отдельной строки на `iuId` в `scene_assets` нет (ключ по сцене+билду; schema.js:569–591); `image_units` — за IU, но без `path`/`publish_fence`. Путь записи: `resolveAssetPath` → `OUTPUT_DIR/<buildId>/<book>_<chapter>_<scene>_iu-<iuId>.png`.

**Решение:** пер-IU адресация живёт в `iu_image_pointers` (B2). **`scene_assets` не получает ни новых колонок, ни новых индексов** — из предыдущего плана (колонки `iu_id`/`publish_fence` + два частичных индекса) отказано по результатам ревью; мотивы в разделе C (совместимость, NULL-семантика, риск `markSceneAssetsStale`).

### B4. Единственный authority для `iu_image` (READY; уточнён GC)

Публикация = (1) файл по immutable пути `{build}/.versions/{iu_asset_id}/{fence}.png` + (2) атомарный pointer UPDATE (B2). `manifest`/`done marker`/`.previous-canonical`/Lua-commit для потока не пишутся (остаются другим писателям).

Порядок записи: temp-файл (`{build}/.staging/{iu_asset_id}/{fence}.tmp`) → эксклюзивное создание (O_EXCL) immutable-пути (существующий файл никогда не перезаписывается; повторная доставка того же fence с иными байтами отбрасывается) → pointer UPDATE. При отказе удаляется **только temp-файл**; immutable-файлы в ветке отказа не удаляются никогда (orphan собирается age-based GC по образцу `collectStaleStaging`); указатель не меняется.

Откат указателя — на старую неизменяемую версию с **новым, более высоким fence** (проверенный файл остаётся на своём пути; новое поколение фенса не переиспользует чужой путь).

**GC:** удаление билда (`cleanupBuild` — `rmSync` рекурсивно, захватывает `.versions/`) и кэш-сброс (`cache-routes.cjs`) должны сопровождаться `DELETE FROM iu_image_pointers / iu_image_fence_reservations WHERE book_id = $1` (и по build_id) — иначе orphan-указатели на несуществующие файлы. Адаптация `cache-routes.cjs` — в фазе 1 (раздел D).

### B5. Читатели и кэш (READY; ревизия: сцен-уровень остаётся legacy)

1. `GET /api/v1/iu-image/:bookId/:chapterId/:sceneId/:iuId` (`iu-media.cjs`): `buildId = getEffectiveBuildId(...)` (manifest приоритет, `?build_id` fallback, `'default'` последний) →

```sql
SELECT path, publish_fence FROM iu_image_pointers
WHERE book_id=$1 AND chapter_id=$2 AND scene_id=$3 AND iu_id=$4 AND build_id=$5
LIMIT 1;
```

   Есть строка → отдача файла по `path`; `status`-колонки нет — наличие строки при пройденной admission chain означает опубликованность. Нет строки → legacy-фолбэк `naming.iuImageName(...)` (совместимость с `088f3fa9`); нет и legacy-файла → `404`. ETag: `W/"{publish_fence}-{size}-{mtime}"`; legacy-фолбэк — прежний ETag. Если манифест сменил build → указатель не найден → legacy-фолбэк (задокументировано).
2. `GET /api/v1/scene/:b/:c/:s/image` (`scene-media.cjs`) — **без изменений** (сцен-уровневый image вне scope; legacy-скан сохраняется).
3. `/preview` — без изменений в коде; исходник через `getOrCreatePreview` остаётся каноническим (адаптация — FLAG-BLOCK, раздел D).
4. `/assets-state` — использует Redis-счётчик `iu-progress` и `iuRepo`, от путей не зависит — без изменений.

### B6. Ready-gate — admission chain из 7 звеньев (READY; нумерация исправлена)

`output_manifests` — писателя нет (проверено: только schema.js:489 и списки удаления) → из SQL удалён; живой gate им быть не может. Сцен-уровневый `scene_assets.status='ready'` — цикличен для per-IU (устанавливается после всех IU). Наличие файла — не доказательство корректности; единственным доказательством не используется.

**Готовность/корректность/актуальность доказывается цепочкой (нумерация по ролям):**

- **Звено 1.** Workspace: `verifyCallbackWorkspace` (существующая).
- **Звено 2.** Активность диспатча: `verifyDispatchIdentity` (существующая).
- **Звено 3.** Hex receipt: `resolveDispatchFence` (существующая; отсутствие → `receipt_missing`, fail-closed).
- **Звено 4.** Durable резервирование: lookup `iu_image_fence_reservations` по idem_key (новая, B1) + совпадение ресурсных колонок.
- **Звено 5.** Активность намерения: `readIntentStrict` — `state='active'`, fence совпадает (существующая).
- **Звено 6.** Порядок версий: **сам pointer UPDATE** `publish_fence <= EXCLUDED.publish_fence` (B2) — SQL-звено; повторная доставка того же fence — idempotent-success, более старый fence — `rowCount=0` (stale), более новый — продвигает указатель.
- **Звено 7.** Иммутабельность байтов: O_EXCL на immutable-пути (B4).

Звенья 1–5 выполняются в приложении **до** SQL и едины для первой вставки и обновления — исходное требование «gate защищает INSERT и UPDATE» выполняется цепочкой, а не мёртвым SQL-условием. Роли: звенья 1, 3, 5 — Redis (допуск/отмена/supersede, **не** порядок); звено 6 — PostgreSQL (порядок версий). Durable build-level gate (writer для `output_manifests`) — отдельное решение владельца вне 143a.

### B7. Откат feature flag (READY)

- Флаг не перемещает pointer; указатель двигается только conditional UPDATE `publish_fence <= EXCLUDED.publish_fence` (same-fence replay — идемпотентно, stale отвергается).
- Mode-exclusivity: при наличии versioned записи ресурса legacy-запись запрещается **независимо от флага** (ошибка до изменения файловой системы).
- Отключение флага не разрешает legacy-запись поверх versioned-ресурса; изменения блокируются до явного операторского возврата в legacy (сброс pointer на проверенную legacy-версию с более высоким fence, не blind-флип).
- Тест: (1) флаг вкл → публикация F1; (2) флаг выкл → legacy-запись отклонена, файл старого пути не изменён, resolver отдаёт F1; (3) флаг вкл → F2 > F1 принимается.

---

## C. Совместимость с production `088f3fa9`, миграция, откат

### C.1. Проверка предложения «отдельная таблица `iu_image_pointers`» (принято по результатам проверки, не декларативно)

**Совместимость с работающим образом `088f3fa9` (код = main до 143a):** production-код ничего не знает о новых таблицах → нулевое вмешательство: legacy-писатели продолжают писать канонические пути в `scene_assets`/диск, legacy-читатели сканируют диск как сегодня, резолвер с указателем при пустой таблице идентично падает в legacy-фолбэк. Поведение байт-в-байт сохраняется.

**Что перестаёт конфликтовать с новой схемой (проверено по фактической схеме и писателям):**

- Все INSERT в `scene_assets` используют **явные списки колонок** (`scene-assets-repo.js`: upsertAsset L177, markSceneAssetsStale L324 и L392, ensureSyntheticStaleAsset L323) — добавление колонок им не мешало бы, но отдельная таблица устраняет сам класс риска.
- `SELECT * FROM scene_assets` (7 мест в scene-assets-repo) + `rowToAsset` (маппинг известных полей) — не затрагиваются.
- `markSceneAssetsStale` / `ensureSyntheticStaleAsset` / `lockNullBuildKey` **не изменяются**. Это критично: при плане «колонки в scene_assets» `markSceneAssetsStale` (UPDATE всех строк `(book, chapter, scene, 'image')`) демотировал бы и указательные строки; отдельная таблица исключает этот конфликт полностью.
- NULL-семантика UNIQUE (`NULLS DISTINCT`) и известный production-дефект дублей NULL `build_id` (450 из 503 строк) — **не затрагиваются и не усугубляются**: ключ `iu_image_pointers` полностью NOT NULL, частичные индексы не нужны.
- CHECK `asset_type IN ('audio','image','video',...)` — не меняется.

**Затронутые писатели `scene_assets` (проверены):** upsertAsset, markReady, markStale, markSceneAssetsStale, ensureSyntheticStaleAsset, deleteByBook/deleteByBuild — все остаются без изменений; указатели живут параллельно.

### C.2. Миграция (аддитивная, без изменения существующих таблиц)

- DDL: `CREATE SEQUENCE iu_image_fence_seq`, `CREATE TABLE iu_image_fence_reservations`, `CREATE TABLE iu_image_pointers` (+ PK-индексы). **Ни одного ALTER TABLE на существующих production-таблицах** — класс блокирующих DDL-операций (перезапись таблицы, длинные ACCESS EXCLUSIVE блокировки, `CREATE INDEX CONCURRENTLY` с его ограничениями: вне транзакции, слабая видимость, повтор при сбое) отсутствует по построению. CREATE TABLE/SEQUENCE берут только краткие каталоговые блокировки.
- Backfill **не требуется**: таблицы стартуют пустыми; до первой versioned-публикации резолвер обслуживает legacy-пути (поведение `088f3fa9`).
- **План проверки на изолированной копии production-схемы** (процедура восстановления из `reorg-2026-10-12/36-isolated-restore-test-report.md`):
  1. снять копию схемы+данных (фактические строки: `scene_assets` 503, из них 450 с NULL `build_id`; `generation_tasks` 17; books/scenes);
  2. применить DDL; сверить счётчики всех существующих таблиц — **не изменились**; новые таблицы пусты;
  3. прогнать этап-2 тесты (fence/pointer/flag) против копии;
  4. behavior-дифф: до/после DDL выполнить `upsertAsset`, `markSceneAssetsStale`, `ensureSyntheticStaleAsset`, `listAssets` на ключах с NULL `build_id` — результаты (строки, статусы, штампы версий) идентичны;
  5. резолвер на пустых указателях отдаёт те же байты, что legacy-скан, для выборки книг.
- «CREATE INDEX CONCURRENTLY» **не** считается универсальным решением и в плане не используется — его не требуется, т.к. индексируются новые пустые таблицы.

### C.3. Откат

- **Мягкий (основной):** флаг OFF → писатель и callback возвращаются в legacy-ветку; таблицы остаются (inert), B7 mode-exclusivity для уже опубликованных versioned ресурсов сохраняется (legacy-запись в них по-прежнему запрещена). Резолвер продолжает отдавать versioned по указателю.
- **Жёсткий (полный возврат к `088f3fa9`):** `DROP TABLE IF EXISTS iu_image_pointers, iu_image_fence_reservations; DROP SEQUENCE IF EXISTS iu_image_fence_seq;` + флаг OFF. Восстанавливает поведение байт-в-байт; допустим только если versioned-публикаций не было, либо оператор явно принимает, что mode-exclusivity прекращает действовать (legacy-писатель снова может перезаписать старые пути). Решение — операторское, не автоматическое.

---

## D. Инвентаризация внутренних читателей/писателей (обязательна до реализации; выполнена статически)

Пределы подтверждения: статический grep/чтение backend/src + packages (включая orchestration/player); клиентские репозитории (web/android) — HTTP-потребители из раздела A; gpu-hub/worker файлов на диске backend не держат (результаты — base64 в callback). Каталоги `player-split-guard-*` — мусор сборки, исключены.

| # | Компонент | Файл/функция | Что читает/пишет | Канонический путь или указатель | Влияние versioned | Действие |
|---|-----------|--------------|------------------|--------------------------------|--------------------|----------|
| 1 | task-handler | `task-handler.cjs:239–259` — проверка завершения IU | `fs.readdirSync(outputDir)` скан `iuImagePrefix+*.png`; `iuFiles.length >= totalIUs` → `completeStage('image')` | канонический | Versioned-only → счётчик недосчитывает → **стадия никогда не завершается** | **ADAPT фаза 1:** готовность сцены считать по `SELECT COUNT(*) FROM iu_image_pointers WHERE book/chapter/scene/build` (готовые указатели), диск — доп. источник |
| 2 | task-handler | writer `handleTaskResult` → `resolveAssetPath` → канонический путь; settlement (iu-progress incr, saveIURegistry) | запись iu_image | канонический | Versioned-ветка: temp → O_EXCL immutable → pointer UPDATE; settlement-цепочка (Redis-метаданные, от путей не зависит) выполняется после принятого UPDATE | **ADAPT фаза 1** (версионная ветка + branch по флагу) |
| 3 | iu-processor | `iu-processor.js:185` — cache-hit `probeIUImage` | канонический `${iuId}.png` существует → CACHE HIT → dispatch не отправляется | канонический | Versioned-only → cache никогда не бьёт → **перезапуск генерации каждым reconcile-проходом** | **ADAPT фаза 1:** cache-hit проверять и по указателю (готовый pointer на живой файл) |
| 4 | iu-processor | dirty-unit regen `oldPng` (L201+) | канонический путь старого файла | канонический | В versioned-ветке старый файл по другому пути; удаление oldPng — no-op | **ADAPT фаза 1:** oldPng-операции не выполняются в versioned-ветке (история версий сохраняется; GC — по билду) |
| 5 | scene-callbacks | `scene-callbacks.js:280–310` — `handleImageCompleted` | `resolveCanonicalSceneImage` (диск-скан) → null → `{ok:false, retryable:true, 'image_not_found'}` → retry-петля | канонический | Versioned-only → **петля перегенерации на завершении стадии** | **ADAPT фаза 1:** доказательство сцены — готовый указатель сцены/build (SELECT) вместо диска |
| 6 | scene-callbacks | `scene-callbacks.js:345–355` — сброс IU-счётчика dirty units | диск-скан `iuPrefix` → `animastor:iu-progress` | канонический | Неверный счётчик прогресса (не фатально) | **ADAPT фаза 1:** счётчик из указателей |
| 7 | reconciliation | `reconciliation-engine.js:144–175` — `orphan_image_state` | READY-состояние + `resolveCanonicalSceneImage` null → рекомендация `regenerate_image` | канонический | **Ложные регенерации** при versioned | **FLAG-BLOCK (фаза 2):** проверять указатель как альтернативное доказательство |
| 8 | reconciliation | `reconciliation-engine.js:250` — `missing_image_file` | `fs.access(assets.image.path)` (legacy-строка scene_assets) | канонический | Ложные issues при versioned | **FLAG-BLOCK (фаза 2)** |
| 9 | scene-window | `scene-window.js:145–170` — `checkSceneFilesCache` | диск-скан → `image.exists` (advisory для dispatch-решений) | канонический | Ложное «image нет» → дубли dispatch | **FLAG-BLOCK (фаза 2):** advisory объединять с указателями |
| 10 | redis-helpers | `redis-helpers.cjs:180–205` — восстановление orphan-состояний | диск-скан (audio+iuPrefix+video) → restore READY | канонический | Восстановление image-состояния не сработает | **FLAG-BLOCK (фаза 2):** учитывать указатели |
| 11 | preview | `preview.js` — `getOrCreatePreview` | скан всех build-диров по каноническим именам (source+preview) | канонический | Превью-исходник не найден → превью 404 | **FLAG-BLOCK (фаза 2):** исходник через указатель |
| 12 | export | `export-routes.cjs /storyboard` | плоский скан `{bookId}_*.png` в корне сборки | канонический | `.versions/` не попадает в zip | **FLAG-BLOCK (фаза 2):** zip из указателей + legacy |
| 13 | export | `export-routes.cjs /download` (.vbook) | zip `BOOKS_DIR` (бандл книги) | не OUTPUT_DIR | Не затронут | без изменений |
| 14 | player | `iu-media.cjs` chunk auto-redispatch (L67–108) + `imageReady` fallback | `fs.existsSync(канонический)` / скан префикса → сброс состояния + re-dispatch | канонический | **Ложные перезапуски генерации** | **ADAPT фаза 1:** проверки объединяются с указателем (файл резолвера тот же) |
| 15 | cleanup | `cleanup-service.cjs cleanupBuild`, `cache-routes.cjs` DELETE cache | `rmSync` сборки (захватывает `.versions/`); список PG-таблиц | — | Orphan указатели/резервирования после кэш-сброса | **ADAPT фаза 1:** добавить `DELETE FROM iu_image_pointers / iu_image_fence_reservations` в список |
| 16 | routes | `generation-routes.cjs` callback | resolveDispatchFence → handleTaskResult | через writer | Versioned-ветка: резервирование+`readIntentStrict`+handoff | **ADAPT фаза 1** |
| 17 | dispatcher | `gpu-dispatcher.js` | резервирование до POST | — | Новый шаг | **ADAPT фаза 1** |
| 18 | recovery | `audio-recovery.cjs` | только audio | — | Не затронут | без изменений |
| 19 | publication | `result-publication.cjs` | fenced commit legacy-потоков | канонический | iu_image versioned его обходит (B4) | без изменений (другие потоки) |
| 20 | debug | `debug-routes.cjs` replay callback | идёт через ту же ветку writer'а | — | Согласован по флагу | без изменений кода; тест этапа 2 |

**Итог:** 20 позиций инвентаризации; затронуты 12 (по 10 файлам), не затронуты 8. **Фаза 1 (реализация 143a, ≤15 файлов):** ядро потока — schema.js, новый fencing/pointer repo, gpu-dispatcher, generation-routes, task-handler, iu-processor, scene-callbacks, iu-media, cache-routes, runtime-config (10 impl-файлов) + 3 тест-файла = **13 ≤ 15**; флаг по умолчанию **OFF**. **Фаза 2 ( precondition включения флага, отдельное одобрение владельца, ~5 файлов):** позиции 7–12 (reconciliation-engine, scene-window, redis-helpers, preview, export-routes). **Включение флага до завершения фазы 2 ЗАПРЕЩЕНО** — иначе петли ложных регенераций (7, 9, 14), ложные recovery (10), сломанные превью (11) и экспорт (12).

---

## E. Финальная согласованность и статусы

| Проверка | Результат |
|---|---|
| dispatch fence ↔ callback receipt | hex receipt (idem_key) — токен допуска (Redis); целое fence — из `iu_image_fence_reservations` по idem_key + сверка ресурсных колонок и build_id (Redis — допуск/отмена/supersede; PG — порядок версий). Согласовано |
| Ключ ресурса ↔ ограничения | `iu_image_pointers` PK (book, chapter, scene, iu_id, build_id) — все NOT NULL; конфликт-таргет точный; scene_assets не изменяется. Согласовано |
| SQL-пути | Один statement на публикацию (первая вставка и обновление); частичные индексы устранены. Согласовано |
| Ready-gate INSERT+UPDATE | Звенья 1–5 до SQL едины для обеих веток; звено 6 — сам UPDATE; звено 7 — файловый порядок. Нумерация 1–7 исправлена. Согласовано |
| Resolver по build_id | `AND build_id = $effective` (manifest-first); смена манифеста → legacy-фолбэк. Согласовано |
| Удаление только своего файла | temp-only при отказе; immutable не удаляются; O_EXCL. Согласовано |
| Совместимость `088f3fa9` | Проверена: явные списки колонок всех INSERT scene_assets, SELECT * толерантен, markSceneAssetsStale-семейство не затронуто, legacy-фолбэк резолвера. Согласовано |
| Миграция | Аддитивная, без ALTER существующих таблиц; проверка на изолированной копии (450/503 NULL build_id) — план C.2 |
| Исполнение SQL | **Выполнено на изолированном PostgreSQL** (stage143a-pg:55432) в Phase 1; DDL `IU_IMAGE_VERSIONED_SQL` исполняется в `runMigrations()` только под флагом; валидация — тесты таблицы "stage143a fence-reservation" (7 тестов) |

### Итоговая таблица статусов

| Пункт | Статус | Условие |
|---|---|---|
| B1 Durable fence (резервирования + SEQUENCE) | **ИМПЛЕМЕНТИРОВАНО (Phase 1)** | Таблица `iu_image_fence_reservations` + `iu_image_fence_seq`; идемпотентность — UNIQUE(idem_key)+ON CONFLICT+SELECT; резервирование до hub POST; rollback на PG-сбой; 7 тестов пройдены |
| B2 Указатель `iu_image_pointers` | **ИМПЛЕМЕНТИРОВАНО (Phase 1)** | DDL + upsert `publish_fence <= EXCLUDED` (same-fence replay — идемпотентно, stale отвергается); 10 тестов пройдены |
| B3 IU-ключ (отдельная таблица, scene_assets без изменений) | **READY** | Принято ревью после проверки схемы и писателей |
| B4 Immutable authority + GC | **READY** | Включает DELETE указателей при очистке билда (D#15) |
| B5 Читатели/кэш | **READY** | IU-resolver по указателю; сцен-уровень legacy; preview/export — FLAG-BLOCK |
| B6 Ready-gate (admission chain 1–7) | **READY** | Роли Redis/PG разведены; звенья 1–5 до SQL |
| B7 Откат feature flag | **READY** | Mode-exclusivity; тест зафиксирован |
| C Совместимость/миграция/откат | **READY** | Аддитивная миграция; изолированная копия — план C.2 |
| D Инвентаризация | **DONE** | 20 позиций; фаза 1 = 13 файлов; фаза 2 = 5 файлов; **флаг ON BLOCKED до фазы 2** |
| E Согласованность | **DONE** | Противоречия устранены |

## F. Phase 1 Implementation Results (результаты реализации этапа 1)

### F.1. Первоначальный план (контракт, разделы A–E выше)

- Внедрить versioned `iu_image` fundación: durable dispatch fence (таблица резервирований + SEQUENCE), PG-указатель, path safety, флаг OFF по умолчанию.
- Лимит Phase 1: ≤ 13 файлов (checkpoint). Feature flag НЕ включать в production. Merge в main, deploy и Phase 2 — только после отдельного разрешения.
- Границы: только `iu_image`; audio/video/recovery не мигрируются; `scene_assets` без изменений; DDL только в `schema.js` (PG-5); репозиторий без DDL.

### F.2. Фактически реализовано и проверено (Phase 1, коммит fef58927)

**Ветка:** `stage143a-foundation-phase1` (от `main` @ `b38f12ba`).  
**Коммит:** `fef58927` — 13 файлов (ровно лимит Phase 1), push только в `origin`. main не тронут, deploy не выполнен, флаг OFF.

**13 файлов:**
1. `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js` (NEW) — флаг `versionedEnabled()` (значения 1/true/on/yes), path safety (`normalizeRelativePath`, `resolveOutputPath`, `safeComponent`, `versionedRelPath`, `stagingRelPath`), `reserveDispatchFence`, `resolveCallbackFence`, `publishIuImagePointer`, читатели указателей.
2. `backend/src/storage/postgres/schema.js` — `IU_IMAGE_VERSIONED_SQL` (SEQUENCE `iu_image_fence_seq`, таблица `iu_image_fence_reservations`, таблица `iu_image_pointers`); выполнение в `runMigrations()` только под флагом.
3. `backend/src/runtime/gpu-dispatcher.js` — шаг резервирования fence после `rememberTaskRef`, до hub POST; PG-сбой → `rollbackOwnEnqueue` + `retryable: true, reason:'fence_reservation_unavailable'`.
4. `backend/src/services/task-handler.cjs` — `publishVersionedIuImage` (цепочка приёма: hex receipt → `resolveCallbackFence` (hex→int + совпадение ресурсных колонок) → `readIntentStrict` active → temp + `copyFileSync(COPYFILE_EXCL)` → pointer upsert); терминальные коды `stale_intent`/`intent_missing`/`invalid_fence`, PG-ошибки `publish_failed`/`fence_lookup_unavailable`; удаляется только temp-файл; версия сцены считается как объединение канонических имён (`scenePrefix`) и опубликованных `iu_id`; поле исхода `versioned`.
5. `backend/src/image/iu-processor.js` — pointer-aware cache hit (путь через указатель, если канонический скан пуст).
6. `backend/src/image/registry.js` — `resolveIuImagePath`, `resolveVersionedSceneProof` (legacy-скан primero, затем versioned fallback с `typeof`-guard).
7. `backend/src/image/image-service.js` — экспорт фасадовых методов в контур плеера.
8. `packages/animastor-orchestration/src/orchestration/scene-callbacks.js` — legacy-скан, затем versioned proof fallback.
9. `packages/animastor-player/src/iu-media.cjs` — pointer-first резолвер с ETag, legacy-фолбэк; allowlist require не расширен.
10. `backend/src/routes/book/cache-routes.cjs` — обе таблицы добавляются в `pgTables` только при флаге ON.
11. `backend/tests/stage143a-fence-reservation.test.js`
12. `backend/tests/stage143a-pointer-publication.test.js`
13. `backend/tests/stage143a-flag-off.test.js`

**Исправления по сравнению с планом (разделы A–E):**
- Имя таблицы резервирований: `iu_image_fence_reservations` (не `fence_reservations` — сверено с `schema.js` и кодом).
- Условие pointer upsert: `publish_fence <= EXCLUDED.publish_fence` (отклонение от строгого `>` в плане): same-fence replay — idempotent-success; stale fence → `published:false, reason:'stale_fence'`.
- Доступ к флагу: через `versionedEnabled()` в новом репозитории (не в `runtime-config.js`, чтобы уложиться в 13 файлов).
- Готовность сцены: объединение канонических файлов (`scenePrefix`) и опубликованных `iu_id` (не только `COUNT(*) FROM iu_image_pointers`).
- Цепочка приёма реализована в `task-handler.cjs` (не в `generation-routes.cjs`, чтобы не ломать замороженную require-базисную линию).

**Результаты тестов (изолированное окружение: `stage143a-pg` 127.0.0.1:55432 / `stage143a-redis` 127.0.0.1:56379; production `animastor-pg`/`animastor-redis` НЕ трогались):**
- Stage 143a suite: **25 passed, 0 failed** — `computeIdemKey` (одинаковая доставка → одинаковый ключ; регенерация → новый ключ и больший fence), повторная доставка того же диспатча → тот же ключ и fence, 10-потоковая конкуренция (один ключ → один fence; разные ключи → разные fence), приём callback (совпадение/несовпадение/неизвестный ключ), порядок диспатчера (reserve до POST + rollback), первый publish / repeat-callback / stale-callback, concurrency publishers → max fence, path-safety positives/negatives/symlink escape/hostile components/traversal row, флаг OFF → нулевых новых PG-запросов + legacy-процедуры без изменений + source-contract гейты, Redis active vs cancelled intent, отсутствующий receipt → fail-closed.
- Architecture guardrails: **935 passed, 0 failed** (sql-boundary, PG-1..PG-5, phase6 базы, player-route-split и др.).
- Затронутые behavioral suite (`happy-path`, `image-ghost-no-jobs-sent`, `reconciliation-engine`): **187 passed, 0 failed**.
- Syntax smoke (pretest): OK.
- `node --check`: все 10 реализационных файлов прошли.

### F.3. Не реализовано — требует отдельного разрешения (Phase 2, БЛОКИРОВАНО)

- Включение флага `IU_IMAGE_VERSIONED` в production — флаг остаётся OFF.
- Адаптация позиций D#7–D#12 (reconciliation-engine, scene-window, redis-helpers, preview, export-routes) — иначе ложные регенерации/рекуперации/превью/экспорт.
- Merge в `main`, deploy, push в `github` без отдельного решения.
- Любое расширение объёма Phase 1 сверх 13 файлов.

### F.4. Неподтверждённое / не проверяемое из этого отчёта

- Данные отчёта основаны на предоставленном резюме прогона тестов и проверке рабочей копии; повторный 독립ный прогон полного набора тестов не выполнен в рамках этой документационной задачи.
- Клиентские репозитории (web/android) и их кэширование медиа — не проверялись.

---

**Остановка.** Phase 1 завершён, коммит `fef58927` в ветке `stage143a-foundation-phase1`, флаг OFF, merge/deploy не выполнены. Ожидаю отдельного разрешения владельца на Phase 2.
