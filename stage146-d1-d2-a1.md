# Stage 146 — исправление D1/D2 и классификация A1 на staging

**Тип:** два точечных исправления + регрессионные тесты + проверка A1 штатным триггером.
Прод-код не менялся; контейнеры/PG/Redis/compose/`.env` прода не трогались; `main` не тронут;
merge/deploy/`npm publish` не выполнялись; dirty-файлы рабочей копии не изменялись;
staging не убирался (оставлен поднятым).

> Self-reference невозможен: хеш коммита этого документа сообщается в чат после push и не
> записывается внутрь файла.

---

## 0. Итог

| Пункт | Итог |
|---|---|
| **D1** (artifactNaming в `beginStage`) | **исправлен** — перенос на уровень модуля; регтест падает на до-фикс коде с ровно тем же `ReferenceError` |
| **D2** (`/api/v1/debug/runtime` без `next()`) | **исправлен** — middleware вызывает `next()`; регтест с AbortController-таймаутом падает на до-фикс коде |
| Тесты (свежий клон, локальный тарболл `orchestration@0.1.6`) | stage143a-*+D1+D2 **102/0**, `test:arch` **935/24 pending/0**, полный backend suite **3600/28 pending/0**, orchestration package suite **36/0** |
| Staging | пересобран из `683592a4`; S2 **PASS**; 30-мин S3 при флаге ON и контроль при OFF выполнены |
| **A1** | **вердикт (а): воспроизводится и при флаге OFF** — старая ошибка, не блокер флага (см. §5.4); идентичный цикл +418 событий/30 мин в обоих прогонах |
| D1 в проде | **да** — `@animastor/orchestration` **0.1.4**, `orchestrator.js:60` внутри `beginStage` (read-only, прод не тронут) |

---

## 1. D1 — `artifactNaming` в orchestrator.js

**Было** (`packages/animastor-orchestration/src/orchestration/orchestrator.js`):
`const artifactNaming = require('@animastor/generation').artifactNaming;` объявлена **внутри**
`beginStage()` (строка 60), тогда как `resetScenes()` использует её в ветке pre-delete старых
PNG/превью (строки 534/537/555) → `ReferenceError: artifactNaming is not defined` →
`/regenerate` возвращал 500. Введено `e60c5d4b`, перенесено пакетом `41a56903`.

**Стало:** объявление поднято на уровень модуля (рядом с `mediaRegistry`, строка 26), из
`beginStage()` убрано; `beginStage` сохраняет свой lazy `dispatchEngine` require. Комментарий
S-4 перенесён вместе с объявлением, в orchestrator.js добавлен маркер `D1 (stage146)`.

**Поиск той же ошибки в orchestration + player.** Эвристический детектор (объявление `const … =
require(...)` внутри top-level функции, идентификатор используется в другой top-level функции)
дал по обоим пакетам один **реальный** случай — `orchestrator.js:60 artifactNaming`. Остальные
срабатывания — ложные, проверены вручную:

| Срабатывание | Классификация |
|---|---|
| `orchestrator.js` `dispatchEngine`@58 → «используется» в completeStage/failStage/resetScenes | ложное: у каждого вызывающего свой локальный `const dispatchEngine = require(...)` (86, 256, 500) |
| `orchestrator.js` `scheduler`@49/494 | ложное: взаимные локальные объявления + комментарий-слово «scheduler» |
| `orchestrator.js` `path`@524 | ложное: «path» в комментарии (130) и локальная `const path` в `rollbackStageToPending` (375) |
| `reconciliation-engine.js:106 loadedBook` | ложное: `recoverResultKeys` объявляет свою `const loadedBook` (2364) |
| `scene-window.js:571 scheduler` | ложное: использования — слова в комментариях (495, 801) |
| `scene-callbacks.js`/`scene-restoration.js`/`runtime-scheduler.js`/`scene-window.js` `path`/`fs`/`mediaRegistry`… | ложные: объявления на уровне модуля, используемые в функциях (норма) |

**Player:** реальных случаев нет. Исправлялся только D1.

**Регрессионный тест** `packages/animastor-orchestration/test/stage146-d1-artifact-naming.test.js`:
вызывает `resetScenes()` с dirty-юнитом и `cleanPngUnitIds` (ветка, доходящая до строк 534/537/555),
проверяет, что исключение не бросается и старые PNG + превью удалены. На до-фикс коде тест падает:

