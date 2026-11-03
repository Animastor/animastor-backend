# Stage 159 — backend (orchestration 0.3.2) + gpu-hub v0.2.8 в прод (2026-11-03)

**Статус: ВЫПУЩЕНО. Откат не выполнялся.**

Полный отчёт с бэкапами, логами и командами:
`/home/animastor/reports/2026-11-03/release-backend-hub-v028.md`.

## 1. Образы и пины

| Сервис | Digest | Собран из | Предыдущий (откат) |
|---|---|---|---|
| backend | `sha256:f73adeffe9a6d1e8e8d608cb3dc7caba1b0cc4d9d8d4b87364558990523e5654` | `e0c2149` (approve `653c0da`, orchestration `0.3.2`) | `sha256:1c88a5620f3ae930c16de24fd0ed1e238df2bc9d49f0b8013c3991b7f6d84482` (0.3.1) |
| gpu-hub | `sha256:0b4522ad46b44e7d1eb79b912923327b44954b392ad2c5cef156803242137d26` (v0.2.8) | `animastor-gpu-hub` `c190ce2` | `sha256:5327dd3d2ddcc95fb08eaf706e232bf384925ec85d87752756659a03a08bf5e1` (v0.2.7) |

| Коммит `animastor-deploy` | Содержание |
|---|---|
| **`0aff0f6`** | `release: backend orchestration 0.3.2 (sha256:f73adeff, approve 653c0da)` — `docker-compose.yml:69` |
| **`deb9d8d`** | `release: gpu-hub v0.2.8 image sha256:0b4522ad (installer 0.2.7, bundle 2.2.3)` — `docker-compose.yml:104` |

Выкатка: `docker compose -p animastor --env-file .env up -d backend` (07:23:20Z),
затем `… up -d gpu-hub` (07:30:19Z). Пересоздавались только эти два сервиса;
`prune`/`down`/`--force-recreate` не выполнялись.

## 2. Backend — проверки

| Что | Результат |
|---|---|
| Миграции | `[PG] WL-1: workers.last_seen ms → s on 2 row(s)`; `WL-1: … seconds check ensured`; `WL-2: workers.revoked_at seconds check ensured` |
| `max(last_seen)` | `1793622717060` (мс) → `1793622717` (с, < 1e11) ✅ |
| CHECK | `workers_last_seen_seconds_check`, `workers_revoked_at_seconds_check` — оба на месте ✅ |
| orchestration в контейнере | `0.3.2` (пин `^0.3.2`) ✅ |
| health | `https://animastor.org/health` → 200, `{"status":"ok","loop":true,"redis":"PONG"}` ✅ |
| 5 мин без dispatch | 0 совпадений `Task sent` / `[GPU] Enqueue` / `dispatch=` ✅ |
| reconcile | `15 scenes scanned, 0 inconsistencies`, `result_recovery:0` ✅ |
| fence `3227a8b2c281` | ровно **1** warn в 07:24:24Z `marked unrecoverable (canonical_content_mismatch, no staged copy)`; ключ `animastor:fence-unrecoverable:…` есть; дальше тишина ✅ |

## 3. gpu-hub v0.2.8 — проверки

| Что | Результат |
|---|---|
| Артефакты (пересчёт в контейнере) | installer-src `0.2.7` / 39 файлов / `4f92c986…`; worker-bundle `2.2.3` / 8 файлов / `2d919524…`; workflows `0d51107d…`; manifests `afbc3371…` — все = lock ✅ |
| `GET /gpu/installer` | 200, 9 700 B, `sha256 1babc3ae…`; `bootstrap 1.2.0`, installer `0.2.7`, бандл `2.2.3` ✅ |
| `GET /gpu/installer/sha256` | 200, `version 0.2.7`, `sha256 3bf7ed0266ee810841b32e94b672a7748efd7a37ab864b0655d2ae89a7fa2b11`, 260 868 B |
| `GET /gpu/installer/bundle` | 200, 260 868 B, sha256 совпал с `/installer/sha256` ✅ |
| Логи после старта | только `[ARTIFACTS] … (baked-in)` и `🚀 GPU HUB running on 5000`; `error/exception/fatal` — 0 ✅ |

Бэкап bootstrap до выкатки: `backups/hub-installer-pre-v028.sh`
(9 700 B, `sha256 1a1ec057…`, installer 0.2.5 / бандл 2.2.1).

## 4. Бэкапы и docs

- Полный `pg_dump -Fc`: `backups/pre-stage159-20261103T072014Z/animastor-full.dump`
  (130 488 B, `sha256 93672d04…`); `workers.sql` (3 772 B, `sha256 d6aa1766…`).
- Логи за 24 ч до recreate: `reports/2026-11-03/gpu-hub-logs-last24h.log`,
  `reports/2026-11-03/backend-logs-last24h.log`.
- Зеркало docs: `prod/scripts/deploy-docs.sh` от `dcea2d7` — 0 битых ссылок,
  295 `*.md` в `tree.json`, бэкап `backups/www-docs-pre-dcea2d7-20261103073146`,
  `/docs/` и `/docs/tree.json` → 200.

## 5. Откат

- **Backend** — по `reports/2026-11-02/gpu-e2e-fixes.md` §«Откат»: сначала (до
  смены образа) одной транзакцией снять оба seconds-CHECK и умножить
  `last_seen`/`revoked_at` на 1000 где `< 1e11`, затем пин на `1c88a562…`,
  `up -d backend`, и сразу после старта повторить оба `UPDATE … * 1000`.
  Ключи `animastor:fence-unrecoverable:*` удалять не нужно.
- **gpu-hub** — пин на `5327dd3d…` (v0.2.7) → `up -d gpu-hub`; bootstrap
  вернётся к installer 0.2.5 / бандлу 2.2.1 вместе с образом.

## 6. Не сделано

- `prune`, `compose down`, `--force-recreate` — не выполнялись (запрещены
  правилами, в задании не было).
- Живой прогон генерации на ноде — не выполнялся: по заданию проверку на ноде
  делает владелец.
- Workflow `backend-ghcr-release` / `gpu-hub-ghcr-release` не запускались:
  образы собраны владельцем, `gh` на сервере не авторизован.
