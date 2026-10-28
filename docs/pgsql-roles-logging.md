# PostgreSQL roles и journal подключений (animastor-prod)

Обновлено: 2026-10-28. Без паролей.

## Роли

| Роль | Атрибуты | Назначение |
|------|----------|------------|
| `animastor` | Superuser, LOGIN | Bootstrap-роль кластера (OID 10). Остаётся единственным админом (`animastor_admin` удалён). Пароль хранится только в `/home/animastor/.pg_admin` и в `POSTGRES_PASSWORD` контейнера PG. |
| `animastor_app` | LOGIN, владелец БД `animastor`, схемы `public`, всех таблиц/последовательностей/представлений/функций в `public` | Рабочая роль бэкенда. `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. Бэкенд ходит в PG под ней (`PG_USER=animastor_app`). |

`animastor_admin` (временная суперроль для проведения миграции прав) удалена (`DROP ROLE`). Вторая суперроль не нужна.

## Где хранятся пароли

- Пароль `animastor_app` — переменные `PG_USER=animastor_app` / `PG_PASSWORD=<...>` в `.env` (права 600), не коммитится:
  - `/home/animastor/animastor-backend/deploy/.env`
  - `/home/animastor/animastor/.env` (также читается docker-compose)
- Пароль bootstrap-роли `animastor` — только в `/home/animastor/.pg_admin` (600) и в `POSTGRES_PASSWORD` контейнера PG (`animastor/.env` → `docker-compose.yml`). Из окружения бэкенда удалён (в `.env` бэкенда нет `POSTGRES_PASSWORD`).
- Никакие пароли не коммитится в git.

## Журнал подключений PG

Настроено `ALTER SYSTEM` (запись в `postgresql.auto.conf`) + `pg_reload_conf()`; `logging_collector=on` вступило после рестарта только контейнера `animastor-pg`.

Параметры:
- `log_connections=on`, `log_disconnections=on`
- `logging_collector=on`, `log_directory='log'` (внутри PGDATA-тома `animastor_pg-data` — переживает пересоздание контейнера)
- `log_filename='postgresql-%a.log'` (7 файлов, по дню недели; `log_rotation_age=1d`, `log_truncate_on_rotation=on` → хранение ~7 дней)
- `log_line_prefix='%m [%p] %u@%d %h '`
- `log_min_messages=warning`, `log_statement='ddl'`

## Как читать логи PG

```bash
docker exec animastor-pg ls -la /var/lib/postgresql/data/log/
docker exec animastor-pg cat /var/lib/postgresql/data/log/postgresql-$(date +%a).log
```

Пример строки подключения бэкенда (с IP-адресом контейнера):

```
2026-10-28 04:36:14.423 UTC [41] animastor_app@animastor 172.18.0.4 LOG:  statement: ALTER TABLE workspace_ai_providers
```

Поля префикса: `%m` время с мс, `[%p]` PID, `%u@%d` пользователь@БД, `%h` удалённый хост/IP.

## Откат

Если после перехода на `animastor_app` появятся ошибки `permission denied` — вернуть бэкенду `PG_USER=animastor` + старый `PG_PASSWORD` (из бэкапа `.env` до 2026-10-28) и пересоздать `animastor-backend`. Роль `animastor_app` и владельцы объектов при этом остаются.
