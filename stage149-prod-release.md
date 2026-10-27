# Stage 149 — выпуск хотфикса D1/D2/A1 в прод

Дата: 2026-10-27. Оператор: агент. Разрешение владельца: сборка прод-образа и обновление
контейнера `animastor-backend`; всё остальное (прод-БД, Redis, данные, тома, другие
контейнеры, `deploy/.env` кроме строки `BACKEND_IMAGE`, push в `main`, merge, force-push,
npm publish, включение `IU_IMAGE_VERSIONED`) — запрещено и не выполнялось.

**Итог: ВЫПУЩЕНО. Откат не выполнялся.** Все контроли первых 5 минут (п. 5) зелёные.
Функциональная проверка: PATCH → 200, `/regenerate` → 200, диспатч ушёл один раз, циклов нет,
15-минутное наблюдение чистое — но **сцена не достигла READY**: в проде с конца августа
оффлайн все GPU-воркеры (`gpu-hub: gpus=0`), это инфраструктурное состояние, не следствие
выпуска (подробно §5.2).

---

## 1. Параметры выпуска

| Параметр | Значение |
|---|---|
| Ветка | `hotfix/d1-d2-a1` |
| Approve-коммит | `ded051f6bafbcb30327b476f6fc46262398bbce7` |
| Дерево, вошедшее в образ (`APPROVED_COMMIT`) | `674d225e08e16916e0b22989d44b5d5fe12646a3` |
| Тег образа | `deploy-674d225e` |
| **Digest образа** | `sha256:91fb721dd8b1f72c711e4d1a894e83f68ccee4452deba7db833519b263a2bf8e` |
| Label ревизии в образе/контейнере | `674d225e08e16916e0b22989d44b5d5fe12646a3` |
| Label версии | `deploy-674d225e` |
| `@animastor/orchestration` в контейнере | `0.1.7` |
| `IU_IMAGE_VERSIONED` | не задан (как до выпуска) |

## 2. Проверка перед началом (п. 1)

- **Integrity npm-пакета совпал** (совершено повторно по ходу работы):

```
$ npm view @animastor/orchestration@0.1.7 dist.integrity
sha512-6jh4TES62ldg5Wa8g6b5kWm0xrT80VyGS77bhm0UaexvJofPl76RkApsE2ItfO3zE2qmnUWTuaXqcA9DPi9wRQ==
$ git show 674d225e:backend/package-lock.json → integrity: sha512-6jh4TES62…DPi9wRQ==   (совпадает)
```

- Сняты и сохранены (в `/tmp/opencode/stage149/`, в git не добавлялись):
  `docker-ps-before.txt`, `inspect-backend-before.json`, копия `deploy/.env`
  → `deploy/.env.backup-stage149` (права 600, **в отчёт и в git не включается** — содержит секреты).
- **Базовая линия за 30 минут до деплоя** (срез 07:41:13Z):

```
=== baseline window: last 30m, captured 2026-10-27T07:41:13+00:00
VERSION-GATE: 0 / VERSION-GATE stale: 0 / cache_hit: 0
error (word): 0 / ERROR lines: 0 / ReferenceError: 0 / FATAL/Uncaught: 0
total lines: 3268
```

## 3. Approve-коммит (п. 2)

```
ded051f6bafbcb30327b476f6fc46262398bbce7 ci(backend): approve 674d225e backend tree for GHCR release (stage 149)
 .github/workflows/backend-ghcr-release.yml | 2 +-   (1 insertion, 1 deletion)

-  APPROVED_COMMIT: 74088d60d58bb7dec587effa6e85d2400f572f2c
+  APPROVED_COMMIT: 674d225e08e16916e0b22989d44b5d5fe12646a3
```

Ровно одна строка изменена. Push обычный (без force) в `hotfix/d1-d2-a1`:
GitHub → `ded051f6`, локальный mirror `origin` → `ded051f6` (добит позже в этом же этапе).
Dirty-файлы не трогались, `git add` только по имени.

## 4. Сборка образа (п. 3)

Запуск `backend-ghcr-release` (workflow_dispatch) ветки `hotfix/d1-d2-a1`:

| Поле | Значение |
|---|---|
| run id | `40469061619` |
| Статус | `completed` / **`success`**, attempt 1 |
| Время | 2026-10-27T07:45:40Z → 07:47:11Z |
| head | `hotfix/d1-d2-a1` @ `ded051f6` |
| Триггер | `workflow_dispatch`, actor `animastor-main` |

Шаги job «build + isolated smoke + push to GHCR» — все `success`:
`Verify source commit (fail-closed)` → `Build image (context ./backend, no build args, no secrets)`
→ `Isolated smoke (ephemeral redis, no production PG/Redis)` → `Push immutable tags`
→ `Record digest`.

