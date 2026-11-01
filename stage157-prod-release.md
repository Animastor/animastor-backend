# Stage 157 — GPU Hub v0.2.6 в прод (P1 + хаб)

Дата: 2026-11-01. Оператор: агент. Push только в `origin`.
`down` / `prune` / пересоздание pg / redis не выполнялись. Proxy пересоздан
точечно: `up -d --no-deps --force-recreate nginx` (без пересоздания остальных
сервисов).

**Итог: ВЫПУЩЕНО. Откат не выполнялся.**

## 1. Параметры выпуска

| Параметр | Значение |
|---|---|
| Backend approve-коммит | `8b0d90d6935cb2e771fa17d7a2d4618c59f3990b` |
| Backend дерево образа | `e31b4e293aa376b5b0fd03170ddd59bd3e50b4dd` (orchestration 0.3.1, уже в проде со stage156) |
| Backend digest | `sha256:1c88a5620f3ae930c16de24fd0ed1e238df2bc9d49f0b8013c3991b7f6d84482` |
| Backend откат (образ) | `sha256:d9cff39061c976eb2bdcd67bda51f43cd6d9dc7bebead937893b5f263a9c327c` (installer 0.2.4) |
| **Hub коммит (main)** | `6f10d90` (merge `gpu-hub-v0.2.6`, cb60b3b) |
| **Hub тег / digest** | `v0.2.6` / `sha256:5c95bb0e0f719566882af3cfc49aa493d3a16c39fa65679e845fa1fe6dcfef57` |
| **Hub откат (образ)** | `sha256:2d26151c127a87570fc3c14a632275480165f70f508c7bb6816faa54934068fa` (v0.2.5, последний на проде) |
| **Worker мерж (main)** | `2c7211b012dde84381c856aebb8637fe13fab03d` (коммит `8bbff979ba9e92a96c51b5e93da35ddddd90ef5b`) |
| **Worker бандл** | `2.2.1` (был 2.2.0) |
| **Deploy коммит** | `b76aed5` (merge `deploy-hub-v0.2.6`, cc3d231) |
| Пакет в образе hub | `@animastor/gpu-hub` 0.1.0, worker-bundle 2.2.1 |

## 2. Что вошло

- `animastor-worker`: бандл 2.2.0 → 2.2.1 (только бэмп версии: `package.json`/`package-lock.json`, баннер `worker.cjs`, pin в `standalone.test.cjs`). Функционального нового содержимого нет — `worker_version` в `verify` (P8) уже в main. Тесты `run-all.cjs`: **52 pass / 0 fail**.
- `animastor-gpu-hub`: `artifacts.lock.json` repin `worker` → `8bbff97…` (2.2.1); `backend` и `installer-src` pin не тронуты (diff `e285141..e31b4e2` пуст). `scripts/stage-artifacts.cjs` verify OK. Тесты `npm test`: **35 passed / 0 failed**.
- `animastor-deploy`: `docker-compose.yml` — digest хаба v0.2.6 (`sha256:5c95bb0e…`); nginx смонтирован каталогом
  `/home/animastor/prod/nginx:/etc/nginx/conf.d:ro` (было файловое `default.conf`). Бэкапы nginx-конфигов не кладутся в `prod/nginx/` и не имеют суффикса `.conf`.

## 3. Тесты

- `animastor-worker`: `packages/animastor-worker$ node tests/run-all.cjs` → **52 pass / 0 fail**.
- `animastor-gpu-hub`: `npm test` → **35 passed / 0 failed**.
- `animastor-gpu-hub`: `node scripts/stage-artifacts.cjs --write-lock` + проверка без `--write-lock` → OK.

## 4. Деплой

- Бэкап compose до: `/home/animastor/backups/docker-compose-hub-v026-20261101163626.yml`.
- `animastor-deploy` `b76aed5`, `prod`: `git pull --ff-only`.
- `docker compose -p animastor --env-file .env up -d gpu-hub` → StartedAt
  `2026-11-01T16:36:35.280347507Z`, image `sha256:5c95bb0e…`.
- `docker compose -p animastor --env-file .env up -d --no-deps --force-recreate nginx` → StartedAt
  `2026-11-01T16:37:35.48052465Z`.
- pg / redis / backend — прежний аптайм, `restarts=0`.

## 5. Проверки (выполнены)

| Контроль | Результат |
|---|---|
| `docker inspect` gpu-hub image | `sha256:5c95bb0e…` ✅ |
| `docker inspect animastor-proxy` mount | `/home/animastor/prod/nginx → /etc/nginx/conf.d`, bind, `ro` ✅ |
| `StartedAt` proxy > коммит b76aed5 (16:36:15) | 16:37:35 ✅ |
| `/gpu/installer` | HTTP 200, тело содержит bundle `2.2.1` ✅ |
| `/gpu/health` | HTTP 200 ✅ |
| `/` (web) | HTTP 200 ✅ |
| `nginx -T \| grep -c client_body_buffer_size` | 2 ✅ |
| sha конфига в контейнере == host | `ae2e23b5307c5a3869cc1e91daacc3d56009bf0ed5cb068dc9f0899de6c3d8ce` ✅ |
| Логи proxy за 3 мин (error/fail/emerg/alert/crit) | 0 ✅ |
| Логи gpu-hub за 3 мин (error/fail/emerg/alert/crit) | 0 ✅ |

## 6. Прод-проверка (НЕ выполнялась)

Только по явной команде владельца, read-only скрипт в
`reports/2026-11-01/hub-v026-release.md`:
- `generation_tasks` за окно; `scene_assets` (`build_id`, статус);
- `workers.version` для обоих воркеров (ожидаем `2.2.1`);
- логи backend/hub: `terminally rejected`, `duplicate_same_fence`,
  `no_active_dispatch`, `[GPU] worker offline` vs `💀 GPU timeout`;
- Redis: `animastor:result:*` (пусто через 2 мин), `iu-progress` /
  `iu-progress-ids` (счётчик = числу IU), очереди/leases;
- сверка «команда ↔ задача» — только по явной команде.

## 7. Откат (не выполнялся)

```sh
# hub: вернуть v0.2.5
cd /home/animastor/prod && git pull --ff-only
# в docker-compose.yml gpu-hub image → sha256:2d26151c…
docker compose -p animastor --env-file .env up -d gpu-hub

# backend (если потребуется): sha256:d9cff390… (installer 0.2.4)
docker compose -p animastor --env-file .env up -d backend
```

Примечание: `d9cff390…` и `2d26151c…` — image digest (образы), а не git-коммиты;
git-объекты с такими хешами не существуют. Откат кода — revert-коммитом
через `work/` и merge.

## 8. Отчёт

`reports/2026-11-01/hub-v026-release.md` — подробный отчёт о выпуске и
скрипт read-only проверок.
