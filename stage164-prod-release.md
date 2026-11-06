# Stage 164 — оркестрация v2, этап 1 на проде (2026-11-06)

**Статус: ВЫПУЩЕНО. Откат не выполнялся.** Полный отчёт: `/home/animastor/reports/2026-11-06/orch-v2-1d-release.md`.

## 1. Образы, пины, пакет

| Что | Значение |
|---|---|
| backend | `ghcr.io/animastor/animastor-backend@sha256:1e33a5f0b73bfd85cdfa45c87ca830e298d184149e15accf399f0ce4a64da55d` (`deploy-1189a31`) |
| собран из | main `1189a31` (merge `orch-v2/1c`: 1a–1d); approve `08eec82` (`APPROVED_COMMIT = 1189a31f0eb6a614d5b4adec9fd6a8b26732aa51`) |
| откат backend | `sha256:c0abc8eaf0ae47a256cbf7b6987362f751e797ccb3e1ce3964c5fca779b1c4bf` (stage 163) |
| gpu-hub | `ghcr.io/animastor/animastor-gpu-hub@sha256:d0a642099c3c4b996a0bab5a4b1808c6c76bbe5eab687088b64c9cfbdd6c0439` (`v0.3.0`, main `f39e704`, бандл воркера 2.4.0) |
| откат хаба | `sha256:6b84cc102a1d171024c39c3862387e162673d7eaddbfcbe15dbfbd8de9a15d0e` (`v0.2.9`) |
| `@animastor/orchestration` | 1.0.0 из npm, shasum `780370157265e203c84c8903f8d7e6ee3832ac18` |
| `animastor-deploy` | `9682889` (nginx + ORCH_V2_* env) → `1fc9060` (хаб + `BACKEND_INTERNAL_URL`) → `d774637` (backend) |
| `.env` прода | добавлены `ORCH_V2_UPLOAD_SECRET` (новый, 64 байта) и `ORCH_V2_ENABLED=1`; бэкап `backups/prod-env-pre-orch-v2-20261106T063105Z.env` |
| docs | `3c75fb2`, `deploy-docs.sh` (бэкап `backups/www-docs-pre-3c75fb2-20261106070624`) |

Выкатка шла по одному сервису: `up -d gpu-hub` (05:38Z) → `up -d backend` (05:39Z, v2 выкл.) → `nginx -t` + `nginx -s reload` → `up -d backend` (06:31Z, v2 вкл.).
`prune` / `down` / `--force-recreate` / пересоздание proxy не выполнялись.

## 2. Проверки (кратко)

| Шаг | Проверка | Результат |
|---|---|---|
| хаб | `/gpu/installer`; `/gpu/worker-bundle` | 200; бандл 2.4.0 |
| хаб | `/gpu/v3/*` с токеном воркера | 503 `orch_v2_disabled` (до S2) → `{task:null}` (после) |
| backend, v2 выкл. | лог старта | `[ORCH-V2] disabled`; ошибок 0 |
| backend, v2 выкл. | `/internal/gen/*` | 503 |
| nginx | `/internal/gen/claim`, `/beacon`, прочее `/internal/`, app./admin. | 404 |
| nginx | `/internal/gen/jobs/*` | доходит до backend |
| legacy, v2 выкл. | заглушка → `ready` через хаб v2 + нода 2.4.0 | ✅ (−91 dB → −27,1 dB) |
| v2 вкл. | лог | `[ORCH-V2] enabled: migration applied`; `gen_*`, `books.orchestration` (все legacy) |
| legacy, v2 вкл. | вторая сцена | ✅ (−91 dB → −21,4 dB), `gen_jobs` 0 |
| ADR §12, тестовая книга | a) сцена, b) двойной клик, c) глава, d) Стоп (interrupt на ноде), e) рестарт backend, f) остановка воркера (`worker_offline` → attempt 2) | ✅ все |
| BA | `UPDATE 1` → v2; «аудио» stale-сцены | ✅ `ready` с sha256 / job_id |

**Уборка:** тестовая книга `release1d_legacy_ctl_1793946560` (`DELETE /book` + 35 ключей Redis вручную, диск 0, PG 0) и тестовый аккаунт `release_1d_smoke_…` с воркером `e8b67fc6` (API revoke+purge, PG одной транзакцией) удалены. Счётчики PG равны исходным: users 2, workspaces 3, books 2, workers 2.

## 3. Откат

```sh
# v2 выкл.: восстановить prod/.env из backups/prod-env-pre-orch-v2-20261106T063105Z.env
#   (или удалить строки ORCH_V2_*) → docker compose -p animastor --env-file .env up -d backend
# BA → legacy:
#   UPDATE books SET orchestration='legacy' WHERE book_id='ba_1788172242081' AND orchestration='v2';  -- + gen.purgeBook
# образы: в work/ git revert d774637 (backend) / 1fc9060 (хаб) в animastor-deploy → push → cd prod && git pull --ff-only
docker compose -p animastor --env-file .env up -d backend     # / gpu-hub
```
