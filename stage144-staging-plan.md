# Stage 144 — подготовка staging для `IU_IMAGE_VERSIONED`

**Тип:** проверка и план. Production-код не менялся, контейнеры/PG/Redis/compose/`.env` прода
не трогались, флаг нигде не включался, `main` не тронут, merge/deploy/npm publish не выполнялись,
dirty-файлы рабочей копии не изменялись. В коммит включён только этот документ.

**Ветка:** `stage143a-foundation-phase1`. **База (проверяемый коммит):**
`6f2774942193b27140f2b61e9e293462a986500e` — `fix(stage143a): preview must honour the published
pointer over a stale legacy source`.

> Self-reference невозможен: хеш коммита этого документа сообщается в чат после push и не
> записывается внутрь файла.

---

## Часть 1. Сборка на опубликованных пакетах (выполнено)

### 1.1. Свежий клон

```bash
rm -rf /tmp/opencode/stage144-clone
git clone --branch stage143a-foundation-phase1 \
  git@github.com:Animastor/animastor-backend.git /tmp/opencode/stage144-clone
cd /tmp/opencode/stage144-clone && git checkout 6f277494
git rev-parse HEAD   # 6f2774942193b27140f2b61e9e293462a986500e
```

Клон **чистый** (`git status --short` пуст), чужие dirty-файлы рабочей копии в него не попадают.

### 1.2. `npm ci` строго из npm-реестра

Чтобы исключить любой локальный тарболл и `npm cache add`, установка выполнена с **отдельным,
предварительно пустым npm-кэшем**:

```bash
cd /tmp/opencode/stage144-clone/backend
rm -rf /tmp/opencode/stage144-npmcache
npm ci --cache /tmp/opencode/stage144-npmcache --no-audit --no-fund
```

* Результат: `added 399 packages in 6s`, **exit 0**.
* В свежем кэше нет ни одного `*animastor*.tgz` (`find /tmp/opencode/stage144-npmcache -name '*animastor*.tgz'` → пусто) —
  пакеты реально скачаны из `registry.npmjs.org`.
* `node v22.22.3`, `npm 10.9.8`.

### 1.3. Установленные версии и integrity

```bash
npm ls @animastor/orchestration @animastor/player
```

```
animastor-backend@0.1.0 /tmp/opencode/stage144-clone/backend
├── @animastor/orchestration@0.1.5
└── @animastor/player@0.1.3
```

Integrity сверена в трёх точках — `package-lock.json` = `node_modules/.package-lock.json` =
`npm view <pkg> dist.integrity` (т.е. фактически опубликованный тарболл):

| Пакет | integrity (все три совпадают) |
|---|---|
| `@animastor/player@0.1.3` | `sha512-YEqz0AymH8vIdba2JCrrKDZ5KAMHVUtBWoSPs/nOISLAQOxl3ecXDl60lNpdld5yP1G5q7akMOq1MUYd7m6Jjw==` |
| `@animastor/orchestration@0.1.5` | `sha512-8ksja0Je0ehpTO5iXdd0yHWKCn+9ybdqeYLy3zF+ZpFJ0cXs9L8nGKYyBEzk1YBswETK2bJrEvyCkiRgpxhtyw==` |

Вывод: **блокер прошлых стадий снят** — `@animastor/orchestration@0.1.5` и `@animastor/player@0.1.3`
опубликованы, `npm ci` больше не требует локального workaround (`npm pack` + `npm cache add`),
и поставляемый код N6/N7 уже резолвится из реестра.

### 1.4. Прогоны (изолированные PG/Redis)

Окружение (прод не задействован; контейнеры `stage143a-pg`/`stage143a-redis` существовали до этой
стадии и не пересоздавались):

```bash
export PG_HOST=127.0.0.1 PG_PORT=55432 PG_DB=stage143a PG_USER=postgres PG_PASSWORD=stage143a
export REDIS_HOST=127.0.0.1 REDIS_PORT=56379
export ANIMASTOR_DOCS_ROOT=/home/animastor/animastor-docs
```

