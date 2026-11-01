# Stage 156 — `@animastor/orchestration` 0.3.1 в прод

Дата: 2026-11-01. Оператор: агент. Push только в `origin`.
`down` / `prune` / пересоздание pg / redis / proxy не выполнялись.

**Итог: ВЫПУЩЕНО. Откат не выполнялся.**

## 1. Параметры выпуска

| Параметр | Значение |
|---|---|
| Approve-коммит | `8b0d90d6935cb2e771fa17d7a2d4618c59f3990b` |
| Дерево образа (`APPROVED_COMMIT`) | `e31b4e293aa376b5b0fd03170ddd59bd3e50b4dd` (merge bump 0.3.1) |
| Тег образа | `deploy-e31b4e2` (владелец ввёл commit `e31b4e2`; тег `8b0d90d…` тоже опубликован) |
| **Digest образа (index)** | `sha256:1c88a5620f3ae930c16de24fd0ed1e238df2bc9d49f0b8013c3991b7f6d84482` |
| Label `revision` / `version` | `8b0d90d6935cb2e771fa17d7a2d4618c59f3990b` / `deploy-e31b4e2` |
| Предыдущий образ | `sha256:d9cff39061c976eb2bdcd67bda51f43cd6d9dc7bebead937893b5f263a9c327c` (installer 0.2.4) |
| Пакет в образе | orchestration `0.3.1`, generation `0.1.1` |

## 2. Что вошло

`backend/package.json`: `@animastor/orchestration` `^0.3.0` → `^0.3.1`;
`backend/package-lock.json` — 0.3.1, integrity
`sha512-H0TKmIWTAsi1AVsH2Vf+IsyWswADy7mP5juyGA8h2bJ4LdBG/+m7EiUNA80YYozpXHa4NUAwIr2ANFFrX/8Awg==`.
Коммит `e31b4e2`, approve `8b0d90d`.

## 3. Тесты

`ANIMASTOR_DOCS_ROOT=/home/animastor/src/animastor-docs ./scripts/test-backend.sh`
на `e31b4e2`: **3657 passing, 28 pending, 0 failing**, exit 0.
База `933e19c` — 3656/29/0; pending-тест «npm copy matches» стал passing.

## 4. Деплой

- Бэкап compose до: `/home/animastor/backups/docker-compose-pre-backend-orch031-20261101T161511Z.yml`
  (600, sha256 `0fe04ca560bcc7e5772db13ca989842b88de5b53c7303757f5e9e7747514d534`).
- `animastor-deploy` `163cfdb release: backend orchestration 0.3.1 (sha256:1c88a562, approve 8b0d90d)`,
  `prod`: `git pull --ff-only`.
- Пересоздан только `animastor-backend`:
  `docker compose -p animastor --env-file .env up -d backend` → старт `2026-11-01T16:15:54.455960445Z`.
  pg / redis / proxy / gpu-hub — прежний аптайм, `restarts=0`.

## 5. Проверки

| Контроль | Результат |
|---|---|
| `docker inspect` image | `sha256:1c88a562…` ✅ |
| Версия в контейнере | `/app/node_modules/@animastor/orchestration/package.json` = `0.3.1` ✅ |
| Старт | `[STARTUP] Backend server running on port 3000`; `Command-only generation: 0 task(s) … nothing resumed` ✅ |
| `ReferenceError` / `TypeError` / `FATAL` / unhandled | 0 ✅ |
| `error`-уровень за 3 мин 29 с | 0 ✅ |
| `terminally rejected` (warn) | 0 ✅ |
| Runtime loop | 41 тик; scheduler 0 dispatched, 0 throttled; drift 0 ✅ |
| `/health` | `{"status":"ok","loop":true,"redis":"PONG"}` ✅ |
| Очереди / running / processing / result-ключи | 0 / 0 / 0 / 0 ✅ |
| Незавершённых `generation_tasks` | 0 ✅ |

## 6. Прод-проверка (НЕ выполнялась)

Одна сцена audio и одна image с 2 IU на тестовой книге — только по явной команде владельца.
Критерии: нет `terminally rejected` как warn; `iu-progress` = числу IU;
`animastor:result:*` пуст через 2 минуты; очереди 0.

## 7. Откат (не выполнялся)

```sh
# animastor-deploy: revert 163cfdb → вернёт sha256:d9cff390… (installer 0.2.4)
cd /home/animastor/prod && git pull --ff-only
docker compose -p animastor --env-file .env up -d backend
```

Lock/package в backend-репо вернуть revert-коммитом `e31b4e2` через work/ и merge.
