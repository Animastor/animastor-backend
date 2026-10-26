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

---

## 5. Cleanup коммита (перепаковка `3637ec68`)

**Тип:** исправление ошибки процесса (не разработка и не аудит).

### Что случилось

При перепаковке в коммит `3637ec68` (был запушен в `github/stage143a-foundation-phase1`) попали файлы, которых там быть не должно:

- **untracked:** `deploy/README.md`, `deploy/docker-compose.yml`, `deploy/overlay-backend-standalone.yml`, `freebuff-chat-2026-10-11T07-41-12.445Z.md`;
- **чужие незавершённые изменения других сессий:** Stage 124/N1-B (`backend/src/routes/book/generation-routes.cjs` + `packages/animastor-orchestration/src/runtime/dispatch-engine.js` + `backend/tests/gpu-lane-release-order.test.js`), тест-фиксы `backend/tests/ai-endpoint-sharing.test.js`, `backend/tests/ai-shared-inference.test.js`, `backend/tests/architecture/installer-package-boundary.test.js`, `backend/tests/architecture/phase5-runtime-result.test.js`, а также удаление `backend/scripts/audit-orphan-books.js`;
- **тестовая правка в продакшн-коде:** `backend/src/storage/postgres/database.js` — БД по умолчанию стала `'stage143a'` вместо `'animastor'`.

Ветка была запушена на публичный GitHub — настоящий раздел фиксирует cleanup.

### Файлы нового коммита (23)

Первые 19 — строго разрешённый список стадии. Файлы 20–23 добавлены **по явному решению владельца** (см. «Отклонения» ниже): gate §3 требует зелёного suite, а его невозможно получить без этих четырёх тест-файлов (три — «красная база», один — исправление тест-изоляции).

| # | Файл | Содержание |
|---|---|---|
| 1 | `backend/src/services/task-handler.cjs` | fix 2: temp открывается с `wx` (O_EXCL) |
| 2 | `backend/src/storage/postgres/repositories/iu-image-pointer-repo.js` | fix 2: уникальное имя temp `{fence}.{pid}.{rand}.tmp` |
| 3 | `backend/src/services/result-publication.cjs` | fix 2: GC временных файлов (`VERSIONED_STAGING_TMP_RE` + цикл в `collectStaleStaging`) |
| 4 | `backend/tests/stage143a-publish-atomicity.test.js` | fix 2: тесты 8–10 (crash link→unlink, параллельные доставки, GC) |
| 5 | `backend/tests/stage143a-pointer-publication.test.js` | fix 2: уникальность имени temp |
| 6 | `backend/tests/stage143a-phase2a-consumers.test.js` | fix 3: канонические `packages/**`-источники |
| 7 | `backend/tests/reconciliation-engine.test.js` | fix 3: путь к каноническому источнику + skip при расхождении версий |
| 8 | `backend/tests/monorepo-source-bindings.cjs` (NEW) | fix 3: fallback bare-require → `backend/node_modules` |
| 9 | `backend/tests/generation-test-bindings.cjs` | fix 3: dual-wiring портов O-2..O-10 для монорепо-копии |
| 10 | `backend/.mocharc.json` | подключает `monorepo-source-bindings.cjs` |
| 11 | `backend/package.json` | bump `@animastor/orchestration@^0.1.5`, `@animastor/player@^0.1.2` |
| 12 | `backend/package-lock.json` | lock-версии + **перегенерированные integrity обоих пакетов** (см. ниже) |
| 13 | `packages/animastor-orchestration/package.json` | 0.1.4 → 0.1.5 |
| 14 | `packages/animastor-orchestration/package-lock.json` | lock-версия 0.1.5 |
| 15 | `packages/animastor-player/package.json` | 0.1.1 → 0.1.2 |
| 16 | `packages/animastor-player/package-lock.json` | lock-версия 0.1.2 |
| 17 | `packages/animastor-player/CHANGELOG.md` | запись 0.1.2 (phase 2a) |
| 18 | `stage143a-fix-and-phase2a.md` | этот отчёт |
| 19 | `stage143a-phase2-consumer-audit.md` | аудит потребителей Phase 2 |
| 20 | `backend/tests/ai-shared-inference.test.js` | **+** stale-тест: health-сигнал коннектора (LAC §9) — базовый `67c220a9` красный |
| 21 | `backend/tests/architecture/installer-package-boundary.test.js` | **+** stale-тест: installer уже публичный (`private` снят, `publishConfig.access=public`) |
| 22 | `backend/tests/architecture/phase5-runtime-result.test.js` | **+** stale-тест: баррель `backend/src/runtime/index.js` удалён (B-4) — инвариант проверяется при наличии |
| 23 | `backend/tests/scope-slide.test.js` | **+** исправление тест-изоляции: purge `runtime-scheduler.js` в `afterEach` (см. ниже) |

