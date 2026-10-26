# Stage 143a — fix + Phase 2a. Отчёт о реализации

**Ветка:** `stage143a-foundation-phase1` (вся работа — в ней)
**Коммит A (fix):** `56221f3a5dd68edc94e3104bd9dc566d9314227e`
**Коммит B (Phase 2a):** `67c220a9a9977309bb91f1bd7fbc2fe41bcd2163`
**Push:** `git push github stage143a-foundation-phase1` → `fef58927..67c220a9` (на GitHub теперь есть и `f4afa761`, и оба новых коммита); проверено `git ls-remote github` → `67c220a9…refs/heads/stage143a-foundation-phase1`.

**Запрещённого не сделано:** флаг `IU_IMAGE_VERSIONED` **OFF** везде, `main` не тронут, merge нет, deploy нет, production-миграций нет, dirty/untracked файлы рабочей копии (`backend/scripts/audit-orphan-books.js`, `backend/src/routes/book/generation-routes.cjs`, 6 тест-файлов, `packages/.../dispatch-engine.js`, `deploy/`, `freebuff-chat-*.md`, `stage143a-phase2-consumer-audit.md`) **не изменены и не включены в коммиты**.

---

## 1. Часть A — исправление Phase 1 (коммит `56221f3a`)

### Файлы (4)
| Файл | Изменение |
|---|---|
| `backend/src/services/task-handler.cjs` | A1: новый порядок публикации + хелперы `sha256Hex`, `verifyVersionedBytes`, `fsyncDir` |
| `backend/src/helpers/queue-idempotency.cjs` | `version_conflict` добавлен в `FENCE_COMMIT_REJECTED` (терминальный reject) |
| `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js` | A2: операторское правило B7 у флага + точный SQL (без изменения кода) |
| `backend/tests/stage143a-publish-atomicity.test.js` (NEW) | A3: 7 тестов |

### A1 — атомарная и проверяемая публикация
`publishVersionedIuImage` (stage 4 цепочки) теперь:

1. temp-файл: `fs.openSync(path,'w')` → `fs.writeFileSync(fd, buffer)` → **`fsyncSync(fd)`** → `close`;
2. финальный путь: **`fs.linkSync(temp, final)`** (атомарно, без перезаписи; переживает fsync каталога — `fsyncDir(dirname(final))`);
3. при `EEXIST` — **сравнение размера И SHA-256** существующего файла с байтами callback:
   - совпало → идемпотентный повтор (`log`), публикуем;
   - не совпало → отказ **`version_conflict`**: указатель не двигается, существующий файл не удаляется и не перезаписывается;
4. непосредственно перед pointer UPDATE — повторная проверка финального файла (`size + SHA-256`); расхождение → `publish_failed`;
5. temp-файл удаляется **всегда** (`finally`), включая ветки отказа; в `.versions/` immutable-файлы не удаляются никогда.

Почему это закрывает дефект: старый `copyFileSync(..., COPYFILE_EXCL)` мог оставить **обрезанный файл** на неизменяемом пути после падения процесса, а следующая доставка трактовала `EEXIST` как «свои байты» и переводила на него указатель. `link(2)` публикует только полностью записанный inode.

`version_conflict` в `FENCE_COMMIT_REJECTED` → роут отвечает `{ok:true, rejected:true, reason:'version_conflict'}` и **не сбрасывает dedup-маркер** (повтор той же доставки заведомо не может преуспеть — шторма ретраев нет).

### A2 — правило B7 и откат флага
Код: при флаге ON `iu_image` всегда идёт в versioned-ветку (`versionedIuPublication = asset.type === 'iu_image' && iuImageVersionedEnabled()`), легаси-писатель для `iu_image` недостижим; при флаге OFF репозиторий отвечает `disabled` **до** любого запроса → указатель инертен (читатель отдаёт легаси). PG-вызовы в легаси-ветку при OFF не добавлялись.

Комментарий с правилом — в `iu-image-pointer-repo.js` (блок `OPERATOR RULE (contract B7 …)`). Операторское правило перед повторным включением флага после «легаси-окна»:

```sql
-- один билд одной книги
DELETE FROM iu_image_pointers           WHERE book_id = $1 AND build_id = $2;
-- все билды книги
DELETE FROM iu_image_pointers           WHERE book_id = $1;
-- опционально: резервирования того же объёма (старый hex-receipt после этого
-- падает fail-closed с reservation_missing — терминальный reject, ничего не публикуется)
DELETE FROM iu_image_fence_reservations WHERE book_id = $1 AND build_id = $2;
DELETE FROM iu_image_fence_reservations WHERE book_id = $1;
```
Запрещено: ручной `UPDATE` указателя и удаление immutable-файлов.

