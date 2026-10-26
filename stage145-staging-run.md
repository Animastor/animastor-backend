# Stage 145 — staging-прогон `IU_IMAGE_VERSIONED` (вариант B, debug-replay, без GPU)

**Тип:** исполнение изолированного staging-прогона по плану Stage 144 (вариант B — debug-replay без
GPU, **без staging-воркера**).

**Границы (соблюдены):** прод-код не менялся; контейнеры/PG/Redis/compose/`.env` прода не трогались;
`IU_IMAGE_VERSIONED` в проде отсутствует; прод-сеть `animastor_net` и прод-хаб не использовались;
все порты staging — loopback; `main` не тронут; merge/deploy/`npm publish` не выполнялись;
dirty-файлы рабочей копии не изменялись. В коммит включён **только этот документ**.

**Ветка:** `stage143a-foundation-phase1` (staging-клон — detached HEAD).
**Сборка:** локальный образ `staging-backend` из клона на
`df4b2fa9c0552f4658cccc502ed33f1ebf32c27d`; `git diff --name-only 6f277494..HEAD` = только
`stage144-staging-plan.md` ⇒ **код идентичен базовому `6f2774942193b27140f2b61e9e293462a986500e`**.

> Self-reference невозможен: хеш коммита этого документа сообщается в чат после push и не
> записывается внутрь файла.

---

## 0. Итог

| Сценарий | Итог | Кратко |
|---|---|---|
| **S1** — старые IU + превью (флаг ON, легаси-файлы) | **PASS** | `/iu-image` 200 `image/png`, байты = канонические; `/preview` 200 `X-Preview-Created: true` |
| **S2** — перегенерация одного IU (versioned-издание) | **PASS** | `.versions/{iuId}/1.png`, указатель `publish_fence=1`, ETag содержит fence, превью пересоздано из опубликованного источника; stale/повторная доставка отклонены, указатель не двигается |
| **S3** — отсутствие бесконечной регенерации (30 мин) | **PASS (условно)** | новых `Fence reservation` без действия 0, `Missing image file …` 0, `dirty_unit_ids` пуст; НО наблюдается цикл `VERSION-GATE … stale → DIRTY` (см. A1) |
| **S4** — storyboard | **PASS** | 200 `application/zip`, 4 кадра, versioned `iu-000001.png` взят из указателя |
| **S5** — откат флага → B7 → повторное включение | **PASS** | OFF: легаси-чтение и инертный указатель; B7 удаляет строки, immutable-файлы остаются; ON: DDL `iu_image_*` на месте |

**Вердикт: флаг `IU_IMAGE_VERSIONED` НЕ готов к включению на проде на этой базе.**
Блокирует **не** сам контур versioned-публикации (S1–S5 его подтверждают), а то, что **оба
санкционированных планом триггера регенерации сломаны**:

* **D1** — `/api/v1/book/:bookId/regenerate` падает с `ReferenceError: artifactNaming is not defined`;
* **D2** — все `/api/v1/debug/runtime/*` зависают (middleware без вызова `next()`).

Оба дефекта присутствуют и в **продовом** образе (проверено read-only). Из-за них S2/S3 нельзя
выполнить штатным сценарием плана; прогон сделан вынужденным обходным путём (правка текста юнита →
`PATCH` сцены → повторная активация сцены + установка состояния `image=pending` в staging-Redis —
документированное debug-действие). На этом обходном пути выявлена аномалия сходимости **A1**.

Легаси-путь (флаг OFF) работает штатно — см. S5.1.

**Прод не тронут:** аптаймы `animastor-backend` (5 дней), `animastor-pg`/`animastor-redis`
(2 месяца), `gpu-hub` (2 недели), `animastor-proxy` (7 дней) до/во время/после прогона не менялись.

---

## 1. Изоляция staging

Топология по плану §2.2, каталог `/home/animastor/staging-144/`
(`docker-compose.staging.yml` + `.env.staging` `chmod 600`, секреты
`STAGING_PG_PASSWORD`/`STAGING_WORKSPACE_SECRET_KEY`/`STAGING_HUB_API_KEY` сгенерированы
`openssl rand -hex 32`, **в документе не приводятся**).