Все три stale-теста (20–22) — **только тесты**, продакшн-код ими не меняется: они догоняют изменения, уже присутствующие в базе `67c220a9` (публичный installer, удалённый runtime-баррель, контракт health-сигнала). Диффы каждого — в §5.1.

**Не включено (остаётся запрещённым):** `deploy/**`, `freebuff-chat-2026-10-11T07-41-12.445Z.md`; `backend/src/storage/postgres/database.js` (в дереве осталось `'animastor'`); `backend/scripts/audit-orphan-books.js` (восстановлен); `backend/src/routes/book/generation-routes.cjs`; `packages/animastor-orchestration/src/runtime/dispatch-engine.js`; `backend/tests/ai-endpoint-sharing.test.js`; `backend/tests/gpu-lane-release-order.test.js`.

Чужой Stage 124/N1-B (`generation-routes.cjs`, `dispatch-engine.js`, `gpu-lane-release-order.test.js`) и `ai-endpoint-sharing.test.js` в коммит **не входят** — базовые версии проходят, менять их незачем.

### 5.1 Дополнительные файлы 20–23: назначение и диффы

**20. `ai-shared-inference.test.js`** — тест `16b` ожидал `checkAIHealth()===0` для connector-снимка; контракт с `5b98fbf` (LAC §9): health = liveness коннектора из реестра (`isLive`, без HTTP). Дифф:
```diff
-        expect(n).to.equal(0); // connector snapshots carry no HTTP credential
+        expect(snap.transport).to.equal('connector');
+        expect(n).to.equal(registry.isLive(snap.connectorId) ? 1 : 0);
```

**21. `architecture/installer-package-boundary.test.js`** — `IB-G15` требовал `pkg.private===true`, но пакет опубликован (npm 0.1.x, `8f3a3d6`) и обязан оставаться публикуемым. Дифф:
```diff
-        expect(pkg.private, 'package stays private (no publish yet)').to.equal(true);
+        expect(pkg.private, 'installer is intentionally public (npm-published)').to.not.equal(true);
+        expect(pkg.publishConfig && pkg.publishConfig.access, 'publishConfig.access must stay public').to.equal('public');
```

**22. `architecture/phase5-runtime-result.test.js`** — `T9` читал `backend/src/runtime/index.js`, который удалён в `4c5699c` (B-4). Инвариант сохраняется, проверяясь только при наличии барреля. Дифф:
```diff
-        const indexSrc = readSource(path.join(BACKEND_SRC, 'runtime', 'index.js'));
-        const nonInternal = requireSpecifiers(indexSrc).filter((s) => !s.startsWith('./'));
-        expect(nonInternal, '...').to.deep.equal([]);
-        expect(indexSrc, '...').to.not.include('../orchestration');
+        const barrelPath = path.join(BACKEND_SRC, 'runtime', 'index.js');
+        if (fs.existsSync(barrelPath)) {
+            const indexSrc = readSource(barrelPath);
+            const nonInternal = requireSpecifiers(indexSrc).filter((s) => !s.startsWith('./'));
+            expect(nonInternal, '...').to.deep.equal([]);
+            expect(indexSrc, '...').to.not.include('../orchestration');
+        }
```

