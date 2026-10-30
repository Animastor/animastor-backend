# Диагностика базовой линии тестов — 2026-10-30

**Область:** `animastor-backend` (backend suite). GPU-код (продуктовый) не менялся.
**Коммиты:** диагностика на `main 19975ff` (до правок) и на `a824eb4`; результат — `main` + коммит с фиксом теста.
**Правило полного прогона:** `bash scripts/test-backend.sh` — грузит `backend/.env.test`, проверяет контейнеры
`animastor-pg-test` / `animastor-redis-test`, затем `npm test` (mocha + `pretest` syntax-smoke).
**Тестовый стенд:** `animastor-pg-test` 127.0.0.1:55434 (postgres:16, healthy), `animastor-redis-test`
127.0.0.1:56381 (redis:7, healthy). БД `animastor_test`, Redis DB 15. Прод-стек (5432 / `animastor`) не затрагивался.

---

## 1. Итоговые цифры

| Состояние | passing | pending | failing | exit |
|---|---|---|---|---|
| `main 19975ff`, как было найдено | **3618** | **29** | **12** | 12 |
| `main 19975ff` после `npm ci` (без правок тестов) | **3625** | **28** | **6** | 6 |
| `a824eb4` после `npm ci` (без правок тестов) | **3625** | **28** | **6** | 6 |
| **`main d99434e` (фикс теста) — новая базовая линия** | **3631** | **28** | **0** | **0** |

Всего тестов во всех прогонах одинаково: 3659 (`3631 + 28`). Число тестов не менялось — менялся только набор падений.

Заявленные 9 падений (4 × `gpu-lane-release-order`, 2 × `gpu-orphan-video`, 3 × `orchestrator-convergence`)
в текущем окружении **не воспроизводятся**; вместо них на том же «грязном» `node_modules` наблюдались 4 + 2 + 6 ×
`Stage 76`. Подробно — §3 и §4.

---

## 2. Причина №1 (окружение): `node_modules` разошёлся с `package-lock.json`

`npm ls` до ремонта:

```
animastor-backend@0.1.0
├── @animastor/editor@0.1.2        invalid: "^0.2.0" from the root project
├── @animastor/orchestration@0.1.7 invalid: "^0.2.0" from the root project
└── @animastor/player@0.1.1        invalid: "^0.1.3" from the root project
```

Лок же пинит `orchestration 0.2.0`, `editor 0.2.0`, `player 0.1.3`
(`backend/package-lock.json`, записи `node_modules/@animastor/*`). В git `node_modules` не входит, поэтому
`package.json`/`package-lock.json` на `main` и `a824eb4` **идентичны** (`git diff --stat a824eb4..19975ff -- backend/package*.json`
пуст) — расхождение чисто локальное, в установленном дереве.

Следствие: тесты читают `../node_modules/@animastor/orchestration/...` напрямую, а версия 0.1.7 не содержит
контрактов Stage 120/122:

- `src/runtime/dispatch-engine.js` — `clearHubDispatches()` не имеет book-scoped ветки: при пустом списке id и
  переданном `book_id` не делает ни одного запроса (`requested: 0`);
- в 0.1.7 отсутствует `releaseTaskDoneIfOrphan` в `src/runtime/persistence-port.js` (grep по `node_modules/@animastor/orchestration/src` — 0 совпадений), поэтому video-send не освобождает orphan-маркер.

**Классификация: зависимость (версия пакета).**
**Исправление:** `cd backend && npm ci` (восстановление строго по локу). Реестр доступен, `npm view @animastor/orchestration@0.2.0`
и `editor@0.2.0`, `player@0.1.3` отдают нужные версии. После `npm ci`: `0.2.0 / 0.2.0 / 0.1.3`, `git status` чистый.
Это убрало 6 падений (4 + 2) и вернуло счётчики к 3625/28/6.

---

## 3. Причина №2 (хрупкий тест / порядок): `scope-slide.test.js` не восстанавливает `OUTPUT_DIR`

Оставшиеся 6 падений — `tests/synthetic-null-recreation-fix.test.js` (Stage 76). Изолированно файл проходит
**9/9**; в полном прогоне падает 6. Воспроизведение парой:

```
npx mocha --exit tests/scope-slide.test.js tests/synthetic-null-recreation-fix.test.js
→ 23 passing, 6 failing (те же шесть)
```

Механизм:

1. `tests/scope-slide.test.js` (`describe('scene cache-skip (content on disk)')`) в `beforeEach` ставит
   `process.env.OUTPUT_DIR = /tmp/opencode/test-cache-skip` и удаляет `src/config/runtime-config.js` из `require.cache`
   (чтобы модуль перечитал env).