| Инвариант | Значение | Проверка |
|---|---|---|
| compose project | `animastor-staging` (≠ `animastor`) | labels `com.docker.compose.project` всех 4 контейнеров |
| контейнеры | `staging-backend`, `staging-postgres`, `staging-redis`, `staging-hub` | `docker ps` |
| сеть | `animastor-staging_net` (bridge) — **не** `animastor_net` | `NetworkSettings.Networks` каждого staging-контейнера |
| тома | `animastor-staging_staging-pg-data`, `animastor-staging_staging-redis-data` | `docker volume ls` |
| порты | `127.0.0.1:3100→3000`, `127.0.0.1:55433→5432`, `127.0.0.1:56380→6379`; хаб порт не публикует | `docker ps` |
| БД | `animastor_staging` / user `staging` | `printenv PG_DB PG_USER` |
| Redis | свой (`redis://redis:6379`), `REDIS_URL` хаба — staging | env контейнеров |
| хаб → backend | `BACKEND_URL=http://backend:3000` (только staging) | env `staging-hub` |
| флаги | `SHARE_FEATURES_ENABLED=0` (backend и хаб) | env контейнеров |

Прод (read-only, для сравнения): `animastor-backend` `IU_IMAGE_VERSIONED` **отсутствует**,
`PG_DB=animastor`, `HUB_URL=http://gpu-hub:5000`, сеть `animastor_net` — не пересекается со staging.

**Прод не тронут (снимки до / во время / после, `docker ps`):**

| Контейнер (прод) | До прогона | Во время | После (`16:19Z`) |
|---|---|---|---|
| `animastor-backend` | Up 5 days | Up 5 days | Up 5 days |
| `animastor-pg` | Up 2 months (healthy) | Up 2 months (healthy) | Up 2 months (healthy) |
| `animastor-redis` | Up 2 months (healthy) | Up 2 months (healthy) | Up 2 months (healthy) |
| `gpu-hub` | Up 2 weeks | Up 2 weeks | Up 2 weeks |
| `animastor-proxy` | Up 7 days | Up 7 days | Up 7 days |

Ни один прод-контейнер не перезапускался/не пересоздавался; `IU_IMAGE_VERSIONED` в проде так и
отсутствует; прод-сеть `animastor_net` для staging не использовалась.

## 2. Тестовая книга

Создана **новая** книга нормальным импортом при флаге OFF (прод не копировался): `stage145_mini.vbook`
→ `POST /api/v1/book/import` (HTTP 200), `book_id=stage145_mini`, `build_id=stage145_build1`,
глава `ch-a1b2c3`, сцена `sc-d4e5f6`, юниты `iu-000001/2/3`. Гостевая cookie — для аутентифицированных
маршрутов.

Подготовка (обоснование обходного пути):

* Задачи генерировались «живым» system-воркером только через гейт исполнителя — поэтому в staging-Redis
  обновляются фиктивные heartbeat’ы `animastor:worker:heartbeat:{audio,image}:staging-fake-*`
  (`{ts,mode:'system'}`, TTL 30s). Реальный воркер/GPU не подключались (вариант B).
* При флаге OFF через debug-replay доставлены результаты: audio (silence mp3) + три отличных PNG
  (red/green/blue) → канонические файлы записаны (`[IMAGE] CANONICAL IU IMAGE: …`), таблиц `iu_image_*`
  нет (OFF).
* Слой видео отключён для тестовой книги (`PUT /layer-config {"video_enabled":false}`) — крошечные
  синтетические PNG не проходят реальный video-конвейер; это вне предмета проверки.

## 3. Сценарии

### S1 — старые IU и превью (флаг ON, легаси-файлы)

Флаг ON (`IU_IMAGE_VERSIONED=1`, рестарт), таблицы `iu_image_pointers` + `iu_image_fence_reservations`
созданы. Указателей ещё нет (0 строк).

