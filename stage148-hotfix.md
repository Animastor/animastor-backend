# Stage 148 — версии, тесты, staging, процедура выпуска (ветка hotfix/d1-d2-a1)

**Статус:** части 2–6 выполнены. Код `a5eb3d76` (часть 1, D1/D2/A1) **не менялся** —
добавлены только коммиты версий и этот отчёт. Прод не тронут; `deploy/.env`, прод-контейнеры,
прод-БД/Redis, `main`, merge, `npm publish`, CI-релиз образа — не трогались/не выполнялись.
Dirty-файлы рабочей копии `/home/animastor/animastor-backend` не изменялись (индексация только по именам).

> Self-reference невозможен: хеш коммита этого документа сообщается в чат после push.

---

## 1. Коммиты

| Ветка | Коммит | Содержание |
|---|---|---|
| `hotfix/d1-d2-a1` | `674d225e` `chore(hotfix): orchestration 0.1.7 + backend ^0.1.7 (hotfix line on 0.1.4)` | версии/lock/CHANGELOG (п. 2) |
| `hotfix/d1-d2-a1` | `a5eb3d76` (часть 1, без изменений) | D1 + D2 + A1 + регрессионные тесты |
| `stage143a-foundation-phase1` | `50b664a5` `chore(orchestration): split the version line 0.1.6 -> 0.2.0 (stage143a)` | разведение версий (п. 3) |

### `git diff --stat 78e8f1ae` (после коммита `674d225e`)

```
 HOTFIX-NOTES.md                                    |  38 ++
 backend/package-lock.json                          |   8 +-
 backend/package.json                               |   2 +-
 backend/src/routes/debug-routes.cjs                |   6 +-
 .../postgres/repositories/scene-assets-repo.js     |  19 +
 backend/src/storage/runtime-persistence-adapter.js |   9 +
 backend/tests/stage146-d2-debug-runtime.test.js    |  82 ++
 backend/tests/stage147-a1-null-build-gate.test.js  | 409 +++++++++++++++++++++
 packages/animastor-orchestration/CHANGELOG.md      |  46 ++++
 packages/animastor-orchestration/package-lock.json |   4 +-
 packages/animastor-orchestration/package.json      |   2 +-
 .../src/orchestration/orchestrator.js              |  39 +-
 .../src/runtime/persistence-port.js                |   6 +-
 .../test/stage146-d1-artifact-naming.test.js       | 103 ++++
 .../test/stage147-a1-null-build-gate.test.js       | 211 ++++++++++++
 15 files changed, 964 insertions(+), 20 deletions(-)
```

---

## 2. Версии

### Ветка хотфикса (`674d225e`, ровно 5 файлов — «ничего больше»)

| Файл | Было | Стало |
|---|---|---|
| `packages/animastor-orchestration/package.json` | `0.1.4` | **`0.1.7`** |
| `packages/animastor-orchestration/package-lock.json` | `0.1.2` (2 места) | **`0.1.7`** (2 места) |
| `packages/animastor-orchestration/CHANGELOG.md` | отсутствовал | **новый**: запись `0.1.7` — хотфикс-линия поверх `0.1.4`; в пакете D1 + A1-gate, D2 и серверная часть A1 (`scene-assets-repo.getAssetNullBuild` + адаптер + декларация порта) идут в backend |
| `backend/package.json` | `^0.1.4` | **`^0.1.7`** |
| `backend/package-lock.json` | range `^0.1.4`, entry `0.1.4` | range **`^0.1.7`**, entry `0.1.7` + `resolved`/`integrity` тарболла, собранного `npm pack` **из дерева этого коммита** |

Integrity тарболла `0.1.7` (вписан в lock):

```
sha512-6jh4TES62ldg5Wa8g6b5kWm0xrT80VyGS77bhm0UaexvJofPl76RkApsE2ItfO3zE2qmnUWTuaXqcA9DPi9wRQ==
```

`0.1.7` > опубликованного `0.1.5` и веточного `0.1.6` ⇒ `^0.1.x` разрешится в хотфикс-релиз,
а не в линию без фиксов. Симлинк `backend/node_modules/@animastor/orchestration` в коммит не попал
(`git status` worktree чист, индексация по именам).

### Ветка 143a (`50b664a5`, те же 5 файлов)

| Файл | Было | Стало |
|---|---|---|
| `packages/animastor-orchestration/package.json` | `0.1.6` | **`0.2.0`** |
| `packages/animastor-orchestration/package-lock.json` | `0.1.6` (2 места) | **`0.2.0`** (2 места) |
| `packages/animastor-orchestration/CHANGELOG.md` | запись `0.1.6` сверху | **новая запись `0.2.0`**: разведение линий; помечено, что хотфикс-линия `0.1.7` отдельна и отрезана от `0.1.4` |
| `backend/package.json` | `^0.1.6` | **`^0.2.0`** |
| `backend/package-lock.json` | range `^0.1.6`, entry `0.1.6` | range **`^0.2.0`**, entry `0.2.0` + integrity тарболла `0.2.0` из дерева ветки |

Integrity тарболла `0.2.0`:

```
sha512-u4ihgXD3DzdEMhsN4flpkpharUW8wV18+LProF612okocuEqRl6CdsAXfbedBcQk/135t9EnNa6eIgNcGj/DwA==
```

**Проверка «нигде нет `^0.1.x` для orchestration»** (`git grep '@animastor/orchestration": "\^0\.1'`
и `orchestration-0.1\.\*` по `*.json/*.yml/*.yaml/*.toml` в дереве ветки): **0 совпадений** —
manifest/lock/CI чисты. Единственное текстовое вхождение `^0.1.x` осталось в **историческом**
отчёте `stage143a-fix-and-phase2a.md:157` (таблица того, что делалось на той стадии:
«bump `@animastor/orchestration@^0.1.5`») — переписывать прошлые отчёты я не стал;
это документ, а не манифест.

---

## 3. Тесты

Окружение всех прогонов: node v22.22.3, npm 10.9.8, **свежие клоны** (не worktree),
изолированный PG `127.0.0.1:55432` (`PG_DB=stage143a` через окружение, `PG_USER=postgres`),
Redis `127.0.0.1:56379`, `ANIMASTOR_DOCS_ROOT=/home/animastor/animastor-docs`.
`npm ci` в `backend/` с локальным тарболлом через `npm cache add` (непубликуемая версия,
остальные 399 зависимостей — из lock; integrity тарболла = lock). Для arch-набора в клонах
доустановлены package-зависимости (`npm install --package-lock=false` в `packages/*`) —
это только тест-окружение, в коммиты не входит (на dirty-клоне `git status` чист).

### 3.1 Хотфикс — свежий клон `hotfix/d1-d2-a1` @ `674d225e`

Установлено: `npm ls @animastor/orchestration` → **0.1.7** (реальная директория, не симлинк).

| Набор | Команда | Итог |
|---|---|---|
| D1 (пакет) | `mocha test/stage146-d1-artifact-naming.test.js` | **1/1** |
| D2 (backend) | `mocha tests/stage146-d2-debug-runtime.test.js` | **1/1** |
| A1 (backend, юнит 7 + **PG-часть 6**) | `mocha tests/stage147-a1-null-build-gate.test.js` | **13/13**, PG-часть **6/6** |
| A1 (пакет) | `mocha test/stage147-a1-null-build-gate.test.js` | **6/6** |
| arch | `npm run test:arch` | **933 passing / 24 pending / 2 failing** (обе — базовые, см. 3.3) |
| пакет orchestration | `npm test` | **26 passing / 0 failing** (на этом базе в пакете 4 файла) |
| полный backend suite | `npx mocha --exit "tests/**/*.test.js"` | **3299 passing / 28 pending / 3 failing** (все 3 — базовые, см. 3.3) |

### 3.2 База — свежий клон чистого `78e8f1ae` с теми же 4 тестовыми файлами

