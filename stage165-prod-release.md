# stage165 — выкатка на прод (краткий отчёт)

Дата: 2026-11-07. Полный отчёт: `reports/2026-11-07/stage165-prod-release.md` (сервер).
Релиз: orch v2 2a (картинки) + clean-book legacy redis keys + worker logs (W2/W3/W4) + gpu-hub v0.3.1.

## Состав

| Репо | main | Влито |
|---|---|---|
| animastor-backend | `49b679d` (approve `APPROVED_COMMIT = 6461054`) | `orch-v2/2a-image`, `fix/clean-book-redis-keys`, `feat/worker-logs` |
| animastor-gpu-hub | `5618d52` | `fix/heartbeat-merge`, `feat/worker-logs`, репин на worker `c7c43b5` |
| animastor-worker | `c7c43b5` | `feat/worker-logs` (бандл 2.4.1) |
| animastor-docs | `7b8ec61` | три docs-ветки, зеркало выкачено |
| animastor-deploy | `2ade59d` | `effcf58` hub v0.3.1; `2ade59d` backend + mount `/data/worker-logs` |

## Пакет

`backend/package.json` → `"@animastor/orchestration": "^1.1.0"`; lock: `resolved …orchestration-1.1.0.tgz`,
`integrity sha512-nzYOCAGruQveLSo3OSj+vM5ilKmpv0oSnbWt+rbI4Su9qCA/4oYiQZGvXxxts3y9H/y0VUsSTdiSVjiZ/D5zOw==`;
`npm ci` → `1.1.0`, один `@animastor/generation@0.1.1`.

## Тесты (команда → результат)

- `ANIMASTOR_DOCS_ROOT=/home/animastor/src/animastor-docs scripts/test-backend.sh` →
  **3818 passing / 28 pending / 0 failing**, exit 0 (лог на сервере: `reports/2026-11-07/stage165-backend-tests.log`).
- worker `node tests/run-all.cjs` → 98 pass / 0 fail; gpu-hub `npm test` → 40 passed / 0 failed (freeze 17 маршрутов).

## Образы

- backend `sha256:a5210f6429d987feaef32d9975b7ac7cf7343c9dbd9e7e8aa2d022b5c4c620b6` (тег `deploy-6461054`)
  ← main `6461054`; откат `sha256:1e33a5f0b73bfd85cdfa45c87ca830e298d184149e15accf399f0ce4a64da55d` (`deploy-1189a31`).
- gpu-hub `sha256:c5ceae99247285924823b13e9973d010dfd54d6640cdc776b8ac2335e443d274` (тег `v0.3.1`)
  ← main `5618d52`; откат `sha256:d0a642099c3c4b996a0bab5a4b1808c6c76bbe5eab687088b64c9cfbdd6c0439` (`v0.3.0`).

В образе backend: `@animastor/orchestration` 1.1.0, `worker-logs-store.js`, `image-ports.js`, `log_shipping` в схеме.
В образе хаба: `artifacts.lock.json` → worker `c7c43b5` / backend `49b679d`, бандл 2.4.1, `/v3/logs`, `BACKEND_INTERNAL_URL`.

## Прод

- Бэкап PG: `backups/pre-stage165-20261107T051747Z/pg-animastor.dump` (149 174 B, `pg_restore -l` → 310).
- Миграция WLOG-1 применена при старте: `workers.log_shipping` (BOOLEAN NOT NULL DEFAULT false).
- Mount `/home/animastor/data/worker-logs:/data/worker-logs` (`root:root 0700`), `test -w` → ok.
- `/api/v1/books` → 200; `progress-panel` книги `ba_1788172242081` (v2) → 200; ошибок в логе backend 0.
- Хаб: `/installer` → 200 (бандл 2.4.1), `POST /v3/logs` без токена → 401, в логе `GPU HUB running on 5000`, 0 ошибок.

## Не сделано

- Ноды не обновлялись (решение владельца); после обновления до 2.4.1 проверить в логе воркера отправку логов и
  появление `/home/animastor/data/worker-logs/<worker_id>/current.log` на VPS.
- `log_shipping=false` у двух воркеров владельца: они в `personal`-воркспейсе с владельцем `role='user'`, бэкфилл
  WLOG-1 такие строки не включает (tenant). Запись в прод-БД не делалась — нужно решение владельца.

## Откат

`git revert 2ade59d` (backend + mount) и/или `git revert effcf58` (hub) в work/, `git pull --ff-only` в `prod/`,
затем `docker compose -p animastor --env-file .env up -d backend` (и/или `gpu-hub`).