Тег `deploy-674d225e` → index digest `sha256:91fb721dd8b1…` (проверено
`docker buildx imagetools inspect`), т.е. тег и digest в `.env` указывают на один и тот же образ.
Ревизия в лейбле образа = `674d225e…` — в образ вошло именно approved-дерево.

## 5. Деплой (п. 4)

### 5.1 Diff `deploy/.env` с резервной копией — ровно одна строка

```
39c31? (нумерация строк файла — 39 в обоих)
< BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd
---
> BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:91fb721dd8b1f72c711e4d1a894e83f68ccee4452deba7db833519b263a2bf8e
```

`diff` по непустым строкам backup↔текущий даёт единственную пару — строка 39 `BACKEND_IMAGE`.

### 5.2 Пересоздание контейнера

```
$ docker pull ghcr.io/animastor/animastor-backend@sha256:91fb721d…
Digest: sha256:91fb721dd8b1f72c711e4d1a894e83f68ccee4452deba7db833519b263a2bf8e
Status: Downloaded newer image   (08:03Z, pull_rc=0)

$ cd /home/animastor/animastor-backend/deploy && \
  docker compose --project-name animastor --env-file .env \
    -f docker-compose.yml -f overlay-backend-standalone.yml up -d     (08:04:32Z)
```

Пересоздан **только `animastor-backend`** (created `2026-10-27T08:04:32.918Z`,
started `08:04:34.632Z`, Id `c8aa28643c22…`); остальные контейнеры с прежним аптаймом:
`animastor-pg`/`animastor-redis` Up 2 months, `gpu-hub` Up 2 weeks, `animastor-proxy` Up 8 days.

Состояние прода **до/после**:

| | до | после |
|---|---|---|
| image | `sha256:f6aefe57045a…` | `sha256:91fb721dd8b1…` |
| label revision | `78e8f1ae4bb581f52b736bc64e5ae603dedab839` | `674d225e08e16916e0b22989d44b5d5fe12646a3` |
| label version | `deploy-78e8f1a` | `deploy-674d225e` |
| контейнер | `c90b5d126fe3`, created 2026-10-21T13:15:37Z | `c8aa28643c22`, created 2026-10-27T08:04:32Z |
| orchestration | 0.1.4 (линия 78e8f1ae) | **0.1.7** |

## 6. Проверки после деплоя (п. 5, первые 5+ минут)

| Контроль | Результат |
|---|---|
| `npm ls @animastor/orchestration` в контейнере | `-- @animastor/orchestration@0.1.7` ✅ |
| label ревизии | `674d225e08e16916e0b22989d44b5d5fe12646a3` ✅ |
| `/health` | **200** — `{"status":"ok","loop":true,"redis":"PONG","ts":1793091765419}` ✅ |
| `/api/v1/debug/runtime/status` | **200** — `{"stats":{…},"runtime":{"active_image":2,…},"active_scenes":2}` (D2) ✅ |
| ReferenceError / crash-loop / FATAL | **0** за весь период после рестарта ✅ |
| HTTP 5xx в логах | **0** ✅ |
| `[VERSION-GATE] … stale` | **0** (всего с рестарта) ✅ |
| `cache_hit` | **0** (всего с рестарта) ✅ |
| `IU_IMAGE_VERSIONED` | не задан ✅ |
| посторонние контейнеры | не пересоздавались ✅ |

**Откат не понадобился** — ни одно из условий отката не нарушено.

## 7. Функциональная проверка (п. 5, книга `ba_1788172242081`)