| # | Набор | Команда | Итог |
|---|---|---|---|
| 1 | stage143a | `npx mocha --exit "tests/stage143a-*.test.js"` | **100 passing, 0 failing** (~1s) |
| 2 | architecture | `npm run test:arch` | **935 passing, 24 pending, 0 failing** (~4s) |
| 3 | полный backend suite | `npx mocha --exit "tests/**/*.test.js"` | **3599 passing, 28 pending, 0 failing** (1m57s, rc=0) |

Лог полного прогона: `/tmp/opencode/stage144-fullsuite.log`. Числа совпадают с clean-clone
прогоном Phase 2b/2c (§8 отчёта `stage143a-phase2bc.md`, коммит `90f8c840`).

> Замечание (повтор из прошлых стадий): `npm test` из-за отсутствия shell globstar фактически
> разворачивает только `tests/*/*.test.js`; полный suite — только с кавычками
> `npx mocha --exit "tests/**/*.test.js"`.

**Итог части 1: PASS.** Ветка на опубликованных пакетах ставится и проходит полный набор на чистом
клоне без локальных тарболлов.

---

## Часть 2. План staging (исследование; ничего не запускалось)

### 2.1. Существует ли staging сейчас?

**Отдельного staging-окружения нет** — ни на VPS, ни в compose.

Инвентаризация (read-only):

* Запущенные контейнеры: `animastor-backend`, `animastor-pg`, `animastor-redis`, `gpu-hub`,
  `animastor-proxy` — это **production** (compose project `animastor`, рабочий каталог
  `/home/animastor/animastor-backend/deploy`). Плюс тестовые/отладочные `stage143a-pg`,
  `stage143a-redis`, `a135/a136/a138-redis`, `repro-redis`, `buildx_buildkit_repro0`.
* Compose-файлы: prod `deploy/docker-compose.yml` + `deploy/overlay-backend-standalone.yml`;
  вспомогательные `docker/compose/overlay-backend-standalone.yml`,
  `overlay-gpu-hub-standalone.yml`, `overlay-gpu-hub-local.yml`. **Staging-проекта нет.**
* Prod backend: образ `ghcr.io/animastor/animastor-backend@sha256:f6aefe…` (revision `78e8f1a`),
  `HUB_URL=http://gpu-hub:5000`, `PG_DB=animastor`, `OUTPUT_DIR=/data/output`
  (`/home/animastor/animastor/data/output`), `SHARE_FEATURES_ENABLED=1`,
  `IU_IMAGE_VERSIONED` **отсутствует** ⇒ флаг OFF.
* GPU: `nvidia-smi` на этом VPS отсутствует — GPU-воркеры живут на отдельном боксе и обращаются
  к хубу по сети.

### 2.2. Целевая изолированная топология (предложение, НЕ запускалось)

Отдельный compose-**проект** `animastor-staging` в отдельном каталоге (рекомендуется durable
`/home/animastor/staging-144/`, не в `/tmp`). Никакого `nginx`, никакого публичного домена, все
порты — только loopback.

Ключевой факт: backend жёстко подключается к Redis по имени `redis`
(`src/backend.cjs:299 → new Redis({ host: 'redis', port: 6379 })`) и берёт хуб из `HUB_URL`.
Поэтому в staging-compose **имена сервисов** должны быть `postgres`, `redis`, `gpu-hub`
(DNS внутри сети проекта), а `container_name` — уникальные.

`docker-compose.staging.yml` (эскиз):

