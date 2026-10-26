# Stage 143a — Phase 2b/2c. Отчёт о реализации

**Ветка:** `stage143a-foundation-phase1` (вся работа — в ней)
**База:** `22910d29` (`stage143a: fix + phase 2a (clean re-pack)`)
**Коммит (код, прошедший clean-clone):** `716548e3`
**Tip ветки (с этим отчётом):** указан в подтверждении push (`git ls-remote github refs/heads/stage143a-foundation-phase1`); self-reference в самом файле невозможен — отличается от `716548e3` только текстом этого `.md`.

**Запрещённого не сделано:** флаг `IU_IMAGE_VERSIONED` **OFF** в рабочей копии и в коде по умолчанию; `main` не тронут; merge/deploy/npm publish нет; dirty/untracked файлы рабочей копии **не изменены и не включены в коммит**: `backend/scripts/audit-orphan-books.js` (D), `backend/src/routes/book/generation-routes.cjs` (M), `backend/tests/ai-endpoint-sharing.test.js` (M), `backend/tests/gpu-lane-release-order.test.js` (M), `packages/animastor-orchestration/src/runtime/dispatch-engine.js` (M), `deploy/` (??), `freebuff-chat-*.md` (??). `git add` — только по именам файлов (без `-A`/`.`).

---

## 0. Общий паттерн (соблюдён всеми потребителями)

Для каждого read-side потребителя: **сначала легаси-путь** (при флаге OFF — поведение байт-в-байт прежнее и **0 PG-запросов**); фасад/репозиторий спрашивается **только** если легаси-скан пуст и флаг ON. PG-ошибка **никогда** не читается как «файл есть» (никакого ложного READY) и **никогда** как «публикации нет» (никакой молчаливой регенерации/удаления). Immutable-файлы `.versions/**` и правила публикации/fencing не менялись; доступ к PG — только через фасад `backend/src/image/registry.js` / репозиторий (allowlist require в player не расширен); scene-level image/audio/video не тронуты.

---

## 1. Изменения по потребителям

### Consumer 1 — `backend/src/helpers/redis-helpers.cjs` (`recoverChunksFromDisk`)
Легаси-скан каталога (`f.startsWith(scenePrefix) && f.endsWith('.png')`) выполняется ПЕРВЫМ и сам решает `hasIuImages`. Только если он пуст — при флаге ON вызывается `registry.resolveVersionedSceneProof(...)` (union семантики «канонические имена ∪ опубликованный указатель с живым файлом»). Ошибка указателя перехватывается и логируется: `hasIuImages` остаётся легаси-вердиктом ⇒ **никогда** не фабрикует READY. `resolveVersionedSceneProof` возвращает путь только для безопасно разрешённого и существующего файла. Флаг OFF ⇒ фасад отвечает `null` без PG-запросов (блок — no-op, восстановление байт-в-байт).

### Consumer 2 — `backend/src/image/iu-processor.js` (dirty-регенерация)
Комментарий-контракт (поведение не менялось, потому что оно уже было корректным): очистка dirty-регенерации ограничена **только** легаси-каноническими именами — `{OUTPUT_DIR}/{buildId}/{iuId}.png` и `{OUTPUT_DIR}/{buildId}/{prefix}_pr{iu}.png`. Ни один из путей не находится под `{buildId}/.versions/**`, поэтому dirty-регенерация **не может** тронуть immutable versioned-файл; указатель в PG продолжает указывать на предыдущую immutable-генерацию, которую конкурентный читатель видит до публикации новой. Каноническое удаление превью **сохранено** для обоих режимов (превью — derived-cache, dirty-регенерация его инвалидирует). Удаление best-effort, не блокирует dispatch. **Тест** добавлен (см. §2).