```
ReferenceError: artifactNaming is not defined
    at Object.resetScenes (src/orchestration/orchestrator.js:534:57)
```

(проверено: код временно возвращён к до-фикс виду, тест падает; после восстановления — проходит).

---

## 2. D2 — middleware `/api/v1/debug/runtime`

**Было** (`backend/src/routes/debug-routes.cjs:36`): `app.use('/api/v1/debug/runtime', (req,res) => {
… res.locals … })` — middleware писал `res.locals` и **не вызывал `next()`**, поэтому «съедал» все
запросы к поддереву: downstream-хендлеры не выполнялись, клиент висел (curl `HTTP 000`).

**Стало:** `(req, res, next)` + `next()` после записи `res.locals` (с маркером `D2 (stage146)`).

**Регрессионный тест** `backend/tests/stage146-d2-debug-runtime.test.js`: поднимает реальный
`debug-routes.cjs` на реальном Express (audio-recovery застаблен через `proxyquire`), делает
`GET /api/v1/debug/runtime/status` с `AbortController`-таймаутом 3 с. На до-фикс коде запрос висит
и тест падает (`AbortError`); после фикса — 200 + `runtime` в теле.

**Проверка на staging (D2 живьём):** `GET /api/v1/debug/runtime/status` и `/counters` отвечают
(`real 0m0.019s`); до фикса — таймаут.

---

## 3. Версии и метаданные пакета

| Файл | Изменение |
|---|---|
| `packages/animastor-orchestration/package.json` | `0.1.5 → 0.1.6`; в `files` добавлен `CHANGELOG.md` (как у остальных контентных пакетов) |
| `packages/animastor-orchestration/package-lock.json` | версия `0.1.6` (2 места) |
| `packages/animastor-orchestration/CHANGELOG.md` | **новый**: запись 0.1.6 (D1) + заголовок 0.1.5 |
| `backend/package.json` | `@animastor/orchestration` `^0.1.5 → ^0.1.6` |
| `backend/package-lock.json` | диапазон `^0.1.6`; entry `node_modules/@animastor/orchestration` → `0.1.6` + integrity, перегенерированная из **чистого** дерева коммита |

Integrity считалась `npm pack` **по чистому дереву коммита** (чужая правка `dispatch-engine.js`
(Stage 124/N1-B) из рабочей копии на время упаковки откатывалась к HEAD, затем возвращалась —
тот же приём, что в Stage 143a, чтобы после публикации `npm ci` не падал EINTEGRITY):

```
sha512-d/Q0k4F/PgofwzZOYDdHat402ZUphq6pn29BN2cY2mpLd5/hqQA+KZHdbViYzVe/Zcyo1629QipDcv8SsIBY1Q==
```

Пакет **не публиковался** (`npm publish` запрещён ТЗ).

---

## 4. Тесты

**Свежий клон** `/tmp/opencode/stage146-clone` (`git clone` ветки, HEAD `683592a`),
node v22.22.3, npm 10.9.8. `@animastor/orchestration@0.1.6` не опубликован ⇒ локальный workaround
«как раньше»: byte-exact тарболлы из дерева клона (`npm pack`) добавлены в npm-кэш (`npm cache
add`), остальные 399 зависимостей — из lock. Integrity тарболлов совпала с lock: orchestration
`sha512-d/Q0k4…`, player `sha512-YEqz0Aym…`. Установилось: orchestration **0.1.6**, player **0.1.3**.
Изолированный PG `127.0.0.1:55432` (`PG_DB=stage143a`), Redis `127.0.0.1:56379`,
`ANIMASTOR_DOCS_ROOT=/home/animastor/animastor-docs`.

| # | Набор | Команда | Итог |
|---|---|---|---|
| 1 | stage143a + новый D1 + новый D2 | `npx mocha --exit tests/stage143a-*.test.js tests/stage146-d2-debug-runtime.test.js ../packages/animastor-orchestration/test/stage146-d1-artifact-naming.test.js` (с тест-биндингами пакета) | **102 passing, 0 failing** |
| 2 | `npm run test:arch` | `npm run test:arch` | **935 passing, 24 pending, 0 failing** |
| 3 | полный backend suite | `npx mocha --exit "tests/**/*.test.js"` | **3600 passing, 28 pending, 0 failing** (~2 мин) |
| 4 | package suite orchestration | `npm test` в пакете | **36 passing, 0 failing** (35 прежних + 1 новый D1) |