```yaml
name: animastor-staging
networks: { net: { driver: bridge } }
volumes:  { staging-pg-data: {}, staging-redis-data: {} }

services:
  postgres:
    image: postgres:16
    container_name: staging-postgres
    environment:
      POSTGRES_DB: animastor_staging
      POSTGRES_USER: staging
      POSTGRES_PASSWORD: ${STAGING_PG_PASSWORD:?}
    ports: ["127.0.0.1:55433:5432"]          # loopback, отдельная БД
    volumes: ["staging-pg-data:/var/lib/postgresql/data"]
    networks: [net]

  redis:
    image: redis:7
    container_name: staging-redis
    ports: ["127.0.0.1:56380:6379"]          # loopback, отдельный Redis
    volumes: ["staging-redis-data:/data"]
    networks: [net]

  gpu-hub:
    image: ghcr.io/animastor/animastor-gpu-hub@sha256:3611c64461049489c048a4d200836ff36fbd5e083a96a3c3c3b752c12eb793c0
    container_name: staging-hub
    environment:
      - REDIS_URL=redis://redis:6379
      - BACKEND_URL=http://backend:3000      # ← callback только в staging backend
      - GPU_HUB_API_KEY=${STAGING_HUB_API_KEY:?}
      - GPU_TIMEOUT=600000
      - SHARE_FEATURES_ENABLED=0
    networks: [net]                          # порт НЕ публикуется

  backend:
    build: ./src/backend                     # свежий клон 6f277494
    container_name: staging-backend
    environment:
      - HUB_URL=http://gpu-hub:5000
      - PG_HOST=postgres
      - PG_PORT=5432
      - PG_DB=animastor_staging
      - PG_USER=staging
      - PG_PASSWORD=${STAGING_PG_PASSWORD:?}
      - WORKSPACE_SECRET_KEY=${STAGING_WORKSPACE_SECRET_KEY:?}   # отдельный секрет
      - GPU_HUB_API_KEY=${STAGING_HUB_API_KEY:?}                 # отдельный ключ
      - COOKIE_DOMAIN=
      - SHARE_FEATURES_ENABLED=0
      # - IU_IMAGE_VERSIONED=1        # ← только после отдельного разрешения владельца
    ports: ["127.0.0.1:3100:3000"]
    volumes:
      - /home/animastor/staging-144/data/output:/data/output
      - /home/animastor/staging-144/data/books:/data/books
    depends_on: [postgres, redis]
    networks: [net]
```

Команды (эскиз, выполнять только после разрешения):

```bash
mkdir -p /home/animastor/staging-144/{data/output,data/books}
git clone --branch stage143a-foundation-phase1 \
  git@github.com:Animastor/animastor-backend.git /home/animastor/staging-144/src
git -C /home/animastor/staging-144/src checkout 6f277494
cd /home/animastor/staging-144
# .env.staging: STAGING_PG_PASSWORD, STAGING_WORKSPACE_SECRET_KEY, STAGING_HUB_API_KEY (chmod 600)
docker compose -p animastor-staging --env-file .env.staging \
  -f docker-compose.staging.yml up -d --build
```

Инварианты изоляции (проверяемые): имя проекта `animastor-staging` ≠ `animastor`; отдельные
container_name; отдельные тома/БД/Redis/`OUTPUT_DIR`; отдельные `GPU_HUB_API_KEY` и
`WORKSPACE_SECRET_KEY`; ни один порт не смотрит публично; staging backend **не** подключён к
prod-сети `animastor_net`.

### 2.3. GPU Hub и воркеры — изоляция (главный риск)

**Как устроен callback (по коду):**

1. Worker забирает задачу из очереди хаба и присылает результат на **хаб**: `POST /task/result`
   (claimer-only).
2. Хаб пересылает результат на **`${BACKEND_URL}/gpu/task/result`** с заголовком
   `x-api-key: GPU_HUB_API_KEY` (`gpu-hub.js`, `backendHeaders()`); при недоставке — резервный
   ключ `animastor:result:{job_id}` в Redis.
3. Хаб подключён к **общему** prod-Redis (`REDIS_URL` по умолчанию `redis://animastor-redis:6379`):
   очереди `animastor:queue:{type}[:ws:{workspace}]`, реестр воркеров
   `animastor:gpu-hub:workers`, зеркало аутентификации `animastor:worker-auth`, дедуп-ключи
   `animastor:job:*`.
4. `BACKEND_URL` у prod-хаба по умолчанию `http://animastor-backend:3000` (**production**).

**Риски при попытке «просто переиспользовать prod-хаб» со staging-backend:**

* результаты staging уйдут в **production backend** (BACKEND_URL прода), т.е. смешение результатов;
* staging-задачи лягут в **prod-очереди** и могут быть выполнены production-воркерами;
* worker-auth mirror и дедуп-ключи общие ⇒ staging может заблокировать/переиспользовать
  dedup prod-задач; обратная утечка (prod → staging) симметрична;
