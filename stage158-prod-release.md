# Stage 158 — gpu-hub v0.2.7 в прод (2026-11-02)

**Статус: ВЫПУЩЕНО. Откат не выполнялся.**

## 1. Образ и пин

| Что | Значение |
|---|---|
| Образ | `ghcr.io/animastor/animastor-gpu-hub:v0.2.7` |
| **Digest (manifest)** | `sha256:5327dd3d2ddcc95fb08eaf706e232bf384925ec85d87752756659a03a08bf5e1` |
| Сборка из | `animastor-gpu-hub` `2399007` |
| Предыдущий (откат) | `sha256:5c95bb0e0f719566882af3cfc49aa493d3a16c39fa65679e845fa1fe6dcfef57` (v0.2.6) |
| **Коммит animastor-deploy** | **`6c914f6`** — `chore(deploy): set gpu-hub v0.2.7 digest` (merge `b76aed5..6c914f6`) |
| Правка | `docker-compose.yml`: `gpu-hub` переведён с `@sha256:5c95bb0e…` на `@sha256:5327dd3d…`, пин только по digest |

## 2. Содержимое образа (`/app/artifacts.lock.json`)

| Артефакт | Версия / commit | `sha256_tree` |
|---|---|---|
| installer-src | `0.2.5` (backend `1125a03`) | `afa73fd2571c34617f29770612d2306b765b60060e549bc249cedd15ec29fd1e` (38 файлов) |
| worker-bundle | `2.2.1` (worker `8bbff97`) | `a2f090fec618d6c14f5cb4d872276ccd475bc244e314d7dbc8bd5c04c34c4794` (8 файлов) |
| workflows | — | `0d51107d58f9774fb761fca7319bdeb637b02a18c0f8f92dfec713c97beca738` (9 файлов) |
| install-manifests | — | `afbc3371fa54ee5b2df9f526835c186c3b2e9dd1883d20efed29209904d51c4a` (3 файла) |

Хэши пересчитаны внутри контейнера по формуле lock (LC_ALL=C, `<sha256(file)>  <relpath>\n`,
сортировка по relpath) — оба дерева совпали с lock.

## 3. Выкатка

```
docker compose -p animastor --env-file .env config --no-interpolate   # OK
docker compose -p animastor --env-file .env up -d gpu-hub
# Container gpu-hub Recreated / Started
```

Контейнер `5327dd3d2ddc`, `StartedAt=2026-11-02T12:13:10Z`. Остальные сервисы
(backend, pg, redis, proxy) не пересоздавались; `down`/`prune` не выполнялись.

## 4. Проверки

| Что | Результат |
|---|---|
| `GET /gpu/installer?profile=audio%2Fqwen-tts&mode=existing&platform=linux` | **200**, 9 700 байт, `sha256 1a1ec05753bce1f33683a5e6e41776ea6b81cd139c37bdaf872cca049205a99b` |
| `ANIMASTOR_BOOTSTRAP_VERSION` | `1.2.0` |
| installer bundle version | `0.2.5` (до выкатки — `0.2.4`) |
| `ANIMASTOR_WORKER_BUNDLE_VERSION` | `2.2.1` |
| `GET /gpu/installer/sha256` | 200, `version 0.2.5`, `sha256 b94f7c5a502aa7eabb3bc862b6a473ee9640ead8361d160603ea2909a0371cb9`, 249 527 байт |
| `GET /gpu/installer/bundle` | 200, 249 527 байт, sha256 совпал с `/installer/sha256`; внутри пакета `version 0.2.5` и `2.2.1` |
| Логи `gpu-hub` после старта | только `[ARTIFACTS] … (baked-in)` и `🚀 GPU HUB running on 5000`; строк с `error`/`exception`/`fatal` — 0 |
| diff bootstrap до/после | одна строка: `# installer bundle version: 0.2.4` → `0.2.5` |

Бэкап прежнего bootstrap: `backups/hub-installer-pre-v027.sh` (9 700 байт,
`sha256 3424c22e91620aa53d27d0cddf35452c614da6b035fc60a3832dfb947c48a7b7`).

## 5. Откат

Вернуть пин `gpu-hub` в `animastor-deploy` на
`sha256:5c95bb0e0f719566882af3cfc49aa493d3a16c39fa65679e845fa1fe6dcfef57` коммитом,
затем в `prod`: `git pull --ff-only` + `docker compose -p animastor --env-file .env up -d gpu-hub`.
Bootstrap отдаётся из образа, поэтому откат образа возвращает и installer 0.2.4.

## 6. Не сделано

- `prune`, `compose down`, `--force-recreate` — не выполнялись (запрещены правилами).
- Живой прогон установщика на ноде с этим bootstrap — не выполнялся (вне задания).
- Workflow `gpu-hub-ghcr-release` не запускался: `gh` не авторизован; образ собран владельцем.