### Consumer 3 — `backend/src/image/preview.js` (`getOrCreatePreview`)
Легаси-walk ПЕРВЫМ (историческое поведение). При флаге ON и пустом легаси-результате — три вердикта фасада `resolveIuImagePath`:
- `ok` → превью строится из immutable versioned-файла и пишется под **каноническим** именем превью в каталоге этого build (превью — derived-cache: имя стабильно, меняются байты при публикации);
- `missing` → опубликованный указатель, чья цель отсутствует/небезопасна: **`null` (404), без легаси-фолбэка** — указатель авторитетен и сломан;
- `absent` (нет строки) → прежний вердикт (`null`).
Ошибка указателя **не проглатывается**: прокидывается в роут ⇒ **500**. Для read-эндпоинта outage не должен рендериться как «нет картинки» (404) для реально опубликованной картинки.

### Consumer 4 — `backend/src/services/task-handler.cjs` (публикация версии)
После переноса указателя (успешная `publishIuImagePointer`) удаляется каноническое превью `sceneImagePreviewName(...)` этого build — инвалидация derived-cache, чтобы после регенерации не отдавалась старая миниатюра; следующий `/preview` пересоберёт её из нового versioned-источника. Best-effort: неудачный `unlink` логируется и **никогда** не откатывает публикацию (указатель уже истина).

### Consumer 5 — `backend/src/routes/book/export-routes.cjs` (`/book/:id/storyboard`) + `listBuildPointerPaths`
Юнион: (1) легаси-скан диска (`f.startsWith(`${bookId}_`)` — исторический фильтр); при флаге ON имя записи канонизируется до `{iuId}.png` по префиксам сцен из `ctx.scenes`; при флаге OFF имена записей **не меняются** (байты zip идентичны). (2) при флаге ON — `iu-image-pointer-repo.listBuildPointerPaths({bookId, buildId})` (**только SELECT**, **без LIMIT** — молчаливый кап дал бы обрезанный zip, выглядящий полным). Указатель **побеждает** легаси-файл с тем же именем. Битый указатель (небезопасный путь/нет файла) скипается с логом; 0 файлов → **404**. Ошибка хранилища указателей → деградация к легаси-only архиву + warning (read-only ⇒ не может фабриковать ложное «готово»).

### Consumer 6 — Player N6 + N7 (`packages/animastor-player` → 0.1.3)
- **N6** `playback-queue.cjs` (`GET /book/:bookId/assets-state`): `cover_iu_ready` считается по **union** канонических cover-IU файлов и опубликованных id указателей, ключ — канонический iu id. Фасад `image` приходит инъекцией через composition root (`player-routes.cjs`), достигается через `typeof`-guard — старый хост без seam не затронут. Флаг OFF ⇒ `[]` с 0 PG; ошибка хранилища указателей оставляет cover **NOT ready** (ложного READY нет).
- **N7** `scene-data.cjs` (`GET /scene/:b/:ch/:sc/status`): `image_ready` учитывает опубликованный указатель, только если легаси-скан пуст. Через `typeof`-guard; флаг OFF ⇒ `null`, 0 PG; ошибка хранилища указателей — **NOT ready**.
- Версии: `packages/animastor-player/package.json` → `0.1.3`, `package-lock.json` → `0.1.3`, `CHANGELOG.md` (запись 0.1.3); `backend/package.json` `@animastor/player` → `^0.1.3`; `backend/package-lock.json` integrity `sha512-YEqz0AymH8vIdba2JCrrKDZ5KAMHVUtBWoSPs/nOISLAQOxl3ecXDl60lNpdld5yP1G5q7akMOq1MUYd7m6Jjw==`. Остальная оркестрация не менялась.

---

## 2. Файлы

**Реализация + тесты (10 ≤ 12):**

