# Stage 150 — инвентаризация накопленной очереди генерации (часть 1)

Дата: 2026-10-27. Только чтение: `redis-cli SCAN/TYPE/TTL/LLEN/LRANGE/HGETALL/SMEMBERS`,
`psql SELECT`, `GET /health`, чтение кода. **Записей в прод-Redis/PG/файлы/контейнеры нет,
ничего не удалялось, не перезапускалось, воркеры не запускались.** Секретов и полных
payload'ов ниже нет — только сводки (идентификаторы сцен/книг и метаданные задач).

Источники: прод-Redis `animastor-redis` (db0), прод-PG `animastor-pg`/`animastor`,
`gpu-hub` (HTTP `/health`), рабочее дерево репозитория.

---

## 1. Инвентаризация

### 1.1 Хаб (Redis)

Общее: db0 — **329 ключей, 30 с TTL**.

| Группа | Ключей | Тип | TTL | Содержимое (сводка) |
|---|---|---|---|---|
| `animastor:queue:image:ws:3317e019-879d-4dfb-a9f8-edc9b72da7f4` | 1 | list | нет (-1) | **478 задач**, все `job_type=image`, `stage=image`, workspace 3317e019. Книги: `import_1786345731767_1786345734345` — **476**, `ba_1788172242081` — **2**. Уникальных сцен — **4**, глав — 3 |
| `animastor:queue:image` (system lane) | 1 | list | нет | **8 задач** image, payload без `book_id`/`workspace_id` (только `job_id/build_id/job_type/assets/orphan_requeues`), книги: `import_1783751905430_1783751912316` — 4, `import_1783860199734_1783860208564` — 4. **Этих книг нет в таблице `books`** (сироты) |
| `animastor:processing` | 0 | — | — | в полёте ничего нет |
| `animastor:running` | 0 | — | — | пусто |
| `animastor:dead-letter` | 0 | — | — | пусто |
| `animastor:processing-claimed` | 1 | hash | нет | **33 поля** — старые claim-записи, все `:audio` (августовские), без TTL |
| `animastor:job:*` (дедуп) | **0** | — | — | пусто |
| `animastor:result:*` (резервные результаты) | **0** | — | — | пусто (TTL 1 h отработал) |
| `animastor:error:*` | 0 | — | — | пусто |
| `animastor:gpu-hub:workers` (реестр) | 0 | — | — | пусто; `GET /health` → `gpus:0`, `running:0` |
| `animastor:worker:heartbeat:*` | 0 | — | — | пусто |
| `animastor:worker-auth` | 1 | hash | нет | **6 записей** (hash токена → идентичность, зеркало из PG) |

**Итого задач в очередях хаба: 486** (478 ws + 8 system). `GET /health` совпадает:
`{"gpus":0,"queues":{"image":8,"audio":0,"video":0},"workspace_queues":{"…ws:3317e019…":478},"running":0}`.

**Хронология ws-очереди** (по `dispatch_id`, мс-метка):

| Дата (UTC) | Задач |
|---|---|
| 2026-08-30 | 27 |
| 2026-08-31 | 72 |
| 2026-09-01 | 72 |
| 2026-09-02 | 27 |
| 2026-09-03 | 9 |
| 2026-09-04 | 36 |
| 2026-10-10 … 2026-10-21 | 188 (9+27+27+18+19+57+38+19) |
| **2026-10-27 (сегодня)** | **21** (07:24:41Z — import, 2 сцены ×9+9; 09:34:27Z — ba, 2 сцены ×2) |

- Самая старая: `dispatch-1788068726125-…` — **2026-08-30 05:45 UTC**, `import_1786345731767…/ch-1bb5123c/sc-45c789c6`.
- Самая новая: `dispatch-1793093667481-…` — **2026-10-27 09:34 UTC**, `ba_1788172242081/ch-66e6f9a6/sc-1c3d246a` (тест Stage 149).
- Ориентация: хаб кладёт через `LPUSH` (свежая в голове), воркер забирает `RPOPLPUSH` с хвоста → FIFO, первая на выдачу — самая старая (2026-08-30).

