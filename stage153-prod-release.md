# Stage 153 — @animastor/editor 0.2.0 + ai_chat_sessions epoch ms в прод

Дата: 2026-10-29. Оператор: агент. Разрешение владельца: выкатка backend по digest,
сделанному GitHub Actions; смоук только на тестовом аккаунте. Push только в `origin`.
`down`/`prune`/пересоздание pg/redis/proxy не выполнялись.

**Итог: ВЫПУЩЕНО. Откат не выполнялся.**

---

## 1. Параметры выпуска

| Параметр | Значение |
|---|---|
| Approve-коммит | `12d6bf09fd0feff626ba7bdb3231328087a3bea6` |
| Дерево образа (`APPROVED_COMMIT`) | `18b4f4b06a59168f02fcdabf30f144bc32cabf48` |
| Тег образа | `deploy-12d6bf0` (и полный SHA `12d6bf09…` → тот же index) |
| **Digest образа (index)** | `sha256:1fde561c58a4b2e8251d056fee91c438ee271200ffd967e51c406941e479ed5a` |
| Манифест `linux/amd64` | `sha256:792837b151c8f20ea0fe2efb6f1e91dd0c07a5140cbda34c65e99f745b4a77af` |
| Label `org.opencontainers.image.revision` | `12d6bf09fd0feff626ba7bdb3231328087a3bea6` |
| Label `org.opencontainers.image.version` | `deploy-12d6bf0` |
| Предыдущий образ (Stage 152) | `sha256:887a39e47781cc42254c672240b48e24e95bd9fe57b49f73d080a9b71100a6d7` |

## 2. Что вошло (4e97186..12d6bf0)

- `8ad67e7` fix(pg): ai_chat_sessions timestamps are epoch ms — DEFAULT `created_at`/`updated_at`
  в мс (CREATE TABLE + идемпотентная миграция ALTER … SET DEFAULT и UPDATE строк `< 1e11` × 1000).
- `41c101f` fix(editor): POST /book/blank — владелец обязателен (503 `ownership_unavailable`),
  откат строки books при падении commit (порт `rollbackOwnership`), 401 для identity без workspace,
  `language` 'ru'|'en'.
- `e78705c` chore(editor): release prep @animastor/editor 0.2.0.
- `18b4f4b` chore(backend): pin `@animastor/editor` `^0.2.0` (registry.npmjs.org, integrity
  `sha512-Zgi4QVpY…GfHWw==`, совпадает с `npm pack --dry-run`).
- `12d6bf0` ci(backend): approve 18b4f4b.

Тесты (animastor-test): 3311 passing / 28 pending / 8 failing — набор падений идентичен main 4e97186
(6 × Stage 76 synthetic-null, ai-shared-inference 16b, installer IB-G15).

## 3. Деплой

animastor-deploy `c9750db deploy: backend Stage 153 (12d6bf0)`, push origin, `prod`: `git pull --ff-only`.

```
- image: ghcr.io/animastor/animastor-backend@sha256:887a39e47781cc42254c672240b48e24e95bd9fe57b49f73d080a9b71100a6d7
+ image: ghcr.io/animastor/animastor-backend@sha256:1fde561c58a4b2e8251d056fee91c438ee271200ffd967e51c406941e479ed5a
```

Бэкап PG до выкатки: `/home/animastor/backups/pre-stage153-202610290343/pg-animastor.dump`
(pg_dump -Fc, 600, TOC 43 TABLE DATA).

```
cd /home/animastor/prod
docker compose -p animastor --env-file .env up -d backend     # 2026-10-29T03:43:59Z
```

Пересоздан только `animastor-backend` (старт 03:44:01Z); pg/redis/proxy — прежний аптайм.

## 4. Проверки

| Контроль | Результат |
|---|---|
| `docker inspect` image / revision | `sha256:1fde561c…` / `12d6bf09…` ✅ |
| Лог миграции | `[PG] ai_chat_sessions timestamps → epoch ms (fixed created_at=0, updated_at=0)` ✅ |
| Ошибки миграций / ReferenceError / FATAL | 0 ✅ |
| DEFAULT в PG | `((EXTRACT(epoch FROM now()))::bigint * 1000)` для обоих столбцов ✅ |
| `/health` | 200 `{"status":"ok","loop":true,"redis":"PONG"}` ✅ |
| Версия editor в контейнере | `0.2.0` (чтение `/app/node_modules/@animastor/editor/package.json`; `require('@animastor/editor/package.json')` даёт `ERR_PACKAGE_PATH_NOT_EXPORTED` — exports root-only) ✅ |
| HTTP 5xx после рестарта | 0 ✅ |

Смоук (тестовый аккаунт `stage153_smoke_*`, создан через `/auth/register`, удалён после):

| Шаг | Результат |
|---|---|
| POST /book/blank `{language:'en'}` | 200; title `New book`, language `en`, chapter `New chapter`, scene `Scene 1`; books.workspace_id = workspace тестового аккаунта; книга в `GET /books` ✅ |
| POST /ai/sessions на тестовой книге | `created_at=1793245545766` (> 1e12) ✅; DELETE → 200, строк 0 |
| DELETE /book (en) | 200; диск 0, PG (books/snapshots/scenes/scene_assets/image_units/ai_chat_sessions/book_source/generation_tasks) 0 |
| POST /book/blank `{}` | 200; `Новая книга`, `ru`, `Новая глава`, `Сцена 1` ✅; DELETE → 200, диск/PG 0 |
| Тестовый аккаунт | logout; sessions/workspace_members/workspaces/users по 1 строке удалены в транзакции; ссылок 0 |

Найдено (дефект штатного DELETE, не регрессия Stage 153): после `DELETE /api/v1/book/:id` остаётся
`animastor:cancelled-workers:{bookId}` (set `vbook`, без TTL). `book-deletion.cjs` ставит его до
`cleanBookRedisKeys`, а шаблоны `cleanBookRedisKeys` (`helpers/redis-helpers.cjs`) этот ключ не
содержат, хотя комментарий в book-deletion утверждает обратное. Для двух тестовых книг ключ удалён
точечно (`DEL`). Требует отдельного фикса (TTL или ключ в шаблоны после проверки агента).

Наблюдение: `books.language` для русской книги записан как `en` — `ensureBook` по умолчанию ставит
`'en'`, а resolveOwnership язык не передаёт. В JSON книги `language` правильный.

## 5. Откат (не выполнялся)

```sh
# animastor-deploy: revert c9750db (вернёт sha256:887a39e4…, Stage 152), push origin
cd /home/animastor/prod && git pull --ff-only
docker compose -p animastor --env-file .env up -d backend
```

Миграция ai_chat_sessions совместима с Stage 152: код и раньше писал мс, менялся только DEFAULT.