2. В `afterEach` он делал `delete process.env.OUTPUT_DIR`, хотя значение приходило из `backend/.env.test`
   (`OUTPUT_DIR=/tmp/opencode/audit/testrun/output`). Удаление вместо восстановления — потеря исходного значения.
3. `scene-assets-repo` к этому моменту уже загружен и держит **старый** экземпляр конфига (`runtimeConfig.OUTPUT_DIR =
   /tmp/opencode/audit/testrun/output`). `buildIdFromArtifactPath()` сравнивает путь артефакта с
   `runtimeConfig.OUTPUT_DIR` этого экземпляра (`src/storage/postgres/repositories/scene-assets-repo.js:89-104`).
4. Stage 76 берёт `config()` — после purge это **новый** экземпляр, а `OUTPUT_DIR` в env уже удалён →
   фолбэк `/data/output`. Путь `/data/output/build_test76_a/...` не начинается с корня старого экземпляра →
   `buildIdFromArtifactPath()` возвращает `null` → `expected null to equal 'build_test76_a'` и производные падения.

Это загрязнение общего состояния тестами, а не дефект продукта: изолированно и без pollution-соседа Stage 76 зелёный.

**Классификация: тест хрупкий (загрязнение env/require-cache, порядок тестов).**
**Исправление** (`backend/tests/scope-slide.test.js`, +10/−1): сохранить исходное значение на уровне модуля и
восстанавливать его, а не удалять:

```js
const ORIGINAL_OUTPUT_DIR = process.env.OUTPUT_DIR;
...
if (ORIGINAL_OUTPUT_DIR === undefined) delete process.env.OUTPUT_DIR;
else process.env.OUTPUT_DIR = ORIGINAL_OUTPUT_DIR;
```

Проверка: пара `scope-slide + synthetic-null` → **29 passing, 0 failing**; полный прогон → **3631/28/0**.

---

## 4. Разбор по каждому падению

### 4.1 `gpu-lane-release-order.test.js` — 4 падения

| # | Тест | Текст ошибки |
|---|---|---|
| 1 | `clearHubDispatches book-scoped sweep (audit 121 · N1)` → «empty ids + book_id issues EXACTLY one book-scoped DELETE and reports it» | `AssertionError: expected [] to have a length of 1 but got +0` (`:488`) |
| 2 | «a hub ERROR is reported honestly (failed, never cleared)» | `expected { requested: 0, cleared: 0, failed: 0 } to deeply equal { requested: 1, cleared: 0, failed: 1 }` (`:497`) |
| 3 | «an UNREACHABLE hub counts as failed and never throws» | то же: `requested/failed` 0 вместо 1 (`:503`) |
| 4 | «a hub that echoes a FOREIGN scope is a failure» | то же: `requested/failed` 0 вместо 1 (`:509`) |

**Причина:** установленный `@animastor/orchestration@0.1.7`; book-scoped sweep появился в 0.2.0 (Stage 120/122 N1).
При пустом списке id функция не делает запрос и возвращает нули, поэтому мок `fetchImpl` не вызывается.
**Классификация: зависимость.** Исправлено `npm ci`. После ремонта — **17/17 passing** (и на `main`, и на `a824eb4`).

### 4.2 `gpu-orphan-video.test.js` — 2 падения

| # | Тест | Текст ошибки |
|---|---|---|
| 5 | «frees the orphaned marker and regenerates the video job ONCE» | `AssertionError: expected false to equal true` (`:218`, `result.dispatched`) |
| 6 | «does NOT retry on a non-orphan verdict (duplicate_pending stays bounded)» | `AssertionError: expected 'send_failed' to equal 'duplicate_pending'` (`:234`) |

**Причина:** в 0.1.7 порт персистентности не содержит `idem.releaseTaskDoneIfOrphan`, поэтому send-loop не
освобождает orphan и завершается `send_failed`; повторной попытки нет.
**Классификация: зависимость.** Исправлено `npm ci`. После ремонта — **3/3 passing**.

### 4.3 `synthetic-null-recreation-fix.test.js` (Stage 76) — 6 падений