Дубликаты: часть dispatch_id повторяется в списке до 9 раз (повторные отправки одной сцены при живом воркере).

### 1.2 Backend (тот же Redis) — что заставит backend отправить самому

| Группа | Количество | TTL | Комментарий |
|---|---|---|---|
| `animastor:active-scenes` | **set, 4 сцены** | нет | `import…:ch-1bb5123c:sc-45c789c6`, `import…:ch-1bb5123c:sc-5f18dd0f`, `ba…:ch-10331e4d:sc-79201cbd`, `ba…:ch-66e6f9a6:sc-1c3d246a` — именно по ним идёт тик планировщика |
| `animastor:asset-state:*` | 17 хэшей, **ready 22 / dirty 24 / generating 4** | нет | `generating` (image): `import:sc-45c789c6`, `import:sc-5f18dd0f`, `ba:sc-79201cbd`, `ba:sc-1c3d246a`. «Зависшие в generating» — эти 4 |
| `animastor:dispatch-lease:*` | 4 | ~1352–1373 c (≈23 мин) | lease живой, обновляется |
| `animastor:dispatch-meta:*` | 4 | ~23 мин | `status:"dispatched"`, `worker:"scheduler"`, `started_at` 07:24:41Z / 09:34:27Z сегодня |
| `animastor:runtime:active-image` | string = `4` | нет | счётчик активных image-диспатчей |
| `animastor:runtime:scheduler:history` | list | нет | история тиков |
| `animastor:iu-registry:*` | 21 | ~20.9–22.5 ч | IU-реестр сцен |
| `animastor:cancelled-workers:*` | 44 set | нет | мусорные/удалённые книги; **ни одной из двух актуальных книг там нет** |
| `animastor:generation-progress:*` | 1 | ~2.5 ч | прогресс книги |
| `animastor:event-journal:*` / `audio-orch` / `video-orch` / `retry-budget` / `circuit` / `layer-config` / `book-scenes` / `assets` / `chunk(s)` / `iu:*` | 8/5/3/6/2/2/12/… | нет | книжные кэши и bookkeeping |
| `animastor:dispatch-intent:*`, `animastor:intent:*`, `animastor:iu-in-flight*`, `animastor:force-dispatch:*`, `animastor:generation:cancel*`, `animastor:idempotency:*` | **0** | — | сканом подтверждено пусто — fence/receipt/in-flight-маркетов, которые могли бы поймать повтор, нет |

### 1.3 Backend (PG)

| Таблица / условие | Счётки |
|---|---|
| `generation_tasks` всего | 19 |
| `status='running'` | **2** — `ba_1788172242081`, `image`, `created_at=2026-10-27 09:34:23` |
| `status='queued'` | **0** |
| `cancelled` / `completed` | 9 / 8 |
| `scenes` всего | 13 (2 книги) |
| `scenes` c непустым `dirty_unit_ids` | **1** — `ba_1788172242081/ch-66e6f9a6/sc-1c3d246a` → `{iu-bafebc8c}` |
| `scenes.is_dirty = true` | **8** (все сцены `ba_1788172242081`); у `import_1786345731767…` — 0 |
| `scene_assets.status='stale'` | **430** — `import…` image **409**, `ba…` audio 17, `import…` audio 4 |
| `scene_assets.status='pending'` | **4** — image (2 `ba` + 2 `import`) |
| `scene_assets.status='ready'` / `placeholder` | 18 / 9 |
| `scene_assets.status='generating'` | 0 (в PG такого статуса нет — generating живёт в Redis) |
| `asset_states` | **0 строк** |
| `generation_cancellations` (тамбстоны отмены) | 1 — `orphan_book` (`created_by=cancel-generation`); **ни одна из двух актуальных книг не отменена** |
| `workers` | 7 строк, все `offline`, последний `last_seen` = 2026-08-31 |
| `sessions` | 4 |

---

## 2. Код: что произойдёт при запуске воркеров и без него

### 2.1 Что воркер заберёт из хаба первым