```
GET /api/v1/iu-image/stage145_mini/ch-a1b2c3/sc-d4e5f6/iu-000001?build_id=stage145_build1
→ 200 image/png; sha256(body)=9c265bed01bcb0c467d7db2eaf68455758ca6a8d2b7f0fa0a6e0815cd12b060e
  = канонический /data/output/stage145_build1/…_iu-000001.png

GET /api/v1/iu-image/…/iu-000002?build_id=stage145_build1
→ 200 image/png; sha256=5ace4b1513…  = канонический …_iu-000002.png

GET /api/v1/preview/…/iu-000001?build_id=stage145_build1
→ 200 image/png; X-Preview-Created: true; sha256=63557559a0…
```

Указателей нет ⇒ `resolveIuImagePath` → `absent` ⇒ работает легаси-ветка без fallback-подмены
(в логах нет `/iu-image published target …`), байты совпадают с каноническими.
**Итог S1: PASS.**

### S2 — перегенерация одного IU (новое versioned-издание)

**Триггер (штатный):** правка текста юнита. `PATCH /api/v1/book/stage145_mini/scene/ch-a1b2c3/sc-d4e5f6
{"unit_id":"iu-000001","fields":{"text":"…"}}` → 200; PG `scenes.dirty_unit_ids={iu-000001}`,
`content_version=2` (`[BOOK-SYNC] RECONCILE … 1 assets stale`).
**Dispatch (обходной путь):** из-за D1/D2 штатные `regenerate`/`reset-scene` неприменимы; сцена
повторно активирована и `image` выставлен в `pending` в staging-Redis (документированное debug-действие).

Логи/факты публикации:

```
[IMAGE] [DIRTY-UNIT-REGEN] Force-regenerating …_iu-000001 — this unit was modified
[IMAGE] [DIRTY-UNIT-REGEN] Deleted stale PNG: /data/output/stage145_build1/…_iu-000001.png
[IMAGE] [DIRTY-UNIT-REGEN] Deleted stale preview: /data/output/stage145_build1/…_pr-000001.png
[GPU] Fence reservation created: …_iu-000001:iu_image idem=179fa206604e fence=1
💾 Versioned publication: stage145_build1/.versions/stage145_mini_ch-a1b2c3_sc-d4e5f6_iu-000001/1.png (fence=1, …)
```

```
PG: iu_image_pointers → iu_id=iu-000001, publish_fence=1,
    path=stage145_build1/.versions/stage145_mini_ch-a1b2c3_sc-d4e5f6_iu-000001/1.png
Файл .versions/…/1.png sha256=d62e68d9be15305e953e3c5121a49541b18f3d38cf3950ffed126454c23486cd (= доставленный yellow)

GET /iu-image/…/iu-000001 → 200 image/png
    ETag: W/"1-196-1793029368674.8098"   ← fence=1
    sha256(body)=d62e68d9be…             ← versioned-байты (НЕ прежний легаси 9c265bed…)
GET /preview/…/iu-000001 → 200 (X-Preview-Created: true); sha256=3d2d82bc… ≠ S1-preview 63557559…
    лог: [IMAGE] preview created from published source: …_pr-000001.png
```

Дополнительно (идемпотентность/устаревание), указатель не меняется:

```
replay СТАРОГО dispatch_id (fence=1) → {"ok":true,"rejected":true,"reason":"no_active_dispatch"}
повторная доставка того же результата  → {"ok":true,"rejected":true,"reason":"no_active_dispatch"}
PG: publish_fence остаётся 1
```

> Замечание: маркер `[PREVIEW-INVALIDATE]` из `task-handler.cjs` в лог **не попал**, потому что
> превью было удалено раньше — на стадии `[DIRTY-UNIT-REGEN] Deleted stale preview`; к моменту
> публикации файла уже не было, поэтому `fs.existsSync` в блоке инвалидации = false. Функционально
> превью инвалидировано и пересоздано из опубликованного источника.

**Итог S2: PASS.**

### S3 — отсутствие бесконечной регенерации (soak ≥30 мин, флаг ON)

Прогон `2026-10-26T15:45:50Z → 2026-10-26T16:16:21Z` (30 мин) без вмешательства.