До-фикс поведение обоих регтестов проверено (временно возвращался до-фикс код):
D1-тест — `ReferenceError: artifactNaming is not defined` @ `orchestrator.js:534`; D2-тест —
`AbortError` (запрос завис). После восстановления фикса оба зелёные.

Коммит исправлений+тестов (один коммит, только явные пути): `683592a4`
`fix(stage146): hoist artifactNaming to module scope (D1) + debug-runtime next() (D2)` —
9 файлов: 2 фикса, 2 регтеста, 5 файлов версий/lock/CHANGELOG. Push в
`stage143a-foundation-phase1` (`f08b0a10..683592a4`).

---

## 5. Staging: S2/S3 штатным способом и A1

### 5.1. Сборка staging из нового коммита

staging-клон `/home/animastor/staging-144/src` → checkout `683592a4`; образ `staging-backend`
пересобран (`docker compose -p animastor-staging --env-file .env.staging -f
docker-compose.staging.yml up -d --build`), тот же проект `animastor-staging`, порты только
loopback, прод-сеть не использовалась. Изоляция подтверждена read-only инспекцией (project label,
сеть `animastor-staging_net`, тома, порты 3100/55433/56380 — без изменений от Stage 145).

**Отступление от сборки из чистого коммита (зафиксировано):** `orchestration@0.1.6` не
опубликован, а `backend/Dockerfile` ставит зависимости из реестра (`npm install`) ⇒ сборка падала
E404. В **staging-клоне только** (не в коммите): тарболл пакета положен в `backend/.deps/`,
`package.json` временно указывал `file:.deps/animastor-orchestration-0.1.6.tgz`, в Dockerfile
добавлена строка `COPY .deps ./.deps`; после сборки оба файла восстановлены к состоянию коммита
(`git status` чист по этим путям). Установленный в образе код пакета — байт-в-байт дерево коммита
(та же integrity, что в lock).

### 5.2. Прогон 4.2 — контроль A1 при флаге OFF (легаси-режим)

Книга `stage145_mini` (сцена `ch-a1b2c3/sc-d4e5f6`, build `stage145_build1`) на момент старта:
`content_version=4`, `dirty_unit_ids={}`, флаг OFF, `iu_image_pointers` — 0 строк (после B7
Stage 145). Штатный путь:

1. `PATCH /api/v1/book/stage145_mini/scene/ch-a1b2c3/sc-d4e5f6
   {"unit_id":"iu-000001","fields":{"text":"…"}}` → 200, `dirty_scenes=1`;
   PG: `content_version=4`, `dirty_unit_ids={iu-000001}`.
2. `POST /api/v1/book/stage145_mini/regenerate
   {"chapter_id":"ch-a1b2c3","scene_id":"sc-d4e5f6","worker_types":["image"]}` → **200**
   (D1 починен; в Stage 145 здесь был 500 `artifactNaming is not defined`).
3. Доставка результатов через replay (`POST /gpu/task/result`, 3 IU) → `{"ok":true}` ×3;
   легаси-публикация `[IMAGE] CANONICAL IU IMAGE: …_iu-000001.png`.

**Наблюдение (сразу после доставки):**

```
[ORCH] IMAGE_CALLBACK: stage145_mini/ch-a1b2c3/sc-d4e5f6 -> READY check passed
[ORCH] [VERSION-GATE] stage145_mini/ch-a1b2c3/sc-d4e5f6: image stale — DIRTY instead of READY
[STATE] ASSET STATE: … image: -> dirty   →   -> pending
[DISPATCH] FINALIZE_SUCCESS: …:image (stale)
[ORCH] DISPATCH_RESULT: … image: dispatched=false, jobs=0, reason=cache_hit
[SCHEDULER] ATTEMPT_DISPATCH: stage145_mini:ch-a1b2c3:sc-d4e5f6 -> stages=[image]
```

**30-минутный soak без вмешательства** (2026-10-26T17:48:50Z → 18:23:59Z):

| Метрика | T0 | T+30 мин | Итог |
|---|---|---|---|
| `[VERSION-GATE] … stale — DIRTY instead of READY` | 353 | **771 (+418)** | цикл идёт, ~14/мин |
| `iu_image_fence_reservations` | 0 | 0 | новых резерваций нет |
| `iu_image_pointers` | 0 | 0 | (легаси-режим) |
| `scene_assets.image.status` | stale | **stale** | READY не достигнут |
| `scene_assets.image.build_id` | NULL | **NULL** | строка не починена |
| `[PG-IMAGE-READY]` | 0 | **0** | gate не прошёл ни разу |
| `Missing image file` / `resetting state for redispatch` | — | **0 / 0** | ложных repair-циклов нет |

`scene_assets` (image) после 30 мин: `path=stage145_mini_ch-a1b2c3_sc-d4e5f6_iu-000001.png`
(относительный), `build_id=NULL`, `scene_content_version=4`, `status=stale`.
`scenes`: `content_version=4`, `audio_config_version=4`, `dirty_unit_ids={}`
(dirty-юнит корректно очищен — маркер N1 `[DIRTY-UNITS-CLEARED] all 3 dirty unit(s)`).

**Вывод: A1 воспроизводится при флаге OFF.**

### 5.3. Прогон 4.1 — штатный путь при флаге ON

Флаг включён (`IU_IMAGE_VERSIONED=1`, пересоздание контейнера; DDL `iu_image_*` на месте).
Состояние до регенерации (T0): `content_version=4`, `dirty_unit_ids={}`, pointers 0,
`scene_assets.image`: `build_id=NULL`, `scene_content_version=4`, `status=stale`;
`VERSION-GATE stale` уже 29 с момента старта контейнера (цикл тикал и без нашей регенерации).

Штатный путь (те же шаги):

1. `PATCH` юнита `iu-000001` → 200, `dirty_scenes=1`; PG: `content_version=5`,
   `dirty_unit_ids={iu-000001}`.
2. `POST /regenerate` → **200**; лог: `[REGENERATE] … released 1 idempotency claim(s) and 2
   completion marker(s)`; `[DIRTY-UNIT-REGEN] Force-regenerating …_iu-000001 — this unit was
   modified` (+ 000002/000003 — /regenerate без `unit_id` помечает все юниты сцены).
3. Резервации: `Fence reservation created: …_iu-000001:iu_image idem=9cd95db45ba0 fence=4`
   (и fence=5, fence=6 для 000002/000003).
4. Replay ×3 → `{"ok":true}`; публикации:

```
💾 Versioned publication: stage145_build1/.versions/…_iu-000001/4.png (fence=4, …)
💾 Versioned publication: stage145_build1/.versions/…_iu-000002/5.png (fence=5, …)
💾 Versioned publication: stage145_build1/.versions/…_iu-000003/6.png (fence=6, …)
[ORCH] [DIRTY-UNITS-CLEARED] … all 3 dirty unit(s) completed, cleared
```

**S2-проверки (все PASS):**

| Проверка | Значение |
|---|---|
| `iu_image_pointers` | 3 строки: `iu-000001` fence=4, `iu-000002` fence=5, `iu-000003` fence=6; path = `stage145_build1/.versions/…/{fence}.png` |
| immutable-файлы | `1.png`, `2.png` от Stage 145 **не тронуты**; добавлены `4.png`, `5.png`, `6.png` |
| байты | sha256(`.versions/…/4.png`) = sha256(доставленного red PNG) = `b9934c0b…` |
| `GET /iu-image/…/iu-000001` | 200 `image/png`, `ETag: W/"4-190-…"` (fence=4 в ETag), sha256 тела = доставленные байты |
| `GET /preview/…/iu-000001` | 200, `X-Preview-Created: true`; лог `preview created from published source` |
| `scenes` | `content_version=5`, `dirty_unit_ids={}` |

**S3 — 30-минутный soak при флаге ON** (2026-10-26T18:49:52Z → 19:24:59Z, без вмешательства):

| Метрика | T0 | T+30 мин | Итог |
|---|---|---|---|
| `[VERSION-GATE] … stale — DIRTY instead of READY` | 145 | **563 (+418)** | цикл идёт, ~14/мин |
| `iu_image_fence_reservations` | 4 | **4** | новых резерваций нет ✅ |
| `iu_image_pointers` | 3 | **3** (fence 4/5/6 без изменений) | указатель не двигается ✅ |
| `scene_assets.image.status` / `build_id` | stale / NULL | **stale / NULL** | READY не достигнут |
| `[PG-IMAGE-READY]` | 0 | **0** | gate не прошёл ни разу |
| `Missing image file` / `resetting state for redispatch` | — | **0 / 0** | ложных repair-циклов нет ✅ |
| `[DIRTY-UNITS-PARTIAL]` / `[DIRTY-UNITS-CLEARED]` | — | **0 / 1** | dirty-юниты очищены корректно (N1) ✅ |
| `scenes` | 5/{3 IU} | `content_version=5`, `dirty_unit_ids={}` | ✅ |
| `GET /api/v1/chunk/…_0001` | — | `{"status":"ready","image_ready":true,…}` | read-side корректен (N3/N4) ✅ |

**Итог S3 при флаге ON: PASS по трём явным критериям плана** (нет новых `Fence reservation`
без действия; нет `Missing image file … resetting state for redispatch`; `dirty_unit_ids` очищен),
с зафиксированной аномалией A1 — той же, что и при флаге OFF.

Промежуточные срезы каждые 5 мин: `version_gate_stale` 145 → 205 → 264 → 324 → 384 → 443 → 503 → 563
(линейно, ~12 событий/мин; pointers/fence/image_status не менялись ни в одном срезе).

### 5.4. A1 — механизм и вердикт

**Механизм (подтверждён кодом и PG):**

1. Единственная строка `scene_assets` для `image` этой сцены имеет `build_id = NULL`
   (легаси/синтетическая строка; в production таких семейств много — см. комментарий
   Stage 76 в `scene-assets-repo.js`: «в production уже 450/503 строк с NULL build_id»).
2. Version-gate в `completeStage` читает ассет через
   `persist('sceneAssets.getAsset')(bookId, chapterId, sceneId, stage, buildId)`;
   `getAsset` при truthy `buildId` добавляет фильтр `build_id = $5`
   (`scene-assets-repo.js:408-420`) — строка с `NULL` **не находится**.
3. `asset` нет ⇒ `shouldWriteReady=false` ⇒ `[VERSION-GATE] … stale — DIRTY instead of READY`
   (`orchestrator.js:206`), состояние → `DIRTY`.
4. Единственный писатель, который мог бы проставить строке `build_id`
   (`markReady` → `buildIdFromArtifactPath`, `scene-assets-repo.js:251-259`), вызывается
   **после** gate — то есть ровно за тем самым условием, которое не проходит.
   Замкнутый круг: строку может починить только `markReady`, а `markReady` недостижим,
   пока строка «невидима» для gate.
5. Планировщик (тик раз в 5 с) пере-диспетчеризует сцену → dispatch = `cache_hit`
   (файл на диске) → callback → gate → DIRTY → … бесконечный цикл без нового GPU-хвоста
   (`Missing image file` = 0, новых `Fence reservation` нет).

Источник повторного `completeStage`: **тик планировщика**
(`[SCHEDULER] === RUNTIME SCHEDULER TICK ===` → `ATTEMPT_DISPATCH` → `cache_hit` →
`IMAGE_CALLBACK` → gate), а не reconcile и не callback-ретраи. В окне наблюдения при флаге OFF:
20 × `IMAGE_CALLBACK` против 3 × `RECONCILE` (reconcile раз в 60 с фиксирует
«1 inconsistencies», но цикл гоняет тик).

**Вердикт: (а) — A1 воспроизводится и при флаге OFF: это старая ошибка, не блокер флага.**

Обоснование:

* **одинаковая динамика цикла в обоих прогонах**: при флаге OFF `VERSION-GATE stale` вырос на
  **+418** за 30 мин (353→771), при флаге ON — ровно на **+418** за 30 мин (145→563);
  идентичный финальный срез (`scene_assets.image`: `build_id=NULL`, `status=stale`,
  `[PG-IMAGE-READY]` = 0, `Missing image file` = 0) в обоих случаях;
* флаг меняет только **способ публикации** (легаси-канонический файл против
  `.versions/{iuId}/{fence}.png` + указатель), но не затрагивает виновную пару: versioned-публикация
  пишет в `iu_image_pointers`/`.versions/**` и **не** создаёт versioned-строку в `scene_assets`,
  поэтому «брата» с `build_id IS NOT NULL` у ключа нет, и правило Stage 73 применить не к чему;
* виновная пара — `getAsset` c фильтром `build_id` (version-gate, Stage 50, `e172075`) и
  легаси-NULL-строка (семейство описано в Stage 73/76, `c343eec`/`74088d6` — **до** Stage 143a).
  Stage 73 уже ввёл правило «доказанного NULL-дубля» для выборок dirty-сигнала
  (`getDirtyMarkers`/`getDirtyScenesByVersion`/`getAudioConfigVersions`/
  `getVersionStalenessRows`), но **`getAsset` — чтение version-gate — этим правилом не покрыт**.

**Минимальное исправление (НЕ применяется в этом этапе, по условию ТЗ):** в version-gate
`completeStage` при пустом результате `getAsset(..., stage, buildId)` делать фолбэк-чтение
ключа **без фильтра по `build_id`** (последняя строка ассета этого ключа, как уже делает
`getAsset` при `buildId=null`), и пропускать READY, если `scene_content_version` этой строки
подтверждает версию сцены; либо симметрично: при отсутстви versioned-строки считать строку
ключа «доказанной» по правилу Stage 73. Тогда gate пропустит READY один раз, `markReady`
проставит `build_id`/path — и цикл сойдётся (в терминах Stage 50: «gate пропускает READY ровно
один раз (сходимость)»).

### 5.5. Что починил Stage 146 в staging

* `POST /regenerate` работает (200 вместо 500) — штатный триггер регенерации восстановлен;
* `GET|POST /api/v1/debug/runtime/*` отвечают мгновенно — debug-инструменты оператора доступны;
* versioned-контур (S2) отрабатывает штатным триггером end-to-end: резервация → публикация
  `.versions/{iuId}/{fence}.png` → указатель → ETag с fence → превью из опубликованного
  источника → очистка dirty-юнитов.

---

## 6. Прод (read-only)

| Проверка | Значение |
|---|---|
| контейнер | `animastor-backend`, Up 5 days (аптайм не менялся), образ `f6aefe57045a` |
| `@animastor/orchestration` | **0.1.4** (`/app/node_modules/@animastor/orchestration/package.json`) |
| D1 в установленной копии | **да**: `orchestrator.js:60` — объявление внутри `beginStage` (55–67), использования 534/537/555 |
| D2 в установленной копии | **да**: `debug-routes.cjs:36` — middleware без `next()` |
| `IU_IMAGE_VERSIONED` | отсутствует (флаг OFF) |
| изменения прода | **нет**: перезапусков/пересозданий не было; `animastor-pg`/`animastor-redis` Up 2 months (healthy), `animastor-proxy` Up 7 days |

---

## 7. Выводы

1. **D1 и D2 исправлены** и покрыты регрессионными тестами, которые падают на до-фикс коде.
   Коммит `683592a4` (исправления + тесты + версии 0.1.6) запушен в
   `stage143a-foundation-phase1`. Публикации пакета не было.
2. **Флаг `IU_IMAGE_VERSIONED` на staging работает штатным триггером**: S2 (versioned-издание,
   указатель, ETag, превью) — PASS; блокеры Stage 145 (D1/D2) устранены.
3. **A1 — вердикт (а)**: воспроизводится и при флаге OFF; причина — version-gate
   (Stage 50) не видит легаси-строку `scene_assets` с `build_id = NULL`
   (`getAsset` фильтрует по `build_id`), а единственный писатель, способный её починить
   (`markReady`), находится за gate. Не блокер флага; минимальное исправление описано в §5.4
   и не применялось. Оба 30-минутных прогона дали идентичную динамику цикла (+418 событий).
4. D1/D2 присутствуют и в проде (0.1.4, read-only проверка) — прод не тронут.
5. Staging оставлен поднятым (flag ON, сцена в наблюдаемом состоянии A1), уборка §2.6 не выполнялась.

---

## Приложение. Артефакты

* staging: `/home/animastor/staging-144/{docker-compose.staging.yml,.env.staging,src}`,
  данные `/home/animastor/staging-144/data/{books,output}`; клон на `683592a4`.
* свежий клон для тестов: `/tmp/opencode/stage146-clone` (+ тарболлы
  `/tmp/opencode/clone-tarballs/`).
* логи/срезы: `/tmp/opencode/stage146-{off,on}-soak.txt`, `stage146-{off,on}-loop-source.txt`,
  `stage146-{off,}-soak.sh`, `stage146-on-{preregen,postregen,s2}.txt`, `stage146-ih.{headers,png}`,
  `stage146-pv.png`, `env.staging.bak`, `orchestrator.fixed.js`, `debug-routes.fixed.cjs`.
* вспомогательное (унаследовано от Stage 145): `stage145-replay.sh`, `stage145-heartbeat.sh`,
  `stage145.cookies`, `stage145_mini.vbook`, PNG `iu-{red,green,blue,yellow,magenta}.png`,
  `silence.mp3`.
* D1-детектор: `/tmp/opencode/scan-req-scope.js`.