- `backend/node_modules/@animastor/gpu-hub/gpu-hub.js:869` — `GET /task/next`.
- `:925–955` — для приватного воркера lane = **`animastor:queue:{type}:ws:{workspace_id}`** (строгий приоритет), и только при пустой ws-очереди — policy/system lane; `:934/:950` — `rpoplpush(queueKey, "animastor:processing")`.
- Попасть в очередь: `:647/:821` — `LPUSH` при `POST /task` ⇒ **хвост списка = самая старая задача**.
- Итог: первый запущенный image-воркер (приватный, ws `3317e019`) получит задачу **2026-08-30 05:45** (`import_1786345731767…/sc-45c789c6`) и дальше пойдёт по FIFO вверх по 478; share/system-воркер первым возьмёт 8 сирот из `animastor:queue:image`.

### 2.2 Механизмы backend, создающие задачи без действий пользователя

1. **Тик планировщика (каждые 5 с).**
   `backend/src/runtime/runtime-loop.js:304` `start(redis, intervalMs = SCHEDULER_TICK_MS)`;
   `packages/animastor-orchestration/src/runtime/runtime-scheduler.js:89` — `SCHEDULER_TICK_MS = 5000`;
   тик идёт по всем ключам `animastor:active-scenes` и на каждой сцене зовёт `attemptDispatch`
   (`runtime-scheduler.js:458` → `:547`) → `dispatch-engine` → `POST /task` в хаб.
   **Сейчас в active-scenes 4 сцены → отправка продолжается уже сейчас** (доказательство —
   диспатчи 07:24Z и 09:34Z сегодня, `dispatch-meta` со `status:"dispatched"`).
2. **Старт backend: `reconcileCycle({startup:true})`.**
   `backend/src/backend.cjs:909–940` — `setImmediate` → `reconciliation` `reconcileCycle(..., {startup:true})`;
   `backend.cjs:943–985` — сброс `runtime:active-*` и удаление всех `animastor:dispatch-lease:*`.
3. **Phase C8 `rebuildWorkList` — только на старте.**
   `packages/animastor-orchestration/src/runtime/reconciliation-engine.js:1817–1831`
   (`if (startup && !scope)`), реализация `:2313`, блок `:2379–2449`:
   читает PG (`scene_assets.status IN ('stale','failed','pending')` и `scenes.dirty_unit_ids`),
   ставит ассетам `PENDING` и делает `addSceneToActiveIndex` (`:2500`) → через 5 с тик задиспатчит.
   **Это главный риск: 430 stale + 4 pending + 1 dirty_unit_ids = новый вал отправок после любого рестарта backend.**
   Политика в комментарии (`:1811–1816`): периодический цикл работу не возрождает — только startup.
4. **Phase D `reconcileAll` + auto-fix (каждые 60 с).**
   `reconciliation-engine.js:1635` (`reconcileCycle`), интервал `RECONCILE_INTERVAL_MS = 60000`
   (`runtime-loop.js:19`); `:1836–1846` — `getFixRecommendations(...).filter(safeToExecute)` → `applyFix`,
   включая `REGENERATE_MISSING_ASSET` (`:1047+` по аудиту) и `orphan_generating_repair` (`:508`, `:1273`).
   Фазы A/B1/B2 (result-recovery, stalled audio/video) — тоже каждые 60 с.
5. **Восстановление по stale lease.** `dispatch-engine.js:970–977` — `shouldSkipDispatch` →
   `cancelActiveDispatch(..., 'stale_lease_recovery')` → повторный dispatch той же сцены.
6. **Force-regen по `dirty_unit_ids`.** `scene-orchestrator.js:363` и `:511` — `sceneAssets.getDirtyUnitIds`,
   в логе это `[DIRTY-UNIT-REGEN] Force-regenerating …` (был в Stage 149).
7. **Штатная отмена (единственный официальный стоп).**
   `backend/src/routes/book/generation-routes.cjs:251` — `POST /api/v1/book/:bookId/cancel-generation`:
   cancel-флаг в Redis (`setCancelFlag`), PG-тамбstone (`generation_cancellations`,
   «recovery не возродит»), `clearBookFromActiveIndex`, сброс `runtime:active-*`,
   `clearAllLeasesForBook`, `repairOrphanGeneratingStates` (GENERATING → DIRTY → PENDING),
   отмена строк `generation_tasks`, **`DELETE {HUB_URL}/queue/clear?book_id=`** (`gpu-hub.js:1818`)
   + повторный sweep после освобождения idempotency-claim'ов.
   Формат hub-запроса: `record.book_id === book_id` → system-lane записи (без `book_id`) штатным
   путём **не вычищаются**.

