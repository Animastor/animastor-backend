# Stage 162 — backend: «Снять» остановленной задачи (K) + лог `[WORKER-COUNTS]` (2026-11-05)

**Статус: ВЫПУЩЕНО. Откат не выполнялся.** Задача L (релиз K + счётчик воркеров).
Полный отчёт: `/home/animastor/reports/2026-11-05/release-L.md`; основание:
`reports/2026-11-05/generator-stopped-row.md` (K), `release-J.md` §6.6.

## 1. Образ и пины

| Что | Значение |
|---|---|
| backend (новый) | `ghcr.io/animastor/animastor-backend@sha256:ea31830f10c1238a6663c10915f094e45e36f7288086b6a632f0250a83fe1824` (теги `deploy-b0ede73`, `b0ede734a0c8ebd9d0bb5e7f968ef117048f8123`; label `org.opencontainers.image.revision` = `b0ede73…`) |
| собран из | `b0ede73` = merge `fix/worker-counts-warn` (`5f564c9`) поверх K (`24e4207` → `f1a8b90`); approve `APPROVED_COMMIT = b0ede734a0c8ebd9d0bb5e7f968ef117048f8123` |
| откат (digest) | `sha256:2150e16387a9d74b43d47bdca672ce64cf60eeb58d7236e8053cc0b537724a3b` (stage 161) |
| `animastor-deploy` | `c7e75c8` (пин) → merge `71e8c11` (was `f68c598`) |
| `animastor-backend` | `5f564c9` → merge `b0ede73`; approve `5783aa8` → merge `4ba8a54` |
| web | `d9cb135` выложен `deploy-web.sh` |
| APK | 0.2.7 (9), android `be1233c`, site `a9eae36`, `deploy-apk.sh` |

Выкатка: `docker compose -p animastor --env-file .env up -d backend` из `/home/animastor/prod`,
старт контейнера 10:10:42Z — только `up -d backend`; `prune`/`down`/`--force-recreate` не
выполнялись, pg/redis/proxy не пересоздавались.

## 2. Предпроверки

| Что | Результат |
|---|---|
| digest в registry | `docker buildx imagetools inspect …@sha256:ea31830f…` → index, linux/amd64; тег `deploy-b0ede73` → тот же digest ✅ |
| Логи backend «до» | `reports/2026-11-05/pre-release-l-backend-20261105T100808Z.txt` (1 243 320 B, 600) ✅ |
| Бэкап PG | `backups/pg-pre-release-l-20261105T100828Z.dump`, 131 347 B, 600, `pg_restore -l` → 287 ✅ |
| Активные задачи | `generation_tasks`: completed 33 / cancelled 14 / interrupted 17, нетерминальных 0; ключей `active-*` и heartbeat в Redis 0 — рестарт ничего не прерывает ✅ |

## 3. После старта

| Что | Результат |
|---|---|
| контейнер | `.Config.Image` = `…@sha256:ea31830f…`, running, restarts=0 ✅ |
| health | `https://animastor.org/health` → 200 `{"status":"ok","loop":true,"redis":"PONG"}` ✅ |
| `/api/v1/worker/counts` | 200, 397 B ✅ |
| ошибки | `[ERROR/ERROR:/FATAL/Unhandled/ReferenceError/TypeError/WORKER-COUNTS` с 10:10:40Z → 0. Есть только `[AI-HEALTH] API returned 402 Insufficient Balance` — баланс провайдера, было и до релиза (J §6.2) |

## 4. Проверка «Снять» (тестовый аккаунт и книга, удалены)

`release_l_smoke_1793873869` → `POST /book/blank` `new_book_1793873878331` → `/regenerate`
audio current_scene → задача `generation-audio-1793873889356-f05ea429` `active` (circuit_open) →
10:23:11 `FAILED_NO_PROGRESS` (attempts=61) → `POST /cancel-worker {type:audio, task_id}` →
**200 `task_ids:[…f05ea429]`**, PG `cancelled`, лог `(stopped: failed) … tasks=1 scenes=1`;
progress-panel: `cancelled` ещё ~30 с (фронт скрывает по `task_ids`), с 10:23:57 — `tasks: []`;
попыток диспатча после отмены 0. Повтор через 60 с → 404 (задача удалена из реестра — как в K).
Уборка: `DELETE /book` 200; диск 0, PG 0; Redis — 11 ключей книги удалены (`retry-budget` был без TTL);
аккаунт — транзакция по 1 строке (sessions/workspace_members/workspaces/users), бэкап до
`backups/pg-pre-release-l-smoke-cleanup-20261105T102515Z.dump`. Счётчики PG = исходным.

## 5. Откат (не выполнялся)

```sh
# animastor-deploy (из work/): revert 71e8c11 → digest sha256:2150e16387a9d74b43d47bdca672ce64cf60eeb58d7236e8053cc0b537724a3b
cd /home/animastor/prod && git pull --ff-only
docker compose -p animastor --env-file .env up -d backend
```
Web: `rsync -a --delete backups/www-app-pre-d9cb135-20261105101207/ www/app/`.
APK: `backups/apk-pre-0.2.7-20261105101610/` (tmp + mv), version.json — revert `a9eae36` в animastor-site.
