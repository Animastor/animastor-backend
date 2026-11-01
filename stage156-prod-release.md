# Stage 156 — `@animastor/orchestration` 0.3.1 в прод

Дата: 2026-11-01. Оператор: агент. Push только в `origin`.
`down` / `prune` / пересоздание pg / redis / proxy не выполнялись.

**Статус: ПОДГОТОВЛЕНО. Ожидает запуска workflow владельцем и digest. Деплой не выполнен.**

## 1. Параметры выпуска

| Параметр | Значение |
|---|---|
| Approve-коммит | `8b0d90d6935cb2e771fa17d7a2d4618c59f3990b` |
| Дерево образа (`APPROVED_COMMIT`) | `e31b4e293aa376b5b0fd03170ddd59bd3e50b4dd` (merge bump 0.3.1) |
| Тег образа | `deploy-8b0d90d` (CI `backend-ghcr-release`, запуск — владелец) |
| Digest образа | _ожидается_ |
| Предыдущий образ (Stage 155) | `sha256:74745b380f89075b61b1d982fd4913388af2623649748a1df14be4ee892f42f5` |

## 2. Что вошло

`backend/package.json`: `@animastor/orchestration` `^0.3.0` → `^0.3.1`;
`backend/package-lock.json` — 0.3.1, integrity
`sha512-H0TKmIWTAsi1AVsH2Vf+IsyWswADy7mP5juyGA8h2bJ4LdBG/+m7EiUNA80YYozpXHa4NUAwIr2ANFFrX/8Awg==`.

## 3. Тесты

`ANIMASTOR_DOCS_ROOT=/home/animastor/src/animastor-docs ./scripts/test-backend.sh`
на `e31b4e2`: **3657 passing, 28 pending, 0 failing**, exit 0.
База `933e19c` — 3656/29/0; pending-тест «npm copy matches» стал passing.

## 4. Деплой

_Не выполнялся. Заполнить после digest:_

- digest в `prod/docker-compose.yml` (коммит в `animastor-deploy` из work/)
- `git -C /home/animastor/prod pull --ff-only`
- бэкап compose
- `docker compose -p animastor --env-file .env up -d backend`
- проверки: версия пакета в контейнере, 3 мин логов без ошибок, `/health`

## 5. Прод-проверка (только по явной команде)

Одна сцена audio и одна image с 2 IU на тестовой книге.
Критерии: нет `terminally rejected` как warn; `iu-progress` = числу IU;
`animastor:result:*` пуст через 2 минуты; очереди 0.

## 6. Откат

Вернуть в `animastor-deploy` digest Stage 155 (`sha256:74745b38…`), `pull --ff-only`,
`up -d backend`; bump в backend-репо откатить revert-коммитом через work/ и merge.
