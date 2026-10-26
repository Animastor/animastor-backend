# deploy/ — целевой deploy-каталог (активен с этапа 37)

**Статус:** G4 применён (этап 37). Это **канонический источник** compose для
production. Runtime переключён с mono-каталога на этот (H2, этап 37); health
200/200/200, pg/redis/gpu-hub **не пересоздавались**. Rollback-канал — mono
(`/home/animastor/animastor/docker-compose.yml` + overlay + `.env`) сохранён
(держать ≥7 дней, см. runbook J3).

## Состав

| Файл | Происхождение | Отличия от источника |
|---|---|---|
| `docker-compose.yml` | 3-way: mono `docker-compose.yml` + `docker/compose/overlay-backend-standalone.yml` vs `animastor-backend/docker-compose.yml` | (1) bind-mount источники — **абсолютные** (runbook E1), указывают на текущие production-каталоги mono (монты не менялись); (2) gpu-hub без `build:` с обязательным pin (repo-версия) |
| `overlay-backend-standalone.yml` | копия mono overlay (sha256 `eac32cb0…`) | **только** пути bind-mount переведены в абсолютные (иначе `./…` разрешился бы в deploy/data/…) |
| `.env` | копия `/home/animastor/animastor/.env` (byte-identical, sha `ee64133e…`), `chmod 600` | секреты не здесь; **не печатать** |

## Управление (актуальная команда)

```sh
cd /home/animastor/animastor-backend/deploy
docker compose --project-name animastor --env-file .env \
  -f docker-compose.yml -f overlay-backend-standalone.yml up -d
```

`--project-name animastor` ОБЯЗАТЕЛЕН (иначе другие имена томов pg-data/redis-data).
Оба `-f` всегда вместе (иначе backend останется без image-pin).

## Rollback (если переключение сломало что-то)

```sh
cd /home/animastor/animastor && docker compose -f docker-compose.yml \
  -f docker/compose/overlay-backend-standalone.yml up -d --force-recreate
```

## Ключи `.env` (по ИМЕНАМ, значения не здесь)

`POSTGRES_PASSWORD`, `WORKSPACE_SECRET_KEY`, `BACKEND_IMAGE` (pin digest),
`GPU_HUB_IMAGE` (pin digest), `GPU_HUB_API_KEY`, `OPENROUTER_API_KEY`,
`COOKIE_DOMAIN`, `GPU_TIMEOUT`, `SHARE_FEATURES_ENABLED`, `LETS_ENCRYPT_DIR`,
`KEEP_AUDIO_CHUNKS`, `AUDIO_CLEANUP_TAIL_ONLY`, `TRACK_CHUNK_DURATIONS`.