| Проверка | Значение | Итог |
|---|---|---|
| новых `Fence reservation created` без действия | 1 → **1** (0 новых) | ✅ |
| `iu_image_pointers` строк | 1 → **1** (без изменений) | ✅ |
| `Missing image file … resetting state for redispatch` | 0 | ✅ |
| `scenes.dirty_unit_ids` | `{}` | ✅ |
| `GET /api/v1/chunk/:id` | `{"status":"ready","image_ready":true,…}` | ✅ |

Итоговый срез soak (`stage145-s3-final.txt`):

```
=== S3 SOAK END 2026-10-26T16:16:21Z ===
fence_reservations_rows=1
pointers_rows=1
dirty_unit_ids={}
log_fence_reservation_created=1
log_missing_image_file=0
log_VERSION_GATE_stale=400
active_scenes=1
```

За 30 минут счётчик `VERSION-GATE … stale` вырос с 29 до **400** — это и есть цикл A1.
Дополнительно положительный маркер N1: `[DIRTY-UNITS-CLEARED] … all 1 dirty unit(s) completed,
cleared` (dirty-юнит очищен через указатель; `[DIRTY-UNITS-PARTIAL]` отсутствует).

**Аномалия A1 (не входит в три обязательных критерия, но зафиксирована):** сцена не переходит в
`READY` — наблюдается устойчивый цикл
`[VERSION-GATE] … image stale — DIRTY instead of READY` → `DIRTY` → `pending` → повторная
диспетчеризация → `cache_hit` (новый fence не создаётся, `Missing image file` отсутствует).
Причина (root cause, наблюдаемая): в `scene_assets` строка `image` имеет `build_id = NULL`
(`status=stale`, `scene_content_version=2`, `path=…_iu-000001.png` — относительный), а version-gate в
`completeStage` читает ассет через `sceneAssets.getAsset(..., stage, buildId)` с фильтром
`build_id = $buildId` — строка с `NULL` не находится ⇒ `shouldWriteReady=false` ⇒ `DIRTY`.
За весь сеанс маркер `[PG-IMAGE-READY]` **ни разу** не появился (gate не проходил ни разу).
Происхождение `NULL`-строки в этом прогоне **не установлено достоверно** (кандидат — синтетический/
легаси маркер версии с `build_id IS NULL`); штатный путь сходимости опирается на
`stampSceneVersionsForDispatch`. Оговорка: обходной путь (ручная установка `image=pending` + повторная
активация) мог не повторить штатную последовательность, поэтому A1 **не** классифицируется как
подтверждённый прод-дефект — требуется отдельная проверка на штатном триггере (после починки D1/D2).
При этом главное — сам контур публикации/указателя сработал верно: dirty-юнит был корректно очищен
через указатель (`[DIRTY-UNITS-CLEARED] … all 1 dirty unit(s) completed, cleared`), новых `Fence
reservation` и `Missing image file` не было.

**Итог S3: PASS** по трём явным критериям плана, с зафиксированной аномалией A1.

### S4 — storyboard

```
GET /api/v1/book/stage145_mini/storyboard → 200 application/zip (Content-Length 922)
unzip -l: iu-000001.png (196B), iu-000002.png (189B), iu-000003.png (190B), pr-000001.png (213B)
лог: [EXPORT] storyboard stage145_mini build=stage145_build1 (4 images)
```

`iu-000001.png` = 196 B = versioned-версия из указателя (легаси-канонический удалён при регенерации).
Негатив-контроль (битый указатель/404) не воспроизводился — вне объёма прогона.
**Итог S4: PASS.**

### S2b — второе versioned-издание того же IU (fence 1 → 2)

Повторная правка текста юнита (`PATCH` сцены) → `content_version=3`, `dirty_unit_ids={iu-000001}`;
повторная активация + `image=pending` (debug). Создана новая резервация `fence=2` (`idem=e902cccefbff`).