### A3 — тесты (`stage143a-publish-atomicity.test.js`, изолированный PG/Redis)
1. обрезанный файл на финальном пути + повторная доставка → `version_conflict`, файл не изменён, указатель не создан, temp удалён;
2. те же байты уже на пути → идемпотентный успех (inode не меняется), указатель опубликован, temp удалён;
3. первая публикация: link полного файла → проверка → указатель; temp удалён;
4. **сбой между записью файла и UPDATE указателя** (симуляция: `publishIuImagePointer` бросает): файл цел и совпадает с байтами, PG не тронут (`getIuImagePointer` → null), temp удалён → повтор того же callback сходится к успеху;
5. stale-fence (указатель уже впереди) → `stale_intent` после файловой стадии, temp удалён, победитель не тронут;
6. **A2: флаг OFF после публикации** → `resolveIuImagePath`/`resolveVersionedSceneProof` возвращают `null` с **0 PG-запросов**, `probeIUImage`/`resolveCanonicalSceneImage` отдают легаси-файл, строка в PG остаётся (инертность ≠ удаление);
7. source-контракт: `linkSync` + `fsyncSync` + `fsyncDir` + две проверки `verifyVersionedBytes`, `copyFileSync(COPYFILE_EXCL)` отсутствует.

---

## 2. Часть B — Phase 2a (коммит `67c220a9`), 8 файлов ≤ 12

| # | Файл | Изменение |
|---|---|---|
| 1 | `backend/src/image/registry.js` | **B0:** `resolveIuImagePath` → три вердикта: `null` (флаг OFF, прежний контракт), `{status:'ok',path,fence,relativePath}`, `{status:'absent'}` (нет строки → легаси разрешён), `{status:'missing',relativePath,reason}` (строка есть, файл отсутствует/небезопасен → легаси **запрещён**). PG-ошибка — throw. Новый метод `listPublishedIuIdsForScene` (flag OFF → `[]`, 0 PG) |
| 2 | `backend/src/image/image-service.js` | экспорт `listPublishedIuIdsForScene` во фасад |
| 3 | `packages/animastor-orchestration/src/runtime/scene-window.js` | **B1:** `getSceneFilesStatus` после пустого легаси-скана спрашивает `media.image.resolveVersionedSceneProof`; ошибка PG → `warn` + `image.exists=false` (не «есть», без throw) |
| 4 | `packages/animastor-orchestration/src/runtime/reconciliation-engine.js` | **B2:** `checkOrphanImageState` — versioned-fallback после пустого скана; `checkOrphanAssets` — `missing_image_file` не выпускается при живом указателе; ошибка PG → throw `pass_incomplete` (проход не выполнен, лог, регенерации нет) |
| 5 | `packages/animastor-orchestration/src/orchestration/scene-callbacks.js` | **B3/N1:** юнит dirty-списка подтверждается своим указателем (`resolveIuImagePath.status==='ok'`), иначе остаётся pending; ошибка PG → остаётся pending + `warn`. **B3/N2:** счётчик `iu-progress` = канонические имена ∪ `listPublishedIuIdsForScene` |
| 6 | `packages/animastor-player/src/iu-media.cjs` | **B0-роут** `/iu-image`: ok → 200+ETag; absent → легаси как раньше; missing → **404 + лог**; ошибка PG → **503 + лог**. **N3:** auto-redispatch только если нет ни легаси-скана, ни живого указателя; ошибка PG → состояние не трогаем (не «молча регенерируем»). **N4:** `image_ready` учитывает указатель; при ошибке PG — не READY |
| 7 | `backend/tests/reconciliation-engine.test.js` | +`resolveVersionedSceneProof` в image-стабе (по умолчанию `null` = флаг OFF), +9 тестов B2 |
| 8 | `backend/tests/stage143a-phase2a-consumers.test.js` (NEW) | 28 тестов: B0 (фасад + роут 200/404/503/flag-OFF), B1 (4 состояния + 0 PG), B3 (N1 очистка dirty_unit_ids для versioned-only сцены, N2 счётчик, отсутствие указателя, ошибка PG, флаг OFF), B4 (N3/N4 + outage + флаг OFF) |

**Общий паттерн соблюдён:** сначала легаси (поведение при OFF байт-в-байт прежнее, 0 PG), затем — только при пустом легаси — фасад с `typeof`-guard; ошибка PG никогда не читается как «файл есть» и как «нет публикации — регенерируем молча». PG-доступ только через фасад/репозиторий (sql-boundary, PG-1..5 не нарушены), allowlist require в player не расширен, immutable-файлы и правила публикации/fencing не менялись, scene-level image/audio/video не тронуты.

**Не трогалось (2b/2c, по заданию):** `generation-routes.cjs` (cover-скан N5), `redis-helpers.cjs`, `preview.js`, `export-routes.cjs`, `playback-queue.cjs`, `scene-data.cjs`, `iu-processor.js`.

---

## 3. Команды и результаты тестов