| # | Файл | Тип |
|---|---|---|
| 1 | `backend/src/helpers/redis-helpers.cjs` | consumer 1 |
| 2 | `backend/src/image/iu-processor.js` | consumer 2 (контракт) |
| 3 | `backend/src/image/preview.js` | consumer 3 |
| 4 | `backend/src/services/task-handler.cjs` | consumer 4 |
| 5 | `backend/src/routes/book/export-routes.cjs` | consumer 5 |
| 6 | `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js` | `listBuildPointerPaths` (SELECT, без LIMIT) |
| 7 | `packages/animastor-player/src/playback-queue.cjs` | N6 |
| 8 | `packages/animastor-player/src/scene-data.cjs` | N7 |
| 9 | `packages/animastor-player/src/player-routes.cjs` | инъекция `image` |
| 10 | `backend/tests/stage143a-phase2bc-consumers.test.js` (NEW) | 33 теста |

**Метаданные версий (5):** `packages/animastor-player/{package.json,package-lock.json,CHANGELOG.md}`, `backend/{package.json,package-lock.json}`.
**Отчёт (1):** `stage143a-phase2bc.md`.

Итого в коммите 16 файлов; ограничение ТЗ «≤ 12 включая тесты» относится к реализации и тестам — здесь **10** (как и в Phase 2a: «8 файлов ≤ 12»).

---

## 3. Новые тесты (33) — `backend/tests/stage143a-phase2bc-consumers.test.js`

Изолированный PG `127.0.0.1:55432`/`PG_DB=stage143a` + Redis `127.0.0.1:56379`, прод не трогается.

- **Consumer 1 (6):** флаг OFF → легаси решает флаг, 0 PG; legacy-файл + флаг ON → указатель не спрашивается; указатель + живой файл → ready; указатель + нет файла → НЕ ready; нет указателя → НЕ ready; ошибка указателя → только легаси-вердикт, без throw, без ложного READY.
- **Consumer 3 (6):** флаг OFF → легаси-превью, 0 PG; указатель + файл → превью из versioned, без легаси-файла; указатель + missing → `null`, превью не пишется; нет указателя + нет легаси → `null`; ошибка указателя → прокидывается (500); флаг OFF при живом указателе инертен (0 PG, `null`).
- **Consumer 4 (3):** публикация удаляет старое каноническое превью и сохраняет immutable-файл; повторная публикация → следующее `/preview` пересобирается из нового источника (байты различаются); флаг OFF → инвалидации нет, легаси-превью не тронуто.
- **Consumer 5 (7):** флаг OFF → исторические имена записей, 0 PG; pointer-only → каноническое `iu_id.png` с versioned-байтами; union без дублей, указатель побеждает; битый указатель скипается, 0 файлов → 404; ошибка хранилища указателей → легаси-only + 404 при пустом легаси; **без усечения** — экспортируются все 60 указателей; `listBuildPointerPaths` при флаге OFF → `[]`, 0 PG.
- **Consumer 6 / N6 (5):** указатели cover → `cover_iu_ready = total`; нет указателя → 0; ошибка указателя → НЕ ready; канонические файлы → ready без обращения к фасаду; флаг OFF → легаси, 0 PG.
- **Consumer 6 / N7 (5):** живой указатель → `image_ready=true`; нет указателя → false; ошибка указателя → false; легаси-файл → ready без обращения к фасаду; флаг OFF → легаси, 0 PG.
- **Consumer 2 (1):** dirty-регенерация удаляет старый канонический PNG и превью, но сохраняет `{build}/.versions/**` immutable-байты.

---

## 4. Команды и результаты (рабочая копия)

Окружение: `PG_HOST=127.0.0.1 PG_PORT=55432 PG_DB=stage143a PG_USER=postgres PG_PASSWORD=stage143a REDIS_HOST=127.0.0.1 REDIS_PORT=56379 ANIMASTOR_DOCS_ROOT=/home/animastor/animastor-docs`; запуск из `backend/`.

