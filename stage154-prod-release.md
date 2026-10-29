# Stage 154 — GPU-очередь 143a (stages 114–147) + `@animastor/orchestration` 0.2.0 в прод

Дата: 2026-10-29. Оператор: агент. Push только в `origin`. `down`/`prune`/пересоздание
pg/redis/proxy не выполнялись; смоук — только на тестовом аккаунте, удалён после.

**Итог: ВЫПУЩЕНО. Откат не выполнялся.**

---

## 1. Параметры выпуска

| Параметр | Значение |
|---|---|
| Approve-коммит | `e2305d3fc9015a9b6791613d5a8656d8bd6bf933` |
| Дерево образа (`APPROVED_COMMIT`) | `a824eb41857eb10a27bd83a1833a53aab40b24c9` |
| Тег образа | `deploy-e2305d3` |
| **Digest образа (index)** | `sha256:f85470bb8ed7e1a2ef9e86afc84470a260ea3c593b42b0b482d2f885c4b3d27c` |
| Манифест `linux/amd64` | `sha256:6cc5deb007f9d9c03fc00024d6b2190d3d6dfb0e598b893552fdecea7d59201d` |
| Label `org.opencontainers.image.revision` | `e2305d3fc9015a9b6791613d5a8656d8bd6bf933` |
| Label `org.opencontainers.image.version` | `deploy-e2305d3` |
| Предыдущий образ (Stage 153) | `sha256:1fde561c58a4b2e8251d056fee91c438ee271200ffd967e51c406941e479ed5a` |

CI-run 22 (`workflow_dispatch`, conclusion success) собрал образ до этой задачи; run
не перезапускался. Пакеты в образе (`docker run --rm --network none`): orchestration
`0.2.0`, editor `0.2.0`, player `0.1.3`, assistant `0.1.1`.

## 2. Что вошло (`1fde561c…` → `f85470bb…`)

- **GPU-очередь 143a** — `feature/gpu-queue-143a`, stages 114–147 (32 коммита), влита в
  `main` fast-forward (`e654a58` → `a824eb4`): идемпотентная отправка задачи (idem-key,
  durable receipt), intent-fence в диспетчере резервирований, атомарная публикация
  результата (pointer как authority), versioned image-пути под `IU_IMAGE_VERSIONED`
  (флаг **выключен**), оркестрация `@animastor/orchestration` 0.2.0.
- `e654a58` fix(book-deletion): `animastor:cancelled-workers:{bookId}` получает TTL 1 ч
  (раньше оставался навсегда).
- `a824eb4` chore(backend): integrity `@animastor/orchestration@0.2.0` из registry
  (`sha512-G98OHbid…`).
- `e2305d3` ci(backend): approve `a824eb4` (`APPROVED_COMMIT`).

Тесты (animastor-test, `scripts/test-backend.sh`): 3625 passing / 28 pending /
6 failing — только ожидаемые Stage 76 synthetic-null.

## 3. Деплой

Бэкап до: `/home/animastor/backups/pre-stage154-20261029T132455Z/` —
`pg-animastor.dump` (`pg_dump -Fc`, 600, TOC 43 TABLE DATA), `redis-dump.rdb`
(BGSAVE, 600).

animastor-deploy `a04fd4f deploy: backend Stage 154 (e2305d3)`, push origin
(`deploy/stage154` → `main`, ветка удалена), `prod`: `git pull --ff-only`.

```
- image: ghcr.io/animastor/animastor-backend@sha256:1fde561c58a4b2e8251d056fee91c438ee271200ffd967e51c406941e479ed5a
+ image: ghcr.io/animastor/animastor-backend@sha256:f85470bb8ed7e1a2ef9e86afc84470a260ea3c593b42b0b482d2f885c4b3d27c
```

```
cd /home/animastor/prod
docker compose -p animastor --env-file .env up -d backend     # 2026-10-29T13:28:17Z
```

Пересоздан только `animastor-backend` (старт 13:28:20Z); pg/redis/proxy/gpu-hub —
прежний аптайм.

## 4. Проверки

