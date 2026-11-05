# Stage 160 — backend (orchestration 0.3.4) + gpu-hub v0.2.9, web, APK 0.2.6, docs в прод (2026-11-05)

**Статус: ВЫПУЩЕНО. Откат не выполнялся.**

Полный отчёт с бэкапами, проверками и командами:
`/home/animastor/reports/2026-11-05/release-A-B-C.md`. План: `reports/2026-11-04/integration-A-B-C.md` §8–9.

## 1. Образы и пины

| Сервис | Digest | Собран из | Предыдущий (откат) |
|---|---|---|---|
| backend | `sha256:731d72ed13699cb45c18666eda5661f0de9a6846ab450a4c8e411f46e3631b9c` | `b2d269c` (approve `ccd9edf`, orchestration `0.3.4`) | `sha256:f73adeffe9a6d1e8e8d608cb3dc7caba1b0cc4d9d8d4b87364558990523e5654` (0.3.2) |
| gpu-hub | `sha256:6b84cc102a1d171024c39c3862387e162673d7eaddbfcbe15dbfbd8de9a15d0e` (v0.2.9) | `animastor-gpu-hub` `c9aa24f` | `sha256:0b4522ad46b44e7d1eb79b912923327b44954b392ad2c5cef156803242137d26` (v0.2.8) |

| Коммит `animastor-deploy` | Содержание |
|---|---|
| **`03bba1d`** | `release: backend orchestration 0.3.4 (sha256:731d72ed, approve ccd9edf)` |
| **`7349341`** | `release: gpu-hub v0.2.9 image sha256:6b84cc10 (installer 0.2.8, bundle 2.3.0)` |

Выкатка 05.11: backend 04:06:16Z, gpu-hub 04:06:50Z — только `up -d <сервис>`;
`prune`/`down`/`--force-recreate` не выполнялись, pg/redis/proxy не пересоздавались.

## 2. Предпроверки

| Что | Результат |
|---|---|
| `KEEP_AUDIO_CHUNKS` в backend до выкатки | `1` (сверка, значение не печаталось) ✅ |
| Бэкап PG | `backups/pg-pre-release-20261105T040537Z.dump`, 130 567 B, 600, `pg_restore -l` → 272 записи ✅ |
| Тесты backend на `b2d269c` | 3745 passing / 28 pending / 0 failing, exit 0 ✅ |

## 3. Backend — проверки

| Что | Результат |
|---|---|
| orchestration в контейнере | `0.3.4` ✅ |
| health | `/health` → 200, `{"status":"ok","loop":true,"redis":"PONG"}` ✅ |
| digest контейнера | `Config.Image` = `RepoDigests` = пин ✅ |
| reconcile после старта | `17 scenes scanned, 0 inconsistencies`, `reconcile:0_issues` ✅ |
| ошибки | `[ERROR]/Unhandled/TypeError/ReferenceError` за 12 мин → 0 ✅ |

## 4. gpu-hub v0.2.9 — проверки

| Что | Результат |
|---|---|
| `GET /gpu/installer/sha256` | 200, installer `0.2.8`, `sha256 d51f71ceb65218247f97cc537a5aeaa3bc6274dc500448bcf524e87397f7536a`, 266 655 B ✅ |
| worker-bundle | `2.3.0`, 7 файлов; `sha256_tree e10f8441…` = `artifacts.lock.json` ✅ |
| installer-src | `0.2.8` ✅ |
| `/gpu/health` | 200 `{"gpus":0,…}` ✅ |
| логи | `error/exception/fatal` за 15 мин → 0 ✅ |

## 5. Web / APK / docs

- web `3df2ae4`: `index.html` sha256 `0efe99f6…`, бандл `assets/index-C_Y8MUpy.js`, `app.animastor.org` → 200;
  бэкап `backups/www-app-pre-3df2ae4-20261105040719`.
- APK `0.2.6` (8) из `cba096f`: 10 649 859 B, sha256 `89876f9f…`, скачивание → 200 и sha256 совпал;
  `animastor-site` `cedc563` (`version.json` 0.2.6/8), бэкап `backups/apk-pre-0.2.6-20261105041223`.
- docs `7415f5f`: 296 `*.md`, 0 битых ссылок, `CHANGELOG.md` sha256 `45089ece…`, бэкап
  `backups/www-docs-pre-7415f5f-20261105040823`.

## 6. Не сделано

- Живая проверка A/B/C на тестовой книге (`book_sweep=false`, `READY_CHECK … reason=committed`,
  `Placeholder marker cleared`) — к хабу не подключено нод (`gpus:0`), генерацию запустить нечем.
- `scripts/fix-fake-ready-audio-20261104.sql` — не запускался, ждёт отдельной команды владельца.
- Установщик 0.2.8 на нодах — вне активной задачи (по решению владельца).
- Workflow'ы сборки образов не запускались: образы собраны владельцем.

## 7. Откат

- backend: пин `sha256:f73adeff…` коммитом в animastor-deploy → `git -C prod pull --ff-only` →
  `docker compose -p animastor --env-file .env up -d backend`.
- gpu-hub: пин `sha256:0b4522ad…` (v0.2.8) → `up -d gpu-hub`.
- web/docs/APK — команды отката в отчёте §6.