```
[GPU] Fence reservation created: …_iu-000001:iu_image idem=e902cccefbff fence=2
💾 Versioned publication: stage145_build1/.versions/…_iu-000001/2.png (fence=2, …)

PG: iu_image_pointers → publish_fence=2, path=…/2.png        (было 1)
.versions/…_iu-000001/1.png   sha256=d62e68d9…  (yellow — НЕ изменён, immutable)
.versions/…_iu-000001/2.png   sha256=ad8aa616…  (magenta)

GET /iu-image/…/iu-000001 → 200; ETag: W/"2-197-1793031481375.054"  ← fence=2
    sha256(body)=ad8aa616…  ← новое издание
```

Отклонения (указатель не двигается):

```
replay СТАРОГО (fence=1) dispatch → {"ok":true,"rejected":true,"reason":"stale_dispatch"}
повторная доставка fence=2-результата → {"ok":true,"rejected":true,"reason":"no_active_dispatch"}
PG: publish_fence остаётся 2
```

> Разница причин уместна: на S2 старый dispatch был уже финализирован (`no_active_dispatch`), на
> S2b его lease ещё жил, но был вытеснен новым intent’ом (`stale_dispatch`). Оба — отказ, без записи.

**Итог S2b: PASS** — указатель монотонно продвигается (1→2), прошлое издание сохраняется, доставка
идентифицируется по dispatch/fence и повторно не применяется.

### S5 — откат флага, B7, повторное включение

**S5.1 — флаг OFF** (`IU_IMAGE_VERSIONED=` пусто, рестарт; в контейнере переменная пуста):

```
GET /iu-image/…/iu-000002 → 200 image/png; sha256=5ace4b15…  ← канонический (легаси работает)
GET /iu-image/…/iu-000001 → 404 {"error":"IU image not found"}
      (канонический …_iu-000001.png был удалён на S2; указатель при OFF инертен — см. ниже)
GET /preview/…/iu-000002  → 200 image/png; X-Preview-Created: true
GET /book/stage145_mini/storyboard → 200 application/zip (903 B):
      iu-000002.png, iu-000003.png, pr-000002.png   (versioned-only iu-000001 не включён)
GET /chunk/…_0001 → {"status":"ready","image_ready":true,…}
PG: iu_image_pointers → строка iu-000001 publish_fence=2 ОСТАЁТСЯ (инертна при OFF; 0 обращений)
```

**S5.2 — операторский SQL B7:**

```sql
DELETE FROM iu_image_pointers           WHERE book_id='stage145_mini' AND build_id='stage145_build1';  -- DELETE 1
DELETE FROM iu_image_fence_reservations WHERE book_id='stage145_mini' AND build_id='stage145_build1';  -- DELETE 2
```

После: `pointers=0`, `reservations=0`; **immutable-файлы сохранены**:
`.versions/…_iu-000001/1.png` и `2.png` (не тронуты — правило B7 соблюдено).

**S5.3 — повторное включение флага** (`IU_IMAGE_VERSIONED=1`, рестарт; в контейнере `1`):

```
PG: DDL iu_image_pointers + iu_image_fence_reservations присутствуют
GET /iu-image/…/iu-000001 → 404 (указатель удалён по B7, канонический отсутствует —
      это ожидаемое состояние ЧИСТОГО повторного включения; издание публикуется при следующей регенерации)
```

**Итог S5: PASS.** Легаси-ветка при OFF работает как прежде; указатель инертен; B7 удаляет строки и
сохраняет immutable-файлы; повторное включение восстанавливает DDL.

> Наблюдение (в открытые вопросы): после versioned-регенерации откат флага OFF делает такой IU
> недоступным в легаси-ветке (канонический файл удалён при регене, указатель при OFF инертен), напр.
> `iu-000001` → 404 и отсутствует в storyboard (3 файла вместо 4). Это семантика отката — просьба
> подтвердить, что она ожидаема.

---

## 4. Дефекты

**D1 — `/regenerate` падает `artifactNaming is not defined` (P0, есть и в проде).**
`@animastor/orchestration` (prod `0.1.4`, staging `0.1.5`)
`src/orchestration/orchestrator.js:60` объявляет
`const artifactNaming = require('@animastor/generation').artifactNaming;`
**внутри** функции `beginStage` (строки 57–67), тогда как `resetScenes` использует
`artifactNaming` на строках 534/537/555 (вне области видимости) → `ReferenceError`.
Repro: `POST /api/v1/book/:id/regenerate {"chapter_id":…,"scene_id":…,"worker_types":["image"]}`
→ 500 `{"error":"artifactNaming is not defined"}`; stack:
`at Object.resetScenes (…/orchestrator.js:534:57) ← generation-routes.cjs:628`.
Введено коммитом `e60c5d4b` (перенос в пакет `41a56903` сохранил позицию строки).
Не исправлялось (код вне объёма стадии).