Книга: «За пределами алгоритмов» (`ba_1788172242081`), workspace `3317e019-…`
(«sureg's Workspace», владелец — пользователь `sureg`).

### 7.1 Авторизация

Анонимный `PATCH` вернул **403** `Access denied: not a member of the book's workspace`
(записи под `/api/v1` автоматически создают гостя с чужим workspace). По согласованию
с владельцем залогинились через `POST /api/v1/auth/login` (создана штатная строка сессии
в `sessions` — как при обычном входе в браузере):

```
HTTP 200 {"authenticated":true,"user":{…"username":"sureg"…},
          "workspace":{"id":"3317e019-…","name":"sureg's Workspace","type":"personal"}}
```

### 7.2 Шаги

| # | Шаг | Результат |
|---|---|---|
| 1 | `PATCH /api/v1/book/ba_1788172242081/scene/ch-66e6f9a6/sc-1c3d246a {"unit_id":"iu-bafebc8c","fields":{"text":…"(проверка Stage 149)"}}` (09:33:58Z) | **HTTP 200** `{"saved":true,…,"dirty_scenes":1}` |
| 2 | `POST …/regenerate {"chapter_id":"ch-66e6f9a6","scene_id":"sc-1c3d246a","worker_types":["image"]}` (09:34:22Z) | **HTTP 200** (D1: в Stage 145 здесь был 500 `artifactNaming is not defined`) — `dirty_scenes`: cover + целевая сцена, `marked:2`, task `generation-image-1793093662620-58a6a42d` |
| 3 | Логи диспатча | `IMAGE_DISPATCHED … (1 IU job(s) sent)` ×2, `[DIRTY-UNIT-REGEN] Force-regenerating …_iu-bafebc8c`, `GPU Task sent … dispatch-17930936674…`, `ASSET STATE … image: -> generating` |
| 4 | Повторные диспатчи | `ATTEMPT_DISPATCH` целевой сцены — **ровно 1**, `IMAGE_DISPATCHED` — **ровно 1** → зацикливания нет ✅ |
| 5 | 15 мин наблюдения (09:58:20Z → 10:13:25Z, 16 срезов/60s) | в **каждом** срезе `vg_total=0 vg_delta=0 ch_total=0 ch_delta=0 ref_total=0 err_total=0`; итог с рестарта: `VERSION-GATE`=0, `cache_hit`=0, ReferenceError/FATAL=0, 5xx=0 ✅ |
| 6 | `GET /api/v1/debug/runtime/status` | **200** (D2) ✅ |
| 7 | **Сцена → READY** | **НЕ ДОСТИГНУТО** ⚠️ — см. §7.3 |

Выдержка наблюдения:

```
2026-10-27T09:58:20+00:00 vg_total=0 vg_delta=0 ch_total=0 ch_delta=0 ref_total=0 err_total=0 err_delta=0 scene_image=generating
2026-10-27T10:13:25+00:00 (finish)   # все 15 срезов — нули, scene_image=generating
```

### 7.3 Отклонение: READY не достигнут — GPU-воркеры в проде оффлайн (не следствие выпуска)

Сцена висит в `generating`, потому что задача не обрабатывается воркером:

```
$ wget http://gpu-hub:5000/health
{"gpus":0,"queues":{"image":8,"audio":0,"video":0},
 "workspace_queues":{"…queue:image:ws:3317e019-…":478},"running":0}

$ SELECT name, worker_type, status, last_seen FROM workers ORDER BY last_seen DESC;
vps-audio         audio  offline  2026-08-31
docker-e2e-audio  audio  offline  2026-08-31
e2e-ltx-2_3       video  offline  2026-08-28
e2e-qwen-image    image  offline  2026-08-26
e2e-audio         audio  offline  2026-08-26
parity-test-gpu   image  offline  —
```

Факты, показывающие, что это состояние **до** выпуска и не связано с ним:

- последняя строка `scene_assets` со статусом `ready` для image — **2026-08-26**;
  остальные 409 image-строк — `stale` от 2026-08-28;
- контейнеров-воркеров на хосте нет (`docker ps -a` — только `gpu-hub`, Up 2 weeks);
- параллельная книга `import_1786345731767_1786345734345`, чьи 19 image-задач ушли в хаб
  сразу после рестарта в 08:04Z, тоже осталась `pending` — те же 0 обработанных результатов;
- очередь в хабе (`image`=8, ws-очередь=478) копится независимо от backend-образа.

Т.е. backend корректно принял PATCH, пометил сцену, задиспатчил и держит lease —
всё, что зависит от выпускаемого кода, работает; не хватает внешних GPU-воркеров.
Условия отката («регенерация не стартует», «сцена зацикливается») **не выполнены**:
регенерация стартовала, диспатч один, повторов и `cache_hit` нет, — поэтому откат
не делался. Запуск воркеров в рамках Stage 149 запрещён («всё остальное запрещено») —
вопрос владельцу.

## 8. Что не менялось

Прод-БД и Redis — только чтение (плюс штатная строка сессии при логине, см. §7.1);
томы и данные книг — не трогались (кроме разрешённой правки текста одного юнита в
тестовой книге); `animastor-pg`, `animastor-redis`, `gpu-hub`, `animastor-proxy` — не
пересоздавались; `deploy/.env` — изменена только строка `BACKEND_IMAGE`; push в `main`,
merge, force-push, npm publish, включение `IU_IMAGE_VERSIONED` — не выполнялись.

## 9. Откат (п. 5, на случай если понадобится)

```sh
# deploy/.env:
#   BACKEND_IMAGE=ghcr.io/animastor/animastor-backend@sha256:f6aefe57045aaaa8759ef507a11c80cfdd7dfa40e812bc0d9a635453e2512bfd
cd /home/animastor/animastor-backend/deploy
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d
```

(в этом прогоне **не выполнялся**).