* общий `GPU_HUB_API_KEY` ⇒ разделение прав невозможно.

**Вывод: безопасной изоляции на общем хабе нет.** Такая конфигурация запрещена.

**Рекомендуемая изоляция (вариант A — «настоящий GPU»):** отдельный **staging-инстанс хаба**
(сервис `gpu-hub` в проекте `animastor-staging`) со **своим Redis** и
`BACKEND_URL=http://backend:3000`, своим `GPU_HUB_API_KEY`. Очереди, worker-auth mirror и
резервные result-ключи живут в staging-Redis и не пересекаются с продом. Требуется **staging-воркер**,
у которого в `HUB_URL` указан staging-хаб (реальный GPU-бокс; `WORKER_TYPE=image`,
`ANIMASTOR_WORKER_TOKEN` из staging-настройки). Ограничения/условия: нужен доступ к GPU-боксу и
время GPU; если staging-хаб только на loopback — воркеру нужен SSH-туннель до этого порта (или
временный проброс, аккуратно с firewall). Токен воркера и workspace — **отдельные** от прода.

**Минимальный вариант (вариант B — «без GPU», debug-replay):** прогнать публикацию без реальной
инференс-модели, вручную доставив callback. Последовательность:

1. В staging (флаг ON) инициировать регенерацию одного IU — backend пошлёт задачу в staging-хаб
   и запишет payload (с `job_id` и `dispatch_id`) в очередь staging-Redis.
2. Достать payload из staging-Redis:
   `redis-cli -p 56380 lrange animastor:queue:image:ws:<staging-workspace> 0 -1`.
3. Собрать синтетический результат (небольшой PNG, base64) и выполнить
   `POST http://127.0.0.1:3100/gpu/task/result` с `x-api-key: <staging GPU_HUB_API_KEY>`,
   телом `{job_id, build_id, dispatch_id, protocol_version, workspace_id, result_base64}`, взяв
   `job_id`/`dispatch_id` **из payload'а** (иначе `verifyDispatchIdentity` отклонит, т.к. intent-fence
   receipt пишется до POST в хаб).
4. Такой replay проходит всю цепочку stage 143a (receipt → reservation → versioned-файл →
   указатель) и все read-side потребители — **кроме** реального Hub-transport и реальных пикселей.

Ограничения варианта B: не проверяется связка «хаб ↔ воркер ↔ GPU» и качество изображения;
требует ручной доставки на каждый прогон; тестируется логика публикации/чтения, а не инференс.
Вариант B рекомендуется для быстрой проверки семантики флага, вариант A — для soak перед продом.

### 2.4. Тестовая книга

Два способа получить книгу, начатую **до** флага:

1. **Копия из прода (только чтение прода, копирование):**
   ```bash
   # BOOKS_DIR прода → staging
   cp -a /home/animastor/animastor/data/books/<bookId> \
         /home/animastor/staging-144/data/books/
   # build-каталог книги → staging OUTPUT_DIR (по манифесту books/<bookId>/manifest.json → build_id)
   cp -a /home/animastor/animastor/data/output/<buildId> \
         /home/animastor/staging-144/data/output/
   ```
   Прод при этом не изменяется. В копии останутся легаси-канонические PNG (созданы при флаге OFF) —
   идеальный старт для сценариев «старые юниты».
2. **Новая небольшая книга при флаге OFF**: поднять staging с `IU_IMAGE_VERSIONED` выключенным,
   создать короткую книгу (1 глава, 1 сцена, 2–3 юнита), дать ей сгенерироваться (или тоже через
   вариант B), затем включить флаг и проверять перегенерацию.

Рекомендуется **оба**: (1) — легаси-юниты и миграция чтения; (2) — чистая проверка перехода
OFF→ON без легаси-шума.

### 2.5. Сценарии проверки (что смотреть)

Везде `build_id` берётся из `books/<bookId>/manifest.json`. Проверки — запросами и SQL.

**S1. Вывод IU-картинок и превью для старых юнитов (флаг ON, легаси-файлы есть).**
* `GET /api/v1/iu-image/:bookId/:chapterId/:sceneId/:iuId?build_id=…` → 200 `image/png`.
* `GET /api/v1/preview/…` → 200, `X-Preview-Created`.
* В логах: легаси-скан находит файл, PG не читается (`resolveIuImagePath` вернёт `absent`).
* Ожидаемо: старые картинки отдаются как раньше.

**S2. Перегенерация одного юнита при флаге ON (новое versioned-издание).**
* Триггер: правка текста юнита + regenerate (или `/debug/runtime/reset-scene` для сцены) — в
  `dirty_unit_ids` появится один IU.
* Ожидаемо:
  * файл `{OUTPUT_DIR}/{buildId}/.versions/{assetId}/{fence}.png` (assetId = `{iuId}`);
  * в PG: `SELECT publish_fence, path FROM iu_image_pointers WHERE book_id=… AND build_id=… AND iu_id=…;`
    → `publish_fence` **больше** прежнего, `path` = `{buildId}/.versions/{assetId}/{fence}.png`;
  * `GET /iu-image/…` → 200, ETag содержит новый `fence`;
  * `GET /preview/…` → 200, `X-Preview-Created: true`, байты отличаются от прежних (каноническое
    превью инвалидировано в task-handler).
* Логи-маркеры: `Fence reservation created … fence=N`, `[IMAGE] CANONICAL IU IMAGE: …`,
  `[DIRTY-UNIT-REGEN] Deleted stale preview: …`.

**S3. Завершение стадии без бесконечной регенерации.**
* `reconcile` (каждые 60s, `runtime-loop.js RECONCILE_INTERVAL_MS`): versioned-only сцена не должна
  получать `missing_image_file` и повторные регенерации (B2: `checkOrphanImageState`/`checkOrphanAssets`
  спрашивают указатель).
* DIRTY-UNITS (B3/N1): `[DIRTY-UNITS-CLEARED] … all N dirty unit(s) completed, cleared`;
  при живом указателе — не должно быть `[DIRTY-UNITS-PARTIAL]`.
* iu-media auto-redispatch (N3/N4): `GET /api/v1/chunk/:id` → `image_ready: true`; **не** должно быть
  `Missing image file … resetting state for redispatch`.
* Отсутствие цикла: повторные запросы `chunk/:id` не порождают новых `Fence reservation`.
* Что смотреть: `SELECT dirty_unit_ids FROM scenes WHERE …;` → `{}`.

**S4. Экспорт storyboard содержит все кадры.**
* `GET /api/v1/book/:bookId/storyboard` → 200 `application/zip`.
* В логе: `[EXPORT] storyboard <bookId> build=… (N images)` — `N` = число кадров сцены (как минимум
  все IU; versioned-only кадры включены через `listBuildPointerPaths`).
* Распаковать и сверить имена/число: канонический `{iuId}.png` (указатель побеждает легаси).
* Негатив-контроль: битый указатель → файл скипается с логом; пустой результат → 404 (но не
  «усечённый, но выглядящий полным» zip).

**S5. Откат флага.**
1. Флаг OFF (убрать `IU_IMAGE_VERSIONED`, перезапустить staging-backend) → легаси-поведение:
   `/iu-image` отдаёт канонический файл, 0 обращений к PG (`resolveIuImagePath` → `null` без запроса);
   `/preview`, `/storyboard`, `chunk/:id` — как до включения; указатель инертен (строки в PG остаются).
2. Перед **повторным** включением — обязательный операторский SQL из
   `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js` (блок `OPERATOR RULE (contract B7)`):
   ```sql
   DELETE FROM iu_image_pointers            WHERE book_id = $1 AND build_id = $2;
   -- или все билды книги: WHERE book_id = $1;
   DELETE FROM iu_image_fence_reservations  WHERE book_id = $1 AND build_id = $2;   -- опционально
   ```
   Запрещено: ручной `UPDATE` указателя, удаление immutable-файлов `.versions/**`.
3. После SQL снова включить флаг (рестарт обязателен: DDL `iu_image_*` создаётся в
   `schema.js` только при флаге ON ⇒ таблицы должны существовать до первой резервации).

### 2.6. Откат и уборка staging