**23. `scope-slide.test.js`** — исправление хрупкой тест-изоляции (первопричина 7 падений `worklist-rebuild` Option E в полном suite; детальный разбор — §5.2). В трёх `afterEach()` добавлен purge `.../runtime-scheduler.js` рядом с уже присутствующим purge `active-scenes-index.js`, и оставлен комментарий у стаба. Продакшн-код не затронут.

### 5.2 Первопричина падений `worklist-rebuild` (7) — найдена инструментами

Ранее (§5 «Результат проверок» старой редакции) это описывалось как «кумулятивная хрупкость `require.cache`». Точная первопричина установлена трассировкой (`console.error` в `active-scenes-index.addActiveScene` и при загрузке `runtime-scheduler`):

1. `scope-slide.test.js` в `loadSceneWindowWithStubs()` кладёт в `require.cache` **стаб** `active-scenes-index.js`, у которого `addActiveScene` возвращает `{added:true}`, но **не пишет в redis**.
2. Затем он `require`-ит `scene-window.js`, который по цепочке загружает **настоящий** `runtime-scheduler.js`. У `runtime-scheduler` в module-scope есть `const activeScenes = require('./active-scenes-index')` — он захватывает стаб (и это уже не отменяется удалением `active-scenes-index` из кэша: захвачена ссылка, а не запись кэша).
3. Его `afterEach` удалял `active-scenes-index.js` и `scene-window.js`, но **не** `runtime-scheduler.js` — «отравленный» планировщик (реальный код + стаб `activeScenes`) оставался в `require.cache`.
4. `worklist-rebuild` (при сортировке последний) перепривязывает `runtime-scheduler` в `before()` — получает отравленную копию; `addActiveScene` уходит в никуда, `animastor:active-scenes` в его mock-redis пуст → ассерты `[]` вместо сцены. Изолированно `worklist` проходит, потому что его top-level `require` кэшировал настоящий `runtime-scheduler` ещё на загрузке файла, и его никто не вытеснял.

Исправление (файл 23) убирает отравление: после каждого `afterEach` планировщик перезагружается по-настоящему. Трассировка подтвердила: до фикса в полном suite был ровно один `runtime-scheduler` с `addActiveScene.isStub=true` (загружен из `scope-slide`), после фикса — ни одного.

### Чем заменён `3637ec68`

Коммит `3637ec68` заменён новым единственным коммитом поверх `67c220a9` — tip ветки `stage143a-foundation-phase1` (его hash приведён в подтверждении push: `git ls-remote github refs/heads/stage143a-foundation-phase1`). Литеральный hash не может быть записан в сам коммит (self-reference невозможен), поэтому он указывается в подтверждении push, а не в этом файле. Локальная резервная ветка `backup/stage143a-3637ec68` хранит старый коммит.

### Отклонения от буквального плана (решения владельца)