---

## 3. Тестовая правка Stage 149: где текст и как вернуть

**Где хранится:** текст юнита — колонка `text` таблицы **`image_units`**
(строка `id=187888`, `book_id=ba_1788172242081`, `chapter_id=ch-66e6f9a6`,
`scene_id=sc-1c3d246a`, `unit_id=iu-bafebc8c`, `build_id=build_ba_1788172242081`),
плюс та же строка в книге (файл сцены) — она и была изменена PATCH'ем.

**Состояние сейчас:** `length(text)=184`, суффикс ` (проверка Stage 149)` (первый символ `п` — 166-й).
Проверено в PG: `text = left(text,163) || ' (проверка Stage 149)'` → **true**, т.е. исходный текст —
`left(text,163)`, 163 символа.

**Как вернуть (штатно, без правки БД):**

```sh
# 1) та же авторизация, что в Stage 149 (логин sureg, workspace 3317e019)
curl -c /tmp/s.txt -H 'Content-Type: application/json' \
  -d '{"username":"sureg","password":"<пароль владельца>"}' \
  https://<host>/api/v1/auth/login
# 2) возврат исходного текста тем же PATCH
curl -b /tmp/s.txt -X PATCH -H 'Content-Type: application/json' \
  -d '{"unit_id":"iu-bafebc8c","fields":{"text":"<текст из left(text,163)>"}}' \
  https://<host>/api/v1/book/ba_1788172242081/scene/ch-66e6f9a6/sc-1c3d246a
# ожидаемо: HTTP 200 {"saved":true,…,"dirty_scenes":1}
```

Эндпоинт: `packages/animastor-editor/src/editor-routes.cjs:299` (ветка `fields` + `unit_id`,
`:344–358`), он же делает `reconcileFromDiff` + `bumpSceneVersions` + `setDirtyUnitIds`
(`:421–433`). **Последствие:** PATCH снова выставит маркеры дёрти сцены — они и так присутствуют
(`dirty_unit_ids={iu-bafebc8c}`), новых задач это не добавит, но убирать маркеры нужно в части 2
(см. §4.3), иначе рестарт backend снова задиспатчит сцену.

---

## 4. План очистки (часть 2 — описание; выполняется только после разрешения владельца)

Целевое состояние после части 2: в хабе 0 задач, backend ничего не отправляет сам,
сцены не зависли в `generating`, генерацию можно запустить вручную позже.

### 4.0 Порядок и резервные копии (до любых удалений)

1. **Redis-бэкап (ключи, которые будем трогать):**
   ```sh
   mkdir -p /tmp/stage152-backup
   # выгрузка значений с проверкой целостности — DUMP + base64 (тихо, только чтение)
   docker exec animastor-redis sh -c "redis-cli --scan --pattern 'animastor:*'" > /tmp/stage152-backup/keys.txt
   while read -r k; do
     docker exec animastor-redis redis-cli dump "$k" | base64 -w0 > /tmp/stage152-backup/dump.b64.tmp
     printf '%s\t%s\n' "$k" "$(md5sum < /tmp/stage152-backup/dump.b64.tmp | cut -d' ' -f1)"
   done < /tmp/stage152-backup/keys.txt > /tmp/stage152-backup/dumps.md5
   # отдельно — содержимое списков (для точного восстановления порядка)
   docker exec animastor-redis redis-cli lrange animastor:queue:image 0 -1 > /tmp/stage152-backup/system-queue.jsonl
   docker exec animastor-redis redis-cli lrange animastor:queue:image:ws:3317e019-879d-4dfb-a9f8-edc9b72da7f4 0 -1 \
     > /tmp/stage152-backup/ws-queue.jsonl
   docker exec animastor-redis redis-cli hgetall animastor:processing-claimed > /tmp/stage152-backup/processing-claimed.txt
   docker exec animastor-redis redis-cli smembers animastor:active-scenes > /tmp/stage152-backup/active-scenes.txt
   ```
   (Дополнительно можно снять общий снимок: `docker exec animastor-redis redis-cli bgsave` +
   копия `/data/dump.rdb` — но вышеперечисленного достаточно для отката конкретных ключей.)
