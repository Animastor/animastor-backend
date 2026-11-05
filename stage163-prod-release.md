# Stage 163 — backend: DELETE /book удаляет `retry-budget` книги (2026-11-05)

**Статус: ВЫПУЩЕНО. Откат не выполнялся.** Продолжение задачи L
(`/home/animastor/reports/2026-11-05/release-L.md` §6).

## 1. Образ и пины

| Что | Значение |
|---|---|
| backend (новый) | `ghcr.io/animastor/animastor-backend@sha256:c0abc8eaf0ae47a256cbf7b6987362f751e797ccb3e1ce3964c5fca779b1c4bf` (теги `deploy-041923a`, `041923ae5a021656cefb9148dedc54cda74fc0b2`; label revision = `041923a…`) |
| собран из | `041923a` = merge `fix/retry-budget-book-delete` (`6678d8e`); approve `APPROVED_COMMIT = 041923ae5a021656cefb9148dedc54cda74fc0b2` (`ada8900` → merge `6e42316`) |
| откат (digest) | `sha256:ea31830f10c1238a6663c10915f094e45e36f7288086b6a632f0250a83fe1824` (stage 162) |
| `animastor-deploy` | `8f7fe3a` (пин) → merge `8b0d62a` |
| docs | `c0f9c51`, `deploy-docs.sh` (бэкап `backups/www-docs-pre-c0f9c51-20261105112337`, 0 битых ссылок) |
| web / APK | без изменений |

Выкатка: `docker compose -p animastor --env-file .env up -d backend` из `prod/`, старт 11:23:01Z;
только backend, `prune`/`down`/`--force-recreate` не выполнялись.

## 2. Проверки

| Что | Результат |
|---|---|
| Предпроверки | digest/тег в registry совпадают; логи `reports/2026-11-05/pre-release-rb-backend-20261105T112146Z.txt` (600); бэкап `backups/pg-pre-release-rb-20261105T112146Z.dump` (287); нетерминальных задач 0, `active-*`/heartbeat 0 |
| После старта | image = пин, restarts=0; `/health` 200 `{"status":"ok","loop":true,"redis":"PONG"}`; `/worker/counts` 200; `[ERROR/FATAL/Unhandled/ReferenceError/TypeError` с 11:23:00Z → 0 |
| Фикс на проде | тестовый аккаунт `rb_smoke_1793877829` + `POST /book/blank` `new_book_1793877829397` → `/regenerate` audio → появился `animastor:retry-budget:new_book_1793877829397:ch-d58cc1c5:sc-3dd121aa:audio` (val 9, **TTL -1**) → `DELETE /book` 200 → ключей `retry-budget:{book}:*` **0**; чужие (`ba_…`, `import_…`) и агрегаты `global` / `type:transient` на месте; `[CLEAN] … deleted 10 Redis keys` |
| Остаток книги после DELETE | 4 ключа, все с TTL: `cancelled-workers` 3596 с, `dispatch-noprogress` 3596 с, `dispatch-completed` ~1841 с, `force-dispatch-stages` 100 с — удалены вручную (откат проверки); диск 0, PG 0, планировщик по книге после удаления — 0 попыток |
| Уборка аккаунта | logout 200; бэкап `backups/pg-pre-rb-smoke-cleanup-20261105T112451Z.dump`; транзакция sessions/workspace_members/workspaces/users по 1 строке; счётчики PG = исходным (users 2, sessions 2, books 2, workspaces 3, generation_tasks 64); Redis по user/ws — 0 |

## 3. Откат (не выполнялся)

```sh
# animastor-deploy (из work/): revert 8b0d62a → digest sha256:ea31830f10c1238a6663c10915f094e45e36f7288086b6a632f0250a83fe1824
cd /home/animastor/prod && git pull --ff-only
docker compose -p animastor --env-file .env up -d backend
```