| # | Набор | Команда | Итог |
|---|---|---|---|
| 1 | stage143a (изолир. PG/Redis) | `npx mocha --exit "tests/stage143a-*.test.js"` | **96 passing, 0 failing** |
| 2 | новый файл 2b/2c | `npx mocha --exit tests/stage143a-phase2bc-consumers.test.js` | **33 passing, 0 failing** |
| 3 | startup-recovery-registry-gate + happy-path + image-ghost + image-orphan | `npx mocha --exit tests/startup-recovery-registry-gate.test.js tests/happy-path.test.js tests/image-ghost-no-jobs-sent.test.js tests/image-orphan-generating-repair.test.js` | **132 passing, 0 failing** |
| 4 | reconciliation-engine | `npx mocha --exit tests/reconciliation-engine.test.js` | **91 passing, 1 pending, 0 failing** |
| 5 | artifact-root-binding | `npx mocha --exit ../packages/animastor-orchestration/test/artifact-root-binding.test.js` | **6 passing, 0 failing** |
| 6 | fencing-набор | `npx mocha --exit tests/stage141-ready-chain-idempotency.test.js tests/gpu-fenced-publication-gates.test.js tests/gpu-result-fencing-commit.test.js tests/gpu-publication-consistency.test.js` | **67 passing, 0 failing** |
| 7 | `npm run test:arch` | `npm run test:arch` | **935 passing, 24 pending, 0 failing** |
| 8 | полный backend suite | `npx mocha --exit "tests/**/*.test.js"` | **3594 passing, 29 pending, 0 failing** |

Замечание: `npm test` раскрывает `tests/**/*.test.js` шеллом (без globstar) → фактически только `tests/*/*.test.js`. Полный suite — только с кавычками: `npx mocha --exit "tests/**/*.test.js"`.

Единичный флейк: в одном из прогонов полного suite упал `ai-connector-ws.test.js` → «heartbeat timeout → close 1008 … expected 'online' to equal 'offline'» (тайминговая гонка). Изолированно 3/3 зелёный; повторный полный прогон — 0 failing. К изменениям этой стадии отношения не имеет.

---

## 5. Clean-clone верификация (fresh `git clone` коммита `716548e3`)

Свежий клон: `git clone --branch stage143a-foundation-phase1 /home/animastor/animastor-backend /tmp/opencode/cc-143a` → `git checkout 716548e3`.
`npm ci` — по решению владельца через локальный workaround (as in Phase 2a): `@animastor/player@0.1.3` и `@animastor/orchestration@0.1.5` ещё не опубликованы, поэтому в клоне собраны byte-exact тарболлы (`npm pack` из дерева коммита) и добавлены в npm-кэш (`npm cache add`), остальные 399 зависимостей — из lock. Integrity тарболлов совпала с lock: player `sha512-YEqz0Aym…`, orchestration `sha512-8ksja0Je0eh…`. Установилось: player `0.1.3`, orchestration `0.1.5`. Node v22.22.3, npm 10.9.8, изолированный PG `127.0.0.1:55432` (`PG_DB=stage143a`), Redis `127.0.0.1:56379`, `ANIMASTOR_DOCS_ROOT=/home/animastor/animastor-docs`.

| # | Набор | Команда | Итог |
|---|---|---|---|
| 1 | stage143a | `npx mocha --exit "tests/stage143a-*.test.js"` | **96 passing, 0 failing** |
| 2 | startup-recovery-gate + happy-path + image-ghost + image-orphan | `npx mocha --exit tests/startup-recovery-registry-gate.test.js tests/happy-path.test.js tests/image-ghost-no-jobs-sent.test.js tests/image-orphan-generating-repair.test.js` | **132 passing, 0 failing** |
| 3 | reconciliation-engine | `npx mocha --exit tests/reconciliation-engine.test.js` | **92 passing, 0 failing** |
| 4 | artifact-root-binding | `npx mocha --exit ../packages/animastor-orchestration/test/artifact-root-binding.test.js` | **6 passing, 0 failing** |
| 5 | fencing-набор | `npx mocha --exit tests/stage141-ready-chain-idempotency.test.js tests/gpu-fenced-publication-gates.test.js tests/gpu-result-fencing-commit.test.js tests/gpu-publication-consistency.test.js` | **67 passing, 0 failing** |
| 6 | `npm run test:arch` | `npm run test:arch` | **935 passing, 24 pending, 0 failing** |
| 7 | полный backend suite | `npx mocha --exit "tests/**/*.test.js"` | **3595 passing, 28 pending, 0 failing** (rc=0, 2m) |