1. **Свежий клон + `npm ci`.** `@animastor/orchestration@0.1.5` и `@animastor/player@0.1.2` ещё не опубликованы (публикация разрешена только после cleanup), поэтому буквальный `npm ci` падает E404. По решению владельца применён локальный workaround: в клоне ставятся локальные (byte-exact) тарболлы этих двух пакетов через `npm cache add` (получены `npm pack` из самого клона), остальные 397 зависимостей — из lock. Это процедурный workaround; байты пакетов — ровно те, что описаны в lock.
2. **Integrity обоих пакетов в `backend/package-lock.json` перегенерированы под дерево коммита.** Исходная integrity `<player>` `sha512-QwGb…` соответствовала `player@0.1.2` **без** нового `CHANGELOG.md` (а `CHANGELOG.md` входит в `files` и добавляется этим же коммитом); упаковка дерева коммита даёт `sha512-6K8k…`. Исходная integrity `<orchestration>` `sha512-4uQU…` соответствовала `orchestration@0.1.5`, упакованному из **грязного** дерева — то есть с чужим правкой `dispatch-engine.js` (Stage 124/N1-B), которая в этот коммит не входит; чистое дерево коммита даёт `sha512-8ksja0…`. В lock записаны именно `6K8k…`/`8ksja0…` — иначе после публикации `npm ci` падал бы EINTEGRITY (registry отдал бы тарболлы, не совпадающие с lock).
3. **Выход за исходный allowlist (файлы 20–23).** Первый прогон §3.5 дал 10 падений: 3 «красная база» (лечатся только исключёнными тест-файлами) + 7 `worklist-rebuild` (тест-изоляция). По решению владельца («сначала починить suite») разрешено выйти за allowlist ради зелёного suite — включены 3 stale-теста (20–22; меняются только тесты, продакшн-код не трогается) и минимальный фикс изоляции `scope-slide.test.js` (23). Чужие изменения Stage 124/N1-B и `ai-endpoint-sharing.test.js` остаются исключёнными: их базовые версии проходят.

### Результат проверок

**Окружение прогонов:** свежий клон (`git clone` + checkout коммита) в чистую папку, `npm ci` по решению владельца выполнен через workaround (см. выше); изолированный PG `127.0.0.1:55432` (`PG_DB=stage143a`), Redis `127.0.0.1:56379`, `ANIMASTOR_DOCS_ROOT=/home/animastor/animastor-docs`, node v22.22.3, npm 10.9.8.

| # | Набор | Команда | Итог |
|---|---|---|---|
| 1 | stage143a (изолир. PG/Redis) | `npx mocha --exit tests/stage143a-*.test.js` | **63 passing, 0 failing** |
| 2 | happy-path + image-ghost + image-orphan | `npx mocha --exit tests/happy-path.test.js tests/image-ghost-no-jobs-sent.test.js tests/image-orphan-generating-repair.test.js` | **127 passing, 0 failing** |
| 3 | reconciliation-engine | `npx mocha --exit tests/reconciliation-engine.test.js` | **92 passing, 0 failing** |
| 4 | artifact-root-binding | `npx mocha --exit ../packages/animastor-orchestration/test/artifact-root-binding.test.js` | **6 passing, 0 failing** |
| 5 | fencing-набор | `npx mocha --exit tests/stage141-ready-chain-idempotency.test.js tests/gpu-fenced-publication-gates.test.js tests/gpu-result-fencing-commit.test.js tests/gpu-publication-consistency.test.js` | **67 passing, 0 failing** |
| 6 | `npm run test:arch` | `npm run test:arch` | **935 passing, 24 pending, 0 failing** |
| 7 | `npm test` | `npm test` | **935 passing, 24 pending, 0 failing** |
| 8 | полный backend suite | `npx mocha --exit "tests/**/*.test.js"` | **3562 passing, 28 pending, 0 failing** |

**Полный suite на чистом клоне — ЗЕЛЁНЫЙ (0 failing).** Исходные 10 падений устранены файлами 20–23:

| Падение (до) | Причина | Исправление |
|---|---|---|
| `16b` (ai-shared-inference) | stale-тест под контракт LAC §9 | файл 20 |
| `IB-G15` (installer-package-boundary) | stale-тест под публичный installer | файл 21 |
| `T9` (phase5-runtime-result) | stale-тест под удалённый runtime-баррель | файл 22 |
| 7 × `worklist-rebuild` (Option E) | отравление `runtime-scheduler` стабом `active-scenes-index` из `scope-slide` (§5.2) | файл 23 |

`worker-share-policy.test.js` в зелёных прогонах проходит (45/0 изолированно; разовый таймаут 2s в первом прогоне под нагрузкой не воспроизвёлся).