```bash
# остановить и удалить ТОЛЬКО staging (тома staging)
cd /home/animastor/staging-144
docker compose -p animastor-staging --env-file .env.staging \
  -f docker-compose.staging.yml down -v --remove-orphans
rm -rf /home/animastor/staging-144          # каталоги data/output, data/books, src, .env.staging
docker rmi staging-backend 2>/dev/null       # образ, собранный локально (если тегировался)
```

Правила безопасности уборки: `-p animastor-staging` (никогда `-p animastor`), явное перечисление
томов staging, проверка `docker ps -a` перед удалением; prod-контейнеры `animastor-*` и `gpu-hub`
не останавливать/не удалять; prod-каталоги `/home/animastor/animastor/data/**` при уборке не трогать.

### 2.7. Что нужно от владельца

1. **Разрешение на staging** (выполнение части 2) — отдельное, после этого документа.
2. **GPU-ресурс** и способ: (A) выделить staging-воркер на GPU-боксе (время/стоимость, SSH-доступ,
   временный проброс порта хаба) **или** (B) согласиться на debug-replay без GPU (быстрее/дешевле,
   без реального инференса). Если A — какой бокс/воркер, сколько времени на soak.
3. **Тестовая книга**: какая прод-книга подходит для копирования (privacy) либо разрешение создать
   новую книгу при флаге OFF.
4. **N5 (cover-скан в `generation-routes.cjs`)**: dirty-файл, по условию не тронут ⇒ при флаге ON
   возможна лишняя регенерация cover-IU. Решение: (а) сначала отдельный этап с N5, либо
   (б) принять лишнюю регенерацию cover на staging.
5. **Разрешение на включение `IU_IMAGE_VERSIONED` в staging** (отдельно; включается только в staging,
   после рестарта backend). И отдельно — разрешение на **повторное** включение после отката
   (с обязательным SQL B7).
6. **Секреты staging**: сгенерировать `STAGING_PG_PASSWORD`, `STAGING_WORKSPACE_SECRET_KEY`,
   `STAGING_HUB_API_KEY` (не равны прод-значениям). Кто вносит `chmod 600 .env.staging`.
7. **Локальная сборка staging-образа backend** из ветки `6f277494` (прод-образ `78e8f1a` не
   задействуется) — подтверждение, что сборка допустима (без publish/push).
8. **Soak-критерии и владелец прогонов** (кто запускает сценарии S1–S5 и фиксирует результат).
9. **Merge/deploy в прод — отдельным решением**, вне этой стадии.

### 2.8. Остаточные риски

* `IU_IMAGE_VERSIONED` глобальная переменная процесса: staging и прод должны иметь **разные
  контейнеры** (в одном процессе раздельных книг с флагом и без — нет).
* Включение флага в staging требует **рестарта** (DDL таблиц `iu_image_*` выполняется только при ON).
* Вариант B не покрывает реальный Hub/worker transport и качество картинки.
* `listBuildPointerPaths` без `LIMIT` — на больших build возможен тяжёлый SELECT (это намеренно,
  чтобы не терять кадры).
* Общий `GPU_HUB_API_KEY`/Redis с продом **недопустимы** — их разделение обязательно.

---

## Резюме

* **Часть 1 — PASS:** чистый клон `6f277494`, `npm ci` из реестра (пустой кэш, 399 пакетов,
  без тарболлов/`npm cache add`), `player@0.1.3` + `orchestration@0.1.5` с совпадающим integrity;
  stage143a **100/0**, `test:arch` **935/24 pending/0**, полный suite **3599/28 pending/0**.
* **Staging сейчас отсутствует.** Предложена изолированная топология `animastor-staging`
  (свой compose-проект, своя PG-БД, свой Redis, свой OUTPUT_DIR, loopback-порты, без домена).
* **GPU Hub:** общего хаба для изоляции недостаточно (callback уходит в `BACKEND_URL` прода, общий
  Redis); нужен отдельный инстанс хаба со своим Redis и `BACKEND_URL`, плюс отдельный воркер —
  либо ручной debug-replay без GPU.
* **Флаг не включался.** Staging запускается только после отдельного разрешения владельца.