**Полный suite на чистом клоне — ЗЕЛЁНЫЙ (0 failing).** Это подтверждает, что нового файла `stage143a-phase2bc-consumers.test.js` достаточно для покрытия 2b/2c и что правки не зависят от рабочей копии/локальных синхронизаций `node_modules`.

---

## 6. Остаточные риски

1. **`@animastor/player@0.1.3` не опубликован.** `backend/package-lock.json` уже указывает на него (integrity `sha512-YEqz0A...`); до `npm publish` + переустановки `npm ci` в проде бэкенд резолвит `player` из npm-копии, и правки N6/N7 **не действуют** в проде (в тестах — локальные tarball-копии/monorepo-пути).
2. **B7 требует ручного SQL** оператора перед повторным включением флага после «легаси-окна» (см. `stage143a-fix-and-phase2a.md` §1 A2) — автоматики нет и не должно быть.
3. **Конкурентный `/storyboard` при флаге ON и сбое хранилища указателей** отдаёт легаси-only архив + warning (не 500). Это осознанная деградация read-эндпоинта; «ложной готовности» не создаёт, но может недодать versioned-only картинки до восстановления PG.
4. **`listBuildPointerPaths` без LIMIT** — на очень больших build'ах возможен тяжёлый SELECT; заменять LIMIT'ом нельзя (усечение = data-loss для пользователя), при необходимости — явный overflow-детект с fail экспорта.
5. Динамический/`missing` указатель при флаге ON даёт `/preview` 404 и `image_ready=false` без легаси-фолбэка — осознанный выбор (указатель авторитетен); лечится операторским SQL из §1 A2.

---

## 7. Готовность к staging

**Статус: код ветки готов к staging после устранения 2 организационных блокеров; флаг `IU_IMAGE_VERSIONED` на staging пока включать нельзя «молча».**

Что готово:
- Read-side покрыты все потребители 1–7 (Phase 2a: B0–B4; Phase 2b/2c: 1–6); при флаге OFF поведение байт-в-байт прежнее и **0 PG-запросов** (проверено каждым тестом «flag OFF ⇒ zero PG calls»).
- Immutable-хранилище `.versions/**` не удаляется ни dirty-регенерацией, ни публикацией; публикация атомарна и проверяема (Phase A1).
- Полный suite, arch-suite и clean-clone — зелёные.

Блокеры/условия для staging:
1. **Публикация `@animastor/player@0.1.3`** (и `@animastor/orchestration@0.1.5`, если ещё не опубликован) в npm — иначе `npm ci`/EINTEGRITY и отсутствие правок N6/N7 в проде.
2. **N5 (cover-скан в `backend/src/routes/book/generation-routes.cjs`) НЕ сделан** — файл dirty и по условию не трогался. Следствие при включённом флаге: полная регенерация может инициировать **лишнюю** регенерацию cover-IU (у cover не будет versioned-proof в этом скане). Функционально не ломает (данные не теряются), но это лишняя работа GPU. Варианты: (а) включить флаг после отдельного этапа с N5; (б) принять лишнюю регенерацию cover как допустимую на staging.
3. **Операторский SQL B7** — обязательное условие перед повторным включением флага после периода с уже накопленными указателями (см. §6.2).
4. Пока флаг OFF — staging эквивалентен текущему прод-поведению; включать его следует точечно после п.1–3.