# Stage 155 — «Генерация только по команде» + `@animastor/orchestration` 0.3.0 в прод

Дата: 2026-10-31. Оператор: агент. Push только в `origin`. `down` / `prune` / пересоздание
pg / redis / proxy не выполнялись. Прод-БД: одна запись по заданию (шаг 11, ниже).

**Итог: ВЫПУЩЕНО. Откат не выполнялся.**

## 1. Параметры выпуска

| Параметр | Значение |
|---|---|
| Approve-коммит | `342bb3c122d29638b4d369133412b2b50d6cb0c3` |
| Дерево образа (`APPROVED_COMMIT`) | `981aec06dae52f588063b078ff58f91b414c23e2` (merge `fix/command-only-generation`) |
| Тег образа | `deploy-342bb3c` (CI `backend-ghcr-release`, запуск — владелец) |
| **Digest образа (index)** | `sha256:74745b380f89075b61b1d982fd4913388af2623649748a1df14be4ee892f42f5` |
| Манифест `linux/amd64` | `sha256:b0313435b626a4827afa9eee9d48da7cf9f6faf749252cc8279334ee5843898f` |
| Label `revision` / `version` | `342bb3c1…` / `deploy-342bb3c` |
| Предыдущий образ (Stage 154) | `sha256:f85470bb8ed7e1a2ef9e86afc84470a260ea3c593b42b0b482d2f885c4b3d27c` |
| Пакеты в образе (`--network none`) | orchestration `0.3.0` (`runtime.commandGate` есть), generation `0.1.1` |

## 2. Что вошло

Генерация только по явной команде (правило владельца; разбор инцидента BA
`reports/2026-10-31/auto-image-task-ba-incident.md`). Описание:
animastor-docs `architecture/COMMAND_ONLY_GENERATION.md`. Коммиты: `e03bc9a`, `e0074f1`,
`dadecbc` (lock → orchestration 0.3.0, `sha512-WrV+G8ih…`), merge `981aec0`, approve `342bb3c`.

Тесты (animastor-test, `scripts/test-backend.sh`, без внешней сети): main `4892781`
3631/28/0 → `dadecbc` 3649/28/0. Падения при живой сети — только тесты, ходящие во внешнюю
сеть (`/worker/counts` → AI API, `book-deletion` → `HUB_URL`); воспроизведены на main
(`reports/2026-10-31/command-only.md`).

## 3. Деплой

Бэкап до: `/home/animastor/backups/pre-command-only-20261031T102221Z/` —
`pg-animastor.dump` (`pg_dump -Fc`, 600, 43 TABLE DATA), `redis-dump.rdb` (BGSAVE, 600).

animastor-deploy `e79833a deploy: backend command-only generation (342bb3c, orchestration 0.3.0)`,
`prod`: `git pull --ff-only`.

```
cd /home/animastor/prod
docker compose -p animastor --env-file .env up -d backend     # 2026-10-31T10:22:59Z
```

Пересоздан только `animastor-backend`; pg / redis / proxy / gpu-hub — прежний аптайм.

## 4. Проверки

| Контроль | Результат |
|---|---|
| `docker inspect` image / revision | `sha256:74745b38…` / `342bb3c1…` ✅ |
| Миграции | `scene_assets_status_check` += `cancelled`; `generation_tasks_status_check` += `blocked`, `interrupted` (проверено по `pg_constraint`) ✅ |
| Старт | `[STARTUP] Command-only generation: 0 task(s) … interrupted … nothing resumed`; `session_interrupt:0`; `reconcile:0_issues` ✅ |
| Ошибки (`ReferenceError` / `TypeError` / `FATAL` / unhandled) | 0 ✅ |
| `/health` (изнутри контейнера) | `{"status":"ok","loop":true,"redis":"PONG"}` ✅ |
| 5 мин после шага 11 (10:24:35–10:29:35Z) | 5 циклов reconcile, 60 тиков; `ATTEMPT_DISPATCH` / `-> pending` / `+ ACTIVE` / GPU task — 0; active-scenes 0 ✅ |
| Рестарт backend (`compose restart backend`, 10:29:56Z) | ничего не возобновлено; dispatch 0; active-scenes 0; ключей реестра 0; `generation_tasks` без новых строк (completed 13 / cancelled 9) ✅ |

## 5. Шаг 11 — строки BA (запись в прод-БД по заданию)

- До: в проде всего 2 строки `scene_assets.status='pending'` — обе image-строки BA
  (`52452` `ch-5e5a8c76/sc-7cd391e4`, `52455` `ch-5e5a8c76/sc-d75dee8e`).
- Бэкап строк: `…/pre-command-only-20261031T102221Z/ba-image-pending-rows.csv` (600) + полный дамп.
- Транзакция: `UPDATE … SET status='cancelled', error='cancelled: command-only cleanup 2026-10-31 (incident BA, auto-image)'`;
  `WHERE book_id='ba_1788172242081' AND asset_type='image' AND status='pending' AND chapter_id='ch-5e5a8c76' AND scene_id IN (…) AND id IN (52452,52455)`;
  проверка «ровно 2» внутри транзакции → 2, COMMIT.
- После: `pending` в проде — 0; BA image — `cancelled` ×2. Redis: active-scenes 0, задач в реестре нет
  (в Redis этих строк не было).

**Не выполнено:** проверка «аудио одной placeholder-сцены BA → готово». Причины:
(1) онлайн-воркеров нет (`animastor:worker:heartbeat:*` пусто) — команда ушла бы в
`blocked`; (2) BA принадлежит пользовательскому аккаунту — по правилам сервера под
ним не входить. Нужно решение владельца.

## 6. Откат (не выполнялся)

```sh
# animastor-deploy: revert e79833a (вернёт sha256:f85470bb…, Stage 154), push origin
cd /home/animastor/prod && git pull --ff-only
docker compose -p animastor --env-file .env up -d backend
```

Совместимость: CHECK-ограничения расширены. Старый образ эти статусы не пишет, но
строки `cancelled` для него — неизвестный, а не pending-статус (не воскресит работу).
Вернуть строки BA: `UPDATE scene_assets SET status='pending', error=NULL WHERE id IN (52452,52455)`
(данные — в CSV-бэкапе).
