# Stage 152 — выпуск фикса чата (enable_thinking) + db-hardening в прод

Дата: 2026-10-28. Оператор: агент. Разрешение владельца: сборка прод-образа через GitHub Actions и обновление контейнера `animastor-backend`; всё остальное (прод-БД, Redis, данные, тома, другие контейнеры, `deploy/.env` кроме строки `BACKEND_IMAGE`, merge, force-push, push напрямую в github минуя origin, npm publish) — запрещено и не выполнялось. Push в `origin/main` разрешался и выполнялся.

**Итог: ВЫПУЩЕНО. Откат не выполнялся.**

---

## 1. Параметры выпуска

| Параметр | Значение |
|---|---|
| Ветка | `main` (репозиторий `animastor-backend`, рабочая копия `animastor-backend-hotfix`, push только в `origin`) |
| Approve-коммит | `551bb007dcbac06ac9368dc9a6c3913a9e34d382` |
| Дерево, вошедшее в образ (`APPROVED_COMMIT`) | `6dbf2a14218f0754ef551540a396206d2e8aba32` |
| Тег образа | `deploy-551bb007` |
| **Digest образа** | `sha256:887a39e47781cc42254c672240b48e24e95bd9fe57b49f73d080a9b71100a6d7` |
| Label ревизии в образе/контейнере | `551bb007dcbac06ac9368dc9a6c3913a9e34d382` |
| Label версии | `deploy-551bb007` |

---

## 2. Approve-коммит (п. 1)

```
551bb007 ci(backend): approve 6dbf2a1 backend tree for GHCR release (stage 152)
 .github/workflows/backend-ghcr-release.yml | 2 +-  (1 insertion, 1 deletion)

-  APPROVED_COMMIT: 43ef4232629a1d67f5b54215a32f572274cda5f3
+  APPROVED_COMMIT: 6dbf2a14218f0754ef551540a396206d2e8aba32
```

Ровно одна строка изменена — `APPROVED_COMMIT` в `.github/workflows/backend-ghcr-release.yml`.
Push обычный (без force) в `origin/main`:
`6dbf2a14..551bb007  main -> main`.
Dirty-файлы не трогались, `git add` только по имени файла workflow.

---

## 3. Сборка образа через GitHub Actions (workflow_dispatch)

Запуск:
```
gh workflow run backend-ghcr-release.yml -R Animastor/animastor-backend \
  --ref main -f commit=551bb007dcbac06ac9368dc9a6c3913a9e34d382 -f image_tag=deploy-551bb007
```

Workflow выполнен успешно (run id `40672702340`, job `build-smoke-push` ID `122763246830`):
все шаги пройдены — `Verify source commit (fail-closed)`, `Build image`,
`Isolated smoke`, `Push immutable tags`, `Record digest`.

Образ собран CI из коммита `551bb007dcbac06ac9368dc9a6c3913a9e34d382`:

- Тег: `deploy-551bb007` и полный SHA `551bb007dcbac06ac9368dc9a6c3913a9e34d382`
- Registry: `ghcr.io/animastor/animastor-backend`
- Digest: `sha256:887a39e47781cc42254c672240b48e24e95bd9fe57b49f73d080a9b71100a6d7`
- Label `org.opencontainers.image.revision`: `551bb007dcbac06ac9368dc9a6c3913a9e34d382` (совпадает с коммитом checkout'а)
- Label `org.opencontainers.image.version`: `deploy-551bb007`

Проверка `docker buildx imagetools inspect`:
- тег `deploy-551bb007` и полный SHA указывают на один image index
  `sha256:887a39e47781cc42254c672240b48e24e95bd9fe57b49f73d080a9b71100a6d7` — тег = digest ✅
- манифест `linux/amd64`: `sha256:9ab6169f226592199a66246b895973c7c3826ceed7385dfd77e54cc277e03cc3`
- label ревизии в образе: `551bb007dcbac06ac9368dc9a6c3913a9e34d382` ✅

Изоляционное дымовое тестирование workflow пройдено: `/health` возвращает
`{"status":"ok","redis":"PONG"}` в изолированном контейнере без production PG/Redis.

---

## 4. Деплой (п. 3–4)

### 4.1 Repozitorij `animastor-deploy`, `/home/animastor/prod`

В `docker-compose.yml` заменён digest backend:

```
- image: ghcr.io/animastor/animastor-backend@sha256:1a77916909c6f261dd2dc1b7aeb6dab6d7e07b34cda4f4af060fe3dd10a32ba0
+ image: ghcr.io/animastor/animastor-backend@sha256:887a39e47781cc42254c672240b48e24e95bd9fe57b49f73d080a9b71100a6d7
```

Коммит `5f7012c release(backend): stage 152 887a39e47781`, push в `origin/main`:
`4edaed3..5f7012c  main -> main`.

### 4.2 Пересоздание контейнера (прод, `/home/animastor/prod`)

```
docker compose -p animastor --env-file .env up -d backend
```

Пересоздан **только** сервис `backend`; `animastor-pg`/`animastor-redis`,
`gpu-hub`, `nginx` — без cambios (прежний аптайм).

Состояние прода **до/после**:

| | до | после |
|---|---|---|
| image | `sha256:1a779169…` | `sha256:887a39e4…` |
| label revision | `a24d4924…` | `551bb007…` |
| label version | `deploy-a24d4924` | `deploy-551bb007` |

---

## 5. Проверки после деплоя (п. 5, первые 5+ минут)

| Контроль | Результат |
|---|---|
| `docker inspect animastor-backend` image | `sha256:887a39e47781cc42254c672240b48e24e95bd9fe57b49f73d080a9b71100a6d7` ✅ |
| label ревизии в контейнере | `551bb007dcbac06ac9368dc9a6c3913a9e34d382` ✅ |
| `/health` | **200** — `{"status":"ok","loop":true,"redis":"PONG","ts":…}` ✅ |
| label версии | `deploy-551bb007` ✅ |
| ReferenceError / crash-loop / FATAL | **0** за период после рестарта ✅ |
| HTTP 5xx в логах | **0** ✅ |
| Утечка `WORKSPACE_SECRET_KEY` / `PG_PASSWORD` в логи | **0** (секреты не печатаются) ✅ |
| `[PG] PostgreSQL storage initialized` | подключение к PG успешно ✅ |
| PG log: подключение `animastor_app` | `connection authorized: user=animastor_app database=animastor` (10:34:52 UTC) ✅ |
| посторонние контейнеры | не пересоздавались ✅ |

Откат не понадобился — ни одно из условий отката не нарушено.

---

## 6. Откат (п. 5, на случай если понадобится)

```sh
cd /home/animastor/prod
git revert 5f7012c   # вернёт digest 1a779169… в docker-compose.yml
docker compose -p animastor --env-file .env up -d backend
```

(в этом прогоне **не выполнялся**).