**D2 — все `/api/v1/debug/runtime/*` зависают (P1, есть и в проде).**
`backend/src/routes/debug-routes.cjs:36`
`app.use('/api/v1/debug/runtime', (req,res)=>{ … })` — middleware не вызывает `next()`,
поэтому `GET /debug/runtime/status` и `POST /debug/runtime/reset-scene` не отвечают (curl `HTTP 000`).
Repro: `curl http://127.0.0.1:3100/api/v1/debug/runtime/status` (таймаут). Не исправлялось.

**A1 — цикл `VERSION-GATE stale → DIRTY` при versioned-only публикации (подозрение, требует
подтверждения на штатном триггере).** См. S3. Механизм: `scene_assets.image.build_id = NULL`, а
version-gate (`completeStage` → `sceneAssets.getAsset(…, stage, buildId)`) фильтрует по `build_id`,
поэтому строка не находится ⇒ `shouldWriteReady=false` ⇒ `DIRTY`; за весь сеанс `[PG-IMAGE-READY]`
не появился ни разу. Происхождение `NULL`-строки не установлено достоверно; полное подтверждение
(и отнесение к прод-дефектам) — после починки D1/D2 и прогона штатного триггера. Само по себе
отсутствие `Missing image file`/новых `Fence reservation` и корректная очистка dirty-юнита через
указатель (N1) при этом подтверждены.

**N5 (cover) — не проявлялся** в этом прогоне (книга без обложки), не проверялся.

---

## 5. Вердикт

* Контур versioned-публикации и чтения (`IU_IMAGE_VERSIONED`) на изолированном staging **работает**:
  S1–S5 подтверждают запись `.versions/{iuId}/{fence}.png`, продвижение указателя, ETag с fence,
  инвалидацию/пересборку превью из указателя, включение versioned-кадров в storyboard, откат флага
  и операторский SQL B7.
* **Включать флаг на проде нельзя** до починки **D1** и **D2**: оба санкционированных триггера
  регенерации сломаны (в т.ч. в проде). Это делает невозможной штатную перегенерацию IU при флаге ON.
* Дополнительно требуется закрыть/подтвердить **A1** на штатном триггере.
* Легаси-путь (флаг OFF) не затронут.

**Открытые вопросы к владельцу:**

1. Нужно ли **оставить staging поднятым** для разбора A1/D1/D2, или выполнить уборку §2.6
   (`-p animastor-staging` только)? По умолчанию уборка **не выполнялась** (см. ниже).
2. Заводить ли отдельную стадию на D1 (перенос `artifactNaming` в область видимости модуля) и D2
   (`next()` в `/debug/runtime` middleware) до повторного прогона S2/S3.
3. Откат флага после versioned-регенерации делает ранее перегенерированные IU недоступными в легаси-ветке
   (канонический файл удалён при регене, указатель при OFF инертен) — подтвердить, что это ожидаемая
   семантика отката (см. S5).

**Уборка staging (§2.6) не выполнялась** — ожидается решение владельца по п.1. Прод при этом
не тронут.

---

## Приложение. Артефакты

* staging: `/home/animastor/staging-144/{docker-compose.staging.yml,.env.staging,src}`,
  данные `/home/animastor/staging-144/data/{books,output}`.
* логи прогонов: `/tmp/opencode/stage145-{s2b,s5,evidence}.txt`, `stage145-s3-final.txt`.
* вспомогательное: `/tmp/opencode/stage145-heartbeat.sh`, `stage145-replay.sh`,
  `stage145-s3-soak.sh`, `stage145_mini.vbook`, PNG `iu-{red,green,blue,yellow,magenta}.png`,
  `silence.mp3`.
