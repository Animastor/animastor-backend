# Stage 161 — backend (orchestration 0.3.5), «Вся книга» (аудио) — квотная утечка (2026-11-05)

**Статус: ВЫПУЩЕНО. Откат не выполнялся.** Задача J (выкатка задачи I).
Полный отчёт: `/home/animastor/reports/2026-11-05/release-J.md`; разбор:
`reports/2026-11-05/reconcile-quota-leak.md` §5–6.

## 1. Образ и пины

| Что | Значение |
|---|---|
| backend (новый) | `ghcr.io/animastor/animastor-backend@sha256:2150e16387a9d74b43d47bdca672ce64cf60eeb58d7236e8053cc0b537724a3b` (теги `deploy-b98d953`, `b98d953b72f29895a315faa3c1e3cb9483e2fb00`) |
| собран из | `b98d953` (bump `@animastor/orchestration ^0.3.5`), approve `APPROVED_COMMIT = b98d953b72f29895a315faa3c1e3cb9483e2fb00` |
| откат (digest) | `sha256:731d72ed13699cb45c18666eda5661f0de9a6846ab450a4c8e411f46e3631b9c` (orchestration 0.3.4, stage 160) |
| gpu-hub / web / APK | без изменений (`sha256:6b84cc10…`, v0.2.9) |
| `animastor-deploy` | `ff330db` (пин) → merge `f68c598` (was `7349341`) |
| `animastor-backend` | bump `b98d953` → merge `631ca7d`; approve `743b69c` → merge `c930f6a` (was `4cad37f`) |

Выкатка: `docker compose -p animastor --env-file .env up -d backend` из `/home/animastor/prod`
07:39:29–07:40:07Z — только `up -d backend`; `prune`/`down`/`--force-recreate` не выполнялись,
pg/redis/proxy не пересоздавались.

## 2. Предпроверки

| Что | Результат |
|---|---|
| `KEEP_AUDIO_CHUNKS` в контейнере до выкатки | `=1` ✅ (значение не печаталось, сверка по шаблону) |
| Логи backend / хаба | `reports/2026-11-05/pre-release-j-backend-20261105T073650Z.txt` (7 665 983 B), `pre-release-j-hub-20261105T073650Z.txt` (69 574 B), 600 ✅ |
| Бэкап PG | `backups/pg-pre-release-j-20261105T073650Z.dump`, 131 327 B, 600, `pg_restore -l` → 287 записей ✅ |
| `recover-reconcile-quota-leak.sh --dry-run` (снимок «до», 07:38:12Z) | `active-audio = 8 (TTL -1); live = 2; phantom = 6`, 13 stale → RESTORE / 4 ok, задача `running` (17 строк), реестр `active`; «LIVE» у 2 — только возраст < 120 с ✅ |

## 3. Backend — проверки после старта

| Что | Результат |
|---|---|
| orchestration в контейнере | `0.3.5` ✅ |
| digest контейнера | `.Image` = `sha256:2150e163…` (пин compose) ✅ |
| health | `https://animastor.org/health` → 200 `{"status":"ok","loop":true,"redis":"PONG"}`; из `animastor-proxy` → 200 ✅ |
| ошибки | `[ERROR]/Unhandled/TypeError/ReferenceError` с 07:39:30Z → **0** (backend и gpu-hub) ✅ |
| задача BA | `[STARTUP] … 1 generation task(s) → interrupted (resume by button)`, `17 PG row(s) interrupted`, `13 scene(s) removed from the active index — nothing resumed` ✅ |
| DRIFT-сверка | `COUNTER_RECONCILIATION_COMPLETE: 0 corrected, 0 total drift` на каждом прогоне (5 с), reconcile-циклы каждые 60 с без ошибок ✅ |

**Фантомы:** `PHANTOM_DISPATCH_CANCELLED` в логе **не понадобился** — к первому прогону
DRIFT (07:40:08.861, counter=0 и leases=0, drift 0) leases/meta фантомов уже были сняты
стартовым путём прерывания задачи (`[STARTUP] Stale active counters reset to 0` +
interrupted-обработка); sweep `sweepPhantomDispatches` физически не находил кандидатов.
Критерий «фантомов 0» выполнен.

`recover-reconcile-quota-leak.sh --dry-run` после старта (07:44:47Z и повторный 07:50Z):

```
hub jobs: 0 dispatch id(s) in running/queues
lease … — (строк нет)
counter animastor:runtime:active-audio = 0 (TTL -2); live dispatches = 0; phantom (book) = 0
dry-run: nothing written
```

Фантомов **0**, счётчик `active-audio = 0 =` числу живых диспатчей (ожидалось 0) ✅ —
`--apply` **не потребовался** (ничего не писалось). Снимок «до» и «после» — в
`reports/2026-11-05/release-J.md`.

## 4. Docs

`prod/scripts/deploy-docs.sh --dry-run` → 5 изменений, 0 удалений, 0 битых ссылок;
затем выкладка: коммит `b3a902b`, бэкап `backups/www-docs-pre-b3a902b-20261105074938`,
diff зеркала пуст, sha256 CHANGELOG.md в контейнере = хосту, `/docs/` и `tree.json` → 200 ✅.

## 5. Дальше (критерий приёмки, владелец)

Владелец включает audio-ноду и жмёт «Вся книга» на BA; затем собираются логи окна и
проверяется: 13 stale-сцен → `READY_RESTORE` без GPU-job; панель 31/31 и `completed`;
`active-audio` возвращается в 0; 409 нет.

## 6. Откат

Digest `sha256:731d72ed…` в `prod/docker-compose.yml` коммитом в animastor-deploy →
`up -d backend`. Данные: `recover-reconcile-quota-leak.sh --rollback <dir>`
(бэкапы `backups/rql-<UTC>/` — в задаче I; на этот прогон `--apply` не создавался).
Откат кода — revert merge-коммита в main backend (без force-push).