Окружение (изолированное, production не трогается):
```bash
cd backend
export PG_HOST=127.0.0.1 PG_PORT=55432 PG_DB=stage143a PG_USER=postgres
export PG_PASSWORD=$(docker inspect stage143a-pg --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^POSTGRES_PASSWORD=//p')
export REDIS_HOST=127.0.0.1 REDIS_PORT=56379
```

| # | Команда | Результат |
|---|---|---|
| 1 | `npx mocha --exit tests/stage143a-pointer-publication.test.js tests/stage143a-fence-reservation.test.js tests/stage143a-flag-off.test.js tests/stage143a-publish-atomicity.test.js tests/stage143a-phase2a-consumers.test.js` | **60 passing, 0 failing** (25 Phase 1 + 7 A3 + 28 Phase 2a) |
| 2 | `npx mocha --exit tests/happy-path.test.js tests/image-ghost-no-jobs-sent.test.js tests/image-orphan-generating-repair.test.js` | **127 passing, 0 failing** |
| 3 | `npx mocha --exit tests/reconciliation-engine.test.js` | **92 passing, 0 failing** |
| 4 | `npx mocha --exit ../packages/animastor-orchestration/test/artifact-root-binding.test.js` | **6 passing, 0 failing** |
| 5 | `npx mocha --exit tests/stage141-ready-chain-idempotency.test.js tests/gpu-fenced-publication-gates.test.js tests/gpu-result-fencing-commit.test.js tests/gpu-publication-consistency.test.js` | **67 passing, 0 failing** |
| 6 | `npx mocha --exit "tests/**/*.test.js"` (полный backend suite) | **3560 passing, 28 pending, 0 failing** (2m) |
| 7 | `npm run test:arch` (sql-boundary, PG-1..5, player-route-split и др.) | **935 passing, 24 pending, 0 failing** |
| 8 | `npm test` (pretest `bash ../scripts/syntax-smoke.sh` + mocha) | syntax smoke OK; **935 passing, 24 pending, 0 failing** |

Замечания к командам:
- `npm test` раскрывает `tests/**/*.test.js` шеллом (без globstar) в `tests/*/*.test.js` → фактически прогоняет только architecture-набор. **Полный suite** запускается так: `npx mocha --exit "tests/**/*.test.js"` (glob передан mocha в кавычках) — именно так получен 3560.
- Прогонялось трижды: (а) целевые suite до полного, (б) полный suite — дал 6 падений **только в новом тест-файле**, (в) полный suite после фикса — 0 падений.
- Причина тех 6 падений и фикс: `reconciliation-engine.test.js` в `mockDeps` подменяет `require.cache` для `backend/src/image/index.js` минимальным стабом и не восстанавливает его, поэтому в общем процессе бинд `media.image` переставал видеть мои патчи фасада (`image.getImageMetadata is not a function`). В новом тесте реальный entry пинается на время теста и возвращается обратно (`pinRealImageIndex`/`unpinImageIndex`). Продакшн-код из-за этого не менялся.

---

## 4. Остаточные риски / что осталось

1. **Флаг всё ещё нельзя включать:** покрыта только 2a. Остаются 2b/2c — `preview.js` (превью 404 при versioned-only), `export-routes.cjs` `/storyboard` (пустой zip; нужен новый reader `listBuildPointerPaths` — его в Phase 2a не было), `redis-helpers.cjs` recovery, cover-скан в `generation-routes.cjs` (dirty-файл, по условию не трогали), `playback-queue.cjs`, `scene-data.cjs`, `iu-processor.js` (oldPng).
2. **Публикация пакетов:** бэкенд резолвит `@animastor/*` из **npm-копий** в `backend/node_modules` (Dockerfile делает `npm install`; монорепо-пакеты в образ не монтируются). Правки `packages/**` (часть B) до `npm publish` + переустановки в проде **не действуют**. Для прогонов тестов локально я синхронизировал изменённые файлы в `backend/node_modules/@animastor/{orchestration,player}` (это gitignored, в коммиты не попало); в репо уже есть тест, требующий байтового совпадения этих копий (`reconciliation-engine.test.js` → «sync backend/node_modules»).
3. **B7 требует ручного SQL** оператора перед повторным включением флага (см. §1 A2) — автоматики нет и не должно быть.
4. `listScenePointerPaths(limit=50)` — для сцен >50 IU «доказательство» достаточно, но для полного подсчёта/экспорта нужен build-level листинг с обработкой усечения.
5. Битый указатель при флаге ON даёт `/iu-image` **404** (без легаси-фолбэка) — это осознанный выбор по B0; если для старых книг это нежелательно, решается только операторским SQL из §1 A2.
6. Тест-изоляция: подмена `require.cache` в `reconciliation-engine.test.js` утекает в последующие тест-файлы — стоит починить отдельно (вне этого этапа).

---

**Статус:** PASS. Флаг OFF, merge/deploy не выполнялись. Push выполнен только в ветку `stage143a-foundation-phase1` репозитория `github`.