| Набор | Итог | Характер падения |
|---|---|---|
| A1 backend (`stage147-a1-null-build-gate`) | **7 passing / 6 failing** | юнит: `A1-репро` и `строка другого билда не доказывает версии`; PG: `A1-репро → READY+build_id`, `идемпотентен через цикл dispatch→completion`, `другой билд И NULL-строка`, `репозиторий-контракт: getAssetNullBuild` (`TypeError: repo.getAssetNullBuild is not a function`) |
| A1 пакет | **4 passing / 2 failing** | gate-фолбэк не срабатывает |
| D1 (пакет) | **0/1 — failing** | `ReferenceError: artifactNaming is not defined` |
| D2 (backend) | **0/1 — failing** | `AbortError: This operation was aborted` (запрос висит) |
| полный backend suite | **3292 passing / 28 pending / 10 failing** | 7 = регрессионные (1 D2 + 6 A1), 3 = базовые (см. 3.3) |

> **Про «все 5 тестов A1 backend».** На чистом `78e8f1ae` падает **6** из 13, а не 5:
> те 5, что перечислены в коммите `2754bc0f`, плюс `репозиторий-контракт getAssetNullBuild`,
> который не может пройти без нового op (на `41cc0313` его тоже нет — т.е. там тоже 6).
> PG-часть: **падает до (4 из 6 упавших + 2 негативных, которые и должны проходить),
> проходит после — 6/6.** Код фиксов из-за этого не трогал.

**Сравнение «новых падений у хотфикса»:** база 10 failing → хотфикс 3 failing; все 3
присутствуют одинаково на `78e8f1ae`. Passing: `3299 = 3292 + 7` — ровно 7 тестов,
которые чинят D1/D2/A1. **Новых падений у хотфикса нет.**

### 3.3 Три базовых (не-хотфиксных) падения — причины

Одинаково падают и на `78e8f1ae`, и на `674d225e`; на ветке 143a их нет:

1. `tests/ai-shared-inference.test.js` → `16b`: базовая версия теста ждёт `expect(n).to.equal(0)`,
   а health-check для connector-снапшота возвращает `1` для живого коннектора. На 143a тест
   исправлен коммитом `22910d29` (`registry.isLive(...) ? 1 : 0`). На базе — устаревшее ожидание.
2. `tests/architecture/installer-package-boundary.test.js` → `IB-G15`: база ждёт
   `private: true`, а `packages/animastor-installer/package.json` на базе его не имеет
   (на 143a сам тест переписан под опубликованный публичный пакет).
3. `tests/architecture/phase5-runtime-result.test.js` → `T9`: читает `backend/src/runtime/index.js`,
   которого на базе нет (бочка `lazyRequire` удалена; на 143a тест научен пропускать случай
   «файла нет»).

Все три — свойство базы/устаревших тест-файлов, не регрессия хотфикса.

### 3.4 Ветка 143a — свежий клон @ `50b664a5`, локальный тарболл `0.2.0`

Установлено: `npm ls @animastor/orchestration` → **0.2.0**.

| Набор | Итог |
|---|---|
| `npx mocha --exit "tests/stage143a-*.test.js"` | **100 passing / 0 failing** |
| `npm run test:arch` | входит в полный (арх-набор на ветке зелёный) |
| полный backend suite | **3613 passing / 28 pending / 0 failing** (rc=0) |

### 3.5 Судьба двух падающих тестов Stage 147

Stage 147 фиксировал `3610 passing / 28 pending / 2 failing`: (а) Redis `before all`
connection flake, (б) assertion в ai-sharing (`ai-endpoint-sharing`) — оба признаны
средовыми.

**Тот же клон на `41cc0313`** (тарболл `0.1.6`, пересобранный `npm pack` из дерева этого коммита —
integrity `sha512-d/Q0k4…` совпала с lock, `npm ci` чистый):

| Прогон | Итог |
|---|---|
| клон `50b664a5` (после п. 3) | **3613 passing / 28 pending / 0 failing** |
| тот же клон на `41cc0313` | **3600 passing / 28 pending / 0 failing** |

(3613 − 3600 = 13 — ровно файл A1-backend, добавленный позже коммитом `2754bc0f`.)

**Вывод: оба теста НЕ падают ни на `41cc0313`, ни на `50b664a5` — воспроизвести их не удалось,
значит в Stage 147 это были транзиентные средовые сбои, а не состояние кода:**
- (а) Redis `before all` flake — разовый сбой подключения к изолированному Redis `56379`
  в хуке `before` (в Stage 147 после этого файл гонялся изолированно и дал 5/5;
  кандидат — `stage143a-flag-off.test.js`: ровно 5 тестов с `before()`);
- (б) ai-sharing assertion — в обоих наших полных прогонах проходит; класс сбоя, зависящий
  от состояния общего dev-PG/timing (в рабочей копии лежит незакоммиченный тест-фикс этого класса,
  я его не трогал).

**Давние/средовые, регрессий нет.** Ни одного нового падения ни на одной из веток.

---

## 4. Staging

**Сборка.** Свежий клон `hotfix/d1-d2-a1` @ `674d225e` → `/home/animastor/staging-144/src`
(предыдущий staging-клон сохранён рядом как `src-prev-2754bc0f`). Только в staging-клоне
(в коммит не входит, как в Stage 146/147): тарболл `0.1.7` в `backend/.deps/`,
`backend/package.json` → `file:.deps/animastor-orchestration-0.1.7.tgz`, в `backend/Dockerfile`
строка `COPY .deps ./.deps`; `IU_IMAGE_VERSIONED` **убран** из `.env.staging`
(флаг не задан, как в проде; на самом хотфикс-ветке контура versioned-IU вообще нет).
Пересборка: `docker compose -p animastor-staging --env-file .env.staging -f docker-compose.staging.yml up -d --build`.

**В образе действительно 0.1.7:**

```
$ docker exec staging-backend npm ls @animastor/orchestration
`-- @animastor/orchestration@0.1.7
$ docker inspect staging-backend → env: IU_IMAGE_VERSIONED=   (флаг выключен)
```

**Сценарий** (книга `stage145_mini` / `ch-a1b2c3` / `sc-d4e5f6` / build `stage145_build1`,
loopback-only порты, prod-сеть и prod-контейнеры не использовались):

| # | Шаг | Результат |
|---|---|---|
| 1 | `PATCH …/scene/ch-a1b2c3/sc-d4e5f6 {"unit_id":"iu-000001","fields":{"text":…}}` | **HTTP 200**, `content_version 5→6`, `dirty_unit_ids={iu-000001,2,3}` |
| 2 | `POST …/stage145_mini/regenerate {"chapter_id":…,"scene_id":…,"worker_types":["image"]}` | **HTTP 200** (D1; в Stage 145 здесь был 500 `artifactNaming is not defined`), 3 image-job'а ушли (`IMAGE_DISPATCHED: 3 IU job(s) sent`) |
| 3 | replay результата: `POST /gpu/task/result` ×3 | `{"ok":true}` ×3 → `IMAGE_CALLBACK → READY check passed` → `[PG-IMAGE-READY] status=ready` → **`[COMPLETE-STAGE] … image → READY`** ⇒ **сцена READY** ✅ |
| 4 | `scene_assets` | `image … status=ready` ✅, **`build_id` остался `NULL`** ⚠️ — см. отклонение ниже |
| 5 | 15 мин (06:37:22Z → 06:52:28Z, 16 срезов/60s) | `stale_total=0` и `cachehits_total=0` **в каждом срезе** ⇒ `[VERSION-GATE] … stale` не растёт, циклов `cache_hit` нет ✅ (всего в логе: `grep -c VERSION-GATE` = **0**, `grep -c cache_hit` = **0**) |
| 6 | `GET /api/v1/debug/runtime/status` | **HTTP 200** `{"stats":…,"active_scenes":1}` ✅ (D2) |

**Прод не тронут (после прогона):** `animastor-backend` Up 5 days, `animastor-pg`/`animastor-redis`
Up 2 months (healthy), `gpu-hub` Up 2 weeks, `animastor-proxy` Up 8 days; `deploy/.env` не менялся.

### 4.1 Отклонение: `build_id` у ready-строки НЕ проставлен (код не исправлял)

Требование чек-листа «у строки `scene_assets` проставлен `build_id`» **не выполнено**:
ready-строка осталась с `build_id = NULL` (при этом сам A1-сценарий закрыт — READY достигнут,
циклов нет).

**Причина (легаси-путь, флаг OFF):** `handleImageCompleted` кладёт в `artifact.path` результат
`resolveCanonicalSceneImage`, а это **имя файла** из `readdirSync`-фильтра
(`stage145_mini_ch-a1b2c3_sc-d4e5f6_iu-000001.png`), а не абсолютный путь. Дальше
`completeStage` → `markReady(artifactPath)` → `buildIdFromArtifactPath()` требует путь **под**
`OUTPUT_DIR` (`/data/output/...`) → возвращает `null` → `upsertAsset(build_id=null)` уходит в
`upsertAssetWithNullBuildId`, который обновляет только `status/path` и не трогает `build_id`.

**Это свойство базового (продового) кода, а не хотфикса:**
- audio-строка того же билда получает `build_id=stage145_build1` — её `artifactPath` абсолютный
  (`/data/output/stage145_build1/…mp3`), т.е. сам механизм штампа работает;
- на ветке 143a при флаге OFF Stage 146 §5.2 зафиксировал ровно то же самое:
  `path=…_iu-000001.png (относительный), build_id=NULL`;
- логика самой A1 не пострадала: gate прошёл, READY записан, `[VERSION-GATE] stale` = 0;
  unit+PG-тесты A1 — 13/13 (в них `artifactPath` абсолютный, оттого в тестах `build_id` проставляется).

**NB (что именно сработало в живом прогоне):** в этой книге уже существует строка
`build_id=stage145_build1` (staging-прогон Stage 147), её версия была застампована на dispatch
(6 = версии сцены) ⇒ гейт прошёл по **основному** чтению. Фолбэк `getAssetNullBuild` вживую не
понадобился — он покрыт PG-слоем тестов (6/6).

По инструкции **код не исправлял**. Решение за владельцем: (а) отдельной задачей чинить легаси
image-artifact path (абсолютный путь в `resolveCanonicalSceneImage`/`handleImageCompleted`),
либо (б) принять `build_id=NULL` для флага OFF и считать критерий выполненным через READY+отсутствие
цикла.

---

## 5. Процедура выпуска для владельца

### 5.1 Публикация `@animastor/orchestration@0.1.7`

Из **чистого клона** ветки (не worktree):

```sh
git clone -b hotfix/d1-d2-a1 git@github.com:Animastor/animastor-backend.git /tmp/hf-release
cd /tmp/hf-release/packages/animastor-orchestration
npm publish                      # publishConfig.access=public; только владелец, после cleanup
npm view @animastor/orchestration@0.1.7 dist.integrity
npm view @animastor/orchestration@0.1.7 dist.tarball
```

Ожидаемый integrity (**обязательно сверить с `backend/package-lock.json` коммита `674d225e`**):

```
sha512-6jh4TES62ldg5Wa8g6b5kWm0xrT80VyGS77bhm0UaexvJofPl76RkApsE2ItfO3zE2qmnUWTuaXqcA9DPi9wRQ==
```

Расхождение → `npm ci` в проде упадёт EINTEGRITY, публикацию надо пересобрать из того же дерева.
`0.1.6` не публиковать; `npm publish` в рамках Stage 148 **не выполнялся** (запрещён ТЗ).

### 5.2 Сборка прод-образа (GHCR)

- **Workflow:** `.github/workflows/backend-ghcr-release.yml`, **только `workflow_dispatch`**
  (push-триггера нет — само по себе пушение коммита ничего не собирает).
- **Входные данные:** `commit` (иммутабельный исходный коммит) и `image_tag`
  (напр. `deploy-674d225`; теги должны быть новыми — публикация `:latest` и перезапись
  существующего тега workflow отклоняет).
- **Approve-коммит НУЖЕН.** В `env` workflow лежит `APPROVED_COMMIT` (сейчас `78e8f1ae…`);
  прогон падает (`PROVENANCE FAIL`), если `backend/`-дерево запрошенного коммита отличается от
  `APPROVED_COMMIT`, либо если тот не найден в истории (checkout `fetch-depth: 10`).
  Как делалось в прошлых стадиях — одним строкочным коммитом, например
  `53ce5045 ci(backend): approve 78e8f1ae backend tree for GHCR release (stage 105)`,
  `82c80afd … (stage 76)`:
  изменить ровно `APPROVED_COMMIT: <sha хотфикс-коммита>` в этом файле, сообщение
  `ci(backend): approve 674d225e backend tree for GHCR release (stage 148)`, запушить **до** запуска.
- **Порядок запуска (как в Stage 105):** Actions → `backend-ghcr-release` →
  *Use workflow from* = ветка с approve-коммитом → `commit = 674d225e` → `image_tag = deploy-674d225e`.
  Дерево `backend/` у `674d225е` и у approve-коммита идентично (approve-коммит меняет только `.github`),
  поэтому gate проходит, а ревизионный label образа будет `674d225e`.
- Что делает прогон: сборка `docker build ./backend` (без build-args и секретов) →
  изолированный smoke (эфемерный redis, `/health` 200 + `redis: PONG`, 0 crash-сигнатур,
  побайтовая sha256-сверка `src/backend.cjs`, `package.json`, `package-lock.json`, `Dockerfile`
  образа с исходником, сверка OCI-label) → логин в GHCR через секрет `GHCR_IMAGE_PAT`
  (fallback `GITHUB_TOKEN`) → push тегов `deploy-<short-sha>` **и** полного SHA.
- **Важно:** образ выполняет `npm install` в `backend/` ⇒ `@animastor/orchestration@0.1.7`
  должен быть **уже опубликован** (иначе E404) — сначала §5.1, потом §5.2.
- Запуск CI-релиза мне запрещён — выполняет владелец.

### 5.3 Обновление прод-контейнера

```sh
# 1) deploy/.env:  BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:<новый digest>
cd /home/animastor/animastor-backend/deploy
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d
```

`--project-name animastor` обязателен (иначе другие имена томов pg-data/redis-data);
оба `-f` всегда вместе (иначе backend останется без image-pin). Файл `deploy/.env` в Stage 148
не менялся — правит только владелец.

**Что проверить после деплоя:**

```sh
# версия пакета в контейнере
docker exec animastor-backend node -e "console.log(require('/app/node_modules/@animastor/orchestration/package.json').version)"
# → 0.1.7
# ревизия образа
docker inspect animastor-backend --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
# → ожидаемый коммит
# /health
docker exec animastor-backend node -e "require('http').get('http://127.0.0.1:3000/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log(r.statusCode,d);process.exit(0)})})"
# D2 — debug runtime отвечает (прод без host-портов → через docker exec)
docker exec animastor-backend node -e "require('http').get('http://127.0.0.1:3000/api/v1/debug/runtime/status',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log(r.statusCode);process.exit(0)})})"
# → 200
# отсутствие цикла A1/D1 (не растёт с течением времени)
docker logs animastor-backend --since 10m 2>&1 | grep -c 'VERSION-GATE.*stale'   # → 0
docker logs animastor-backend --since 10m 2>&1 | grep -c 'cache_hit'              # → 0
# регенерация одной сцены: PATCH текста юнита → POST /api/v1/book/<book>/regenerate
#   → HTTP 200 (D1) и в логах '[COMPLETE-STAGE] … → READY' (A1), без повторов каждые 5 с
```

`IU_IMAGE_VERSIONED` в проде по-прежнему не задан (как и сейчас).

### 5.4 Откат

```sh
# deploy/.env:  BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd
cd /home/animastor/animastor-backend/deploy
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d
```

Текущий (до-релизный) прод-образ: `ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd`
(revision `78e8f1ae`, orchestration 0.1.4). Откат = вернуть этот digest и пере-up.

---

## 6. Границы (что не делал)

- не менял код `a5eb3d76`; в коммит `674d225e` вошли ровно 5 файлов версий, в `50b664a5` — те же 5;
- симлинк `backend/node_modules/@animastor/orchestration` не индексировался;
- не трогал: прод-контейнеры/БД/Redis/данные, `deploy/.env`, `main`, merge, `npm publish`,
  запуск CI-релиза образа; push — обычный, без force;
- dirty-файлы `/home/animastor/animastor-backend` не изменялись (`git add` только по именам);
- падение логики D1/D2/A1 не «чинил» — в §3.2 и §4.1 описано и остановлено на этом.