| Контроль | Результат |
|---|---|
| `docker inspect` image / revision | `sha256:f85470bb…` / `e2305d3f…` ✅ |
| Лог старта: миграции | стандартные идемпотентные `[PG] …` (в т.ч. `ai_chat_sessions timestamps → epoch ms`), ошибок 0 ✅ |
| `ReferenceError` / `TypeError` / `FATAL` / unhandled rejection | 0 за 12 мин ✅ |
| DDL `iu_image_*` | **не выполнялся**: в логе нет ни строки `iu_image`; набор таблиц до/после идентичен (43), OID `iu_image_pointers` 251919 и `iu_image_fence_reservations` 251911 не менялись, строк 0/0. **Оговорка:** таблицы в PG уже были (есть в дампах от 2026-10-28 и pre-Stage-153), т.е. «таблиц нет» из задания не подтвердилось |
| `/health` | 200 `{"status":"ok","loop":true,"redis":"PONG"}` ✅ |
| Env контейнера | `GPU_FENCING_MODE` и `IU_IMAGE_VERSIONED` не заданы ✅ |
| Планировщик, 10 мин после старта | 129 тиков, все `Active: 0, Dispatched: 0`; `IMAGE_DISPATCHED` / `ATTEMPT_DISPATCH` / GPU Task sent / `DIRTY-UNIT-REGEN` — 0 ✅ |
| hub `/health` | `{"gpus":0,"queues":{"image":0,"audio":0,"video":0},"workspace_queues":{},"running":0}` ✅ |
| Redis | нет новых `intent`/`dispatch-intent`/`iu-in-flight`/`receipt`/`idempotency`/`dispatch-lease`/`queue:*`; `active-scenes` 0 ✅ |
| `scene_assets` | ready 439 / placeholder 9, stale и pending 0 ✅ |
| `generation_tasks` | completed 8 / cancelled 11, running и queued 0 ✅ |

Смоук (тестовый аккаунт `stage154_smoke_1793280649`, `/auth/register` → 201, удалён после):

| Шаг | Результат |
|---|---|
| POST /book/blank `{language:'en'}` | 200 `new_book_1793280666234`: title `New book`, language `en`, chapter `New chapter`, scene `Scene 1`, unit `iu-e7811177`; `books.workspace_id` = workspace аккаунта ✅ |
| POST /ai/sessions на тестовой книге | `created_at=1793280672698` (> 1e12); DELETE → 200, строк 0 ✅ |
| DELETE /book | 200; диск: каталог книги удалён; PG: books / scene_assets / image_units / generation_tasks / ai_chat_sessions / book_source / scenes — 0 ✅ |
| `animastor:cancelled-workers:{book}` после DELETE | **TTL 3595 с (≤ 3600)** — фикс `e654a58` работает; ключ истечёт сам ✅ |
| Остальной Redis по книге | 0 ключей ✅ |
| Аккаунт | logout → 200 (identity none); транзакция: sessions 1 / workspace_members 1 / workspaces 1 / users 1 удалены, остатков 0; ссылки в ai_connectors/ai_endpoints/workers/share_*/guests/generation_tasks — 0 ✅ |
| Базовая линия | users 2, sessions 2, books 2, workspaces 2 (как до смоука) ✅ |

## 5. Найдено (не блокирует)

- **8 invariant-несоответствий в reconcile каждые 60 с:** `[INVARIANT] … 1 audio-orch
  violations` (7 сцен) и `1 video-orch violations` (3 сцены), `Full reconciliation
  complete: 8 scenes scanned, 8 inconsistencies found`. Причина — очистка 2026-10-29
  удалила кэш `animastor:asset-state:*`, а `audio-orch`/`video-orch` в Redis остались в
  фазе `DONE`: проверка видит отсутствующий asset-state как не-READY. Действий нет:
  автофиксы не применялись, диспатчей 0, сцены не в `active-scenes`, worklist пропускает
  обе книги по тамбстонам. Лечится восстановлением `asset-state` из PG (отдельная задача).
- Таблицы `iu_image_pointers` / `iu_image_fence_reservations` существуют с ≤ 2026-10-28
  (пусты, `iu_image_fence_seq` израсходован до 88) — не этим деплоем.

## 6. Откат (не выполнялся)

```sh
# animastor-deploy: revert a04fd4f (вернёт sha256:1fde561c…, Stage 153), push origin
cd /home/animastor/prod && git pull --ff-only
docker compose -p animastor --env-file .env up -d backend
```

PG/Redis из бэкапа восстанавливать не нужно: набор таблиц не изменился, миграции
идемпотентны и ничего не переписали (схема Stage 153 совместима). Бэкап — на случай
ручного решения.