2. **PG-бэкап нужных таблиц:**
   ```sh
   docker exec animastor-pg pg_dump -U animastor -d animastor \
     -t generation_tasks -t scenes -t scene_assets -t generation_cancellations -t image_units \
     > /tmp/stage152-backup/pg-stage152.sql
   ```
3. Снимок «до» для контроля: `GET /health`, `dbsize`, LLEN/SCARD, `SELECT status,count(*) …`.

### 4.1 Очереди хаба (486) — предпочесть штатный путь

| Что | Как | Штатно/напрямую |
|---|---|---|
| ws-очередь 476+2 (`import_1786345731767…`, `ba_1788172242081`) | `POST /api/v1/book/<bookId>/cancel-generation` под логином `sureg` для **каждой** книги (внутри — `DELETE /queue/clear?book_id=…` в хабе + повторный sweep) | **штатно** |
| system lane — 8 сирот (`import_1783751905430…`, `import_1783860199734…`; книг в `books` нет, в payload нет `book_id` → штатный clear их не матчит) | `docker exec animastor-redis redis-cli del animastor:queue:image` (предварительно выгружен `system-queue.jsonl`) | напрямую |
| `animastor:processing-claimed` (33 claim'а, audio) | `del animastor:processing-claimed` | напрямую (только bookkeeping хаба) |

Порядок: бэкап → cancel-generation (обе книги) → проверка `LLEN ws = 0` → `DEL` system lane →
повторная проверка. **Откат:** `rpush animastor:queue:image $(cat system-queue.jsonl)` (и аналогично
ws-очередь из `ws-queue.jsonl`, порядок сохранён выгрузкой), `hset` processing-claimed из выгрузки.

### 4.2 Backend-ключи Redis

| Что | Как | Штатно/напрямую |
|---|---|---|
| `active-scenes` (4), `dispatch-lease/meta` (4+4), `runtime:active-image`, `generation-progress` | то же `cancel-generation` (чистит индекс, lease, счётчики, прогресс) | **штатно** |
| `asset-state:*` — 4 `generating` | `cancel-generation` → `repairOrphanGeneratingStates` переводит GENERATING → DIRTY → PENDING (сцена перестаёт быть «зависшей») | **штатно** |
| `asset-state:*` полностью (17 хэшей) + `cancelled-workers` (44) + `iu-registry` (21) + `retry-budget`/`circuit`/`event-journal`-хвосты | `del` по списку из выгрузки — чтобы recovery не подхватил дёрти | напрямую (опционально; не мешает при наличии тамбстонов отмены) |
| `generation:cancel*` флаг | ставится cancel-generation автоматически | штатно |

### 4.3 PG

| Что | Как | Штатно/напрямую |
|---|---|---|
| `generation_tasks` `running` (2) | `cancel-generation` → `cancelActiveTasksForBook` | **штатно** |
| тамбстоны `generation_cancellations` для двух книг | создаются cancel-generation — **оставить** (это и есть «backend не отправит сам») | штатно (создание) |
| `scenes.is_dirty` (8) и `dirty_unit_ids` (1) | штатного сброса нет (PATCH/regenerate только выставляют): `UPDATE scenes SET is_dirty=false, dirty_unit_ids='{}' WHERE book_id IN ('ba_1788172242081','import_1786345731767_1786345734345');` | **напрямую** |
| `scene_assets` `stale` (430) + `pending` (4) — главный источник re-dispatch при рестарте | штатного API нет. Вариант А (безопасный): выставить `ready` только там, где файл ассета валиден на диске (сверка с `OUTPUT_DIR`), остальным сиротам — `DELETE`; вариант Б: `UPDATE scene_assets SET status='ready' … WHERE status IN ('stale','pending')` — проще, но «ready без файла» C0 снова пометит как DIRTY. Рекомендую А | **напрямую** |
| `asset_states` | пусто — ничего делать не нужно | — |

**Критично:** порядок «сначала штатная отмена, потом PG-маркеры». Если оставить
`stale`/`dirty_unit_ids` и перезапустить backend — Phase C8 `reconcileCycle({startup:true})`
снова развернёт сцены в `PENDING` и задиспатчит (§2.2 п.3).

### 4.4 Проверка после очистки

```sh
curl -s http://gpu-hub:5000/health
# ожидаем: "queues":{"image":0,...},"workspace_queues":{},"running":0,"gpus":0
docker exec animastor-redis redis-cli llen animastor:queue:image                 # 0
docker exec animastor-redis redis-cli llen animastor:queue:image:ws:3317e019-…   # 0
docker exec animastor-redis redis-cli scard animastor:active-scenes              # 0
docker exec animastor-redis redis-cli --scan --pattern 'animastor:dispatch-lease:*' | wc -l  # 0
docker exec animastor-pg psql -U animastor -d animastor -c \
  "select status,count(*) from generation_tasks group by status"                 # без running/queued
docker exec animastor-pg psql -U animastor -d animastor -c \
  "select count(*) from scenes where is_dirty or cardinality(dirty_unit_ids)>0"  # 0
docker exec animastor-pg psql -U animastor -d animastor -c \
  "select status,count(*) from scene_assets group by status"                     # без stale/pending
# 10 минут логов backend: нет IMAGE_DISPATCHED / GPU Task sent / ATTEMPT_DISPATCH / [DIRTY-UNIT-REGEN]
```

### 4.5 Откат

- Redis: `rpush` выгруженных entries обратно (порядок из `*.jsonl`), `hset`/`sadd` из выгрузок;
  сверка по `dumps.md5`/`dump` (RESTORE в ту же базу, если нужна побайтовая точность).
- PG: `psql -f /tmp/stage152-backup/pg-stage152.sql` (выбранные таблицы) либо точечные
  `UPDATE` обратно по известным значениям (`is_dirty`, `dirty_unit_ids`, `status`).
- Штатная отмена откатывается `DELETE FROM generation_cancellations WHERE book_id IN (…)` —
  но это вернёт и право recovery возрождать генерацию.

### 4.6 Штатно vs напрямую (кратко)

- **Штатно:** отмена генерации книги (`cancel-generation`) — вычищает ws-очередь хаба, active-scenes,
  lease, счётчики, running-задачи, ставит тамбstone. Этим закрываются все 478 ws-задач и 4 зависшие
  `generating`.
- **Только напрямую:** system lane из 8 сирот (нет `book_id` в payload), `processing-claimed`,
  `scenes.is_dirty`/`dirty_unit_ids`, `scene_assets.stale/pending`, мусорные `cancelled-workers`/`iu-registry`.

---

## 5. Проверки, которые НЕ выполнялись (границы части 1)

Записи в Redis/PG, удаления, `RESTORE`, `UPDATE/DELETE`, рестарты, запуск воркеров,
`cancel-generation` (создаёт тамбstone и чистит данные) — **не выполнялись**. Все цифры выше
получены чтением 2026-10-27 (окно 11:04–11:35 UTC).

---

# Часть 2 — очистка очереди (выполнено 2026-10-27, под логином sureg)

Выполнено по плану §4 инвентаризации (разрешение владельца получено). Ниже — фактические
результаты каждого шага. Секреты и содержимое бэкапов не публикуются.

## 5.0 Бэкап (перед любыми удалениями)

Директория: `/home/animastor/backups/stage150/` (права на все файлы `600`, не в git).

| Файл | Размер | Содержимое |
|---|---|---|
| `pg-tables.dump` | 147 208 B | `pg_dump` таблиц `scenes`, `scene_assets`, `generation_tasks`, `image_units` |
| `queue-image.lrange` | 25 256 B | `LRANGE animastor:queue:image 0 -1` (8 сирот) |
| `queue-image-ws.lrange` | 1 559 878 B | `LRANGE animastor:queue:image:ws:…` (478 задач ws-очереди) |
| `processing-claimed.hgetall` | 3 215 B | `HGETALL animastor:processing-claimed` (33 audio-claim'а) |
| `active-scenes.smembers` | 200 B | `SMEMBERS animastor:active-scenes` (4 сцены) |
| `dispatch-lease_*.json` | 4 × 56 B | 4 ключа `animastor:dispatch-lease:*:image` |
| `dispatch-meta_*.json` | 2 × 355 B + 2 × 373 B | 4 ключа `animastor:dispatch-meta:*:image` |
| `asset-state_*.json` | 17 × 67 B | 17 ключей `animastor:asset-state:*` |

## 5.1 PATCH возврата текста юнита iu-bafebc8c

Штатный `PATCH /api/v1/book/ba_1788172242081/scene/ch-66e6f9a6/sc-1c3d246a` от имени `sureg`:
```json
{"unit_id":"iu-bafebc8c","fields":{"text":"<left(text,163)>"}}
```
**Ответ:** HTTP 200 `{"saved":true,"book_id":"ba_1788172242081","chapter_id":"ch-66e6f9a6","scene_id":"sc-1c3d246a","unit_id":"iu-bafebc8c","dirty_scenes":1}`.

Правка поставила сцену в очередь (`dirty_unit_ids={iu-bafebc8c}` в `scenes`, `is_dirty=true`) — следующим шагом она снята отменой генерации.

**Проверка `image_units.text`:** после PATCH колонка `text` в `image_units` **всё ещё содержит** суффикс ` (проверка Stage 149)` (`length(text)=184`). `image_units.text` обновляется только воркерем при обработке IU (`upsertImageUnit`), которая отменена следующим шагом — возврата текста в PG не произошло штатным PATCH'омalone. Исходный текст остаётся в книге (файл сцены) и применяется воркерем при повторном диспатче.

**Текст юнита возвращён да/нет: нет** (в `image_units.text` суффикс остался; источник правды — book JSON, обновлён PATCH'ом).

## 5.2 Отмена генерации (штатно)

`POST /api/v1/book/<id>/cancel-generation` под логином `sureg` для всех книг со сценами в `active-scenes`:

| Книга | HTTP | Тело ответа |
|---|---|---|
| `ba_1788172242081` | 200 | `{"ok":true,"book_id":"ba_1788172242081"}` |
| `import_1786345731767_1786345734345` | 200 | `{"ok":true,"book_id":"import_1786345731767_1786345734345"}` |

(Первоначальный вызов с укороченным ID `import_1786345731767` вернул 403 — полный `book_id` в таблице `books` содержит суффикс `_1786345734345`.)

Отменяние очистило: `active-scenes` (4 сцены → 0), `dispatch-lease/meta` для книг, `generation_tasks` (running → cancelled), поставило тамбстоны `generation_cancellations`, вызвало `DELETE /queue/clear?book_id=` в хабе (ws-очередь очищена).

## 5.3 Прямые удаления (только перечисленные)

| Ключ | Было | Действие | Стало |
|---|---|---|---|
| `animastor:queue:image` (system lane) | 8 задач image | `DEL` | 0 |
| `animastor:processing-claimed` | 33 поля audio | `DEL` | 0 |

Никакие другие ключи не удалялись. ws-очередь `animastor:queue:image:ws:…` (478 задач) очищена штатно через `cancel-generation` → `DELETE /queue/clear`.

## 5.4 Проверка без рестарта (шаг 5)

| Контроль | Ожидание | Факт |
|---|---|---|
| `GET /health` бэкенда | `status: ok` | `{"status":"ok","loop":true,"redis":"PONG"}` |
| `GET /health` хаба (gpu-hub) | все очереди 0 | `{"gpus":0,"queues":{"image":0,"audio":0,"video":0},"workspace_queues":{},"running":0}` |
| `LLEN` всех `animastor:queue:*` | 0 | ключей `queue:*` нет (все 0) |
| `animastor:active-scenes` | пусто | `SCARD = 0` |
| `generation_tasks` без `running`/`queued` | 0 | `running=0, queued=0` (остались `cancelled=11, completed=8`) |
| 10 мин логов без `IMAGE_DISPATCHED` / `ATTEMPT_DISPATCH` | 0 вхождений | 0 вхождений за окно наблюдения |

**Итог шага 5: всё на нуле, backend ничего не отправляет.**

## 5.5 Контролируемый рестарт `animastor-backend` и наблюдение 20 мин

Рестарт: `docker restart animastor-backend` (образ не менялся, другие контейнеры не трогались, `deploy/.env` не менялся).

**Startup-reconcile (видно в логах):**
- `[RECOVERY] [STARTUP-RESUME] No incomplete generation sessions found`
- `[RECONCILE] [WORKLIST] ba_1788172242081: skipped (cancellation tombstone)`
- `[RECONCILE] [WORKLIST] import_1786345731767_1786345734345: skipped (cancellation tombstone)`
- `[RECONCILE] Full reconciliation complete: 8 scenes scanned, 0 inconsistencies found`

**Наблюдение (несколько циклов по 60 с, scheduler тик каждые 5 с):**
| Контроль | Ожидание | Факт |
|---|---|---|
| `animastor:queue:*` | 0 | пусто (все ключи отсутствуют) |
| `animastor:active-scenes` | 0 | `SCARD = 0` |
| `animastor:dispatch-lease:*` | 0 | 0 ключей |
| `generation_tasks` running/queued | 0 | 0 |
| `IMAGE_DISPATCHED` / `ATTEMPT_DISPATCH` после рестарта | 0 | 0 вхождений |
| Scheduler тики | `Dispatched: 0` | все тики `Active: 0, Dispatched: 0` |

Задачи **не reappeared** — механизм паузы (тамбстоны `generation_cancellations`) сработал: `rebuildWorkList` на старте пропустил обе отменённые книги.

**Итог рестарта: ноль задач, ничего не пришло.**

## 5.6 Разбивка 430 stale по книгам (сироты)

`scene_assets.status='stale'` — 430 строк, `status='pending'` — 4 строки:

| Книга | stale | pending | Есть в таблице `books` | Сироты |
|---|---|---|---|---|
| `ba_1788172242081` | 17 (audio) | 2 (image) | да | 0 |
| `import_1786345731767_1786345734345` | 413 (image 409 + audio 4) | 2 (image) | да | 0 |

**Из 430 stale — 0 в книгах, отсутствующих в таблице `books`**. Обе книги с stale-ассетами зарегистрированы в `books`. (Сиротские книги — `import_1783751905430…`, `import_1783860199734…` и др. из `processing-claimed`/`queue:image` — не имеют строк в `scene_assets` со статусом stale.)

## 5.7 Итоговое состояние после очистки

| Компонент | Состояние |
|---|---|
| Хаб (Redis) очереди | все `queue:*` = 0, `active-scenes` = 0, `dispatch-lease/meta` = 0, `processing-claimed` = 0 |
| gpu-hub `/health` | `queues: {image:0, audio:0, video:0}`, `running: 0`, `workspace_queues: {}` |
| Backend | `/health: ok`, scheduler тики с `Dispatched: 0`, нет `IMAGE_DISPATCHED`/`ATTEMPT_DISPATCH` |
| PG `generation_tasks` | нет `running`/`queued` (только `cancelled`/`completed`) |
| PG `scenes` | `is_dirty`/`dirty_unit_ids` остались (не сбрасывались штатным API — требуется отдельная очистка PG при необходимости полного сброса) |
| PG `scene_assets` | 430 stale + 4 pending остались (не трогались в части 2) |

**Всё на нуле: да** — по всем очередям хаба, `active-scenes`, `dispatch-lease`, `generation_tasks` (running/queued). Backend после рестарта и 20-минутного наблюдения не generar новых задач.

**Минимальный способ предотвратить повторное появление:** существующий механизм паузы / тамбстона `generation_cancellations` (уже выставлен `cancel-generation` для обеих книг) — он заставил `rebuildWorkList` пропустить книги на старте backend. Прямая правка PG (`scenes.is_dirty`, `dirty_unit_ids`, `scene_assets.status`) требуется только для полного сброса маркеров, но не для остановки диспатчей — тамбстоны уже это гарантируют.