| # | Тест | Текст ошибки |
|---|---|---|
| 7 | «ensureSyntheticStaleAsset обновляет versioned-строку вместо INSERT NULL» | `expected null to equal 'build_test76_a'` (`:112`) |
| 8 | «genuine edit через book-sync.markSceneAssetsStale не плодит NULL-строку» | `expected null to equal 'build_test76_a'` (`:139`) |
| 9 | «ready versioned-строка при edit через book-sync: step1 матчит ready» | `expected null to equal 'build_test76_a'` (`:153`) |
| 10 | «два versioned-строки с разными builds» | `обе versioned-строки консервативно stale: expected 1 to equal 2` (`:201`) |
| 11 | «повторный ensure на неоднозначном ключе идемпотентен» | `expected [ { id: … } ] to have a length of 2 but got 1` (`:221`) |
| 12 | «NULL+versioned одной формы (production ba_)» | `обновляется только NULL-строка — прежняя ветка: expected 2 to equal 1` (`:233`) |

**Причина:** загрязнение `OUTPUT_DIR` из `scope-slide.test.js` (§3) → `build_id` не выводится из пути.
**Классификация: тест хрупкий (порядок тестов).** Исправлено; после фикса — **9/9** и в полном прогоне.

### 4.4 `orchestrator-convergence.test.js` (stage 50) — заявленные 3 падения не воспроизведены

- Изолированно: **35/35 passing** — и на `main`, и на `a824eb4`.
- В полном прогоне `main 19975ff` с грязным `node_modules`: **35/35 passing**.
- В полном прогоне `main d99434e` (после ремонта): **35/35 passing**.

Ни в одном прогоне этой сессии файл не падал. Набор падений на одинаковом грязном `node_modules` оказался
нестабильным между прогонами (у меня — 6 × Stage 76, в исходном отчёте — 3 × convergence), что указывает на
зависимость от порядка/общего состояния, а не на детерминированный дефект. Доказанная и исправленная
order-зависимость — §3. **Классификация: не воспроизведено (окружение/порядок); правок не потребовалось.**
Если повторится — нужен лог с полным прогоном и указанием соседних файлов.

---

## 5. Что проверено и исключено

| Гипотеза | Проверка | Вывод |
|---|---|---|
| `node_modules` / `package-lock` / версии `@animastor/*` из npm | `npm ls`, сравнение с локом | **причина** (orchestration 0.1.7 / editor 0.1.2 / player 0.1.1 вместо 0.2.0 / 0.2.0 / 0.1.3) |
| `ANIMASTOR_DOCS_ROOT` (docs `08f39f3` vs текущий `2eb08d3`) | переменная не задана; guard берёт соседний клон `../animastor-docs`; `git diff 08f39f3..HEAD -- architecture/PHASE_2_CONTRACTS.md` пуст; architecture-suite зелёный | **не причина** |
| Состояние `animastor-test` (Redis/PG) | контейнеры healthy; Redis `DBSIZE=0`; в PG `scene_assets/scenes` по `test76-%` и `conv_book` — 0 строк; после прогонов таблицы чистые (собственный `after` Stage 76 проверяет это) | **не причина**; пересоздание стека не потребовалось |
| Зависимость от даты/времени/таймеров | падения детерминированно воспроизводятся парой файлов без участия времени; fix/date-логика в них не задействована | **не причина** |
| Порядок тестов | изолированные прогоны 4 файлов: 17/17, 3/3, 35/35, 9/9; бинарный поиск соседа → `scope-slide.test.js` | **причина** для Stage 76 |
| Реальный баг в GPU-коде | оба GPU-файла зелёные на 0.2.0; продуктовый код не менялся | **бага нет** |

---

## 6. Изменения

- `backend/tests/scope-slide.test.js` — восстановление `OUTPUT_DIR` вместо удаления (+10/−1).
- `backend/node_modules` — приведён к `package-lock.json` через `npm ci` (в git не входит; файлы лока не менялись).
- Продуктовый код (`src/**`, GPU-очередь, orchestration) **не изменён**. Номера/`package.json`/lock не менялись.

## 7. Воспроизведение

```bash
cd animastor-backend
bash scripts/test-backend.sh                 # полный прогон по правилу

# изолированно
set -a; . backend/.env.test; set +a
cd backend
npx mocha --exit tests/gpu-lane-release-order.test.js
npx mocha --exit tests/gpu-orphan-video.test.js
npx mocha --exit tests/orchestrator-convergence.test.js
npx mocha --exit tests/synthetic-null-recreation-fix.test.js
```

## 8. Итог

Новая базовая линия — **3631 passing / 28 pending / 0 failing** (exit 0, полный прогон по правилу).
Она обоснованно лучше прежней 3625/28/6: шесть «базовых» падений были тем же загрязнением `OUTPUT_DIR`,
которое устранено. Заявленные 4 + 2 падения были вызваны рассинхронизацией `node_modules` с локом
и устранены `npm ci`; 3 падения `orchestrator-convergence` не воспроизвелись ни в одном прогоне.
