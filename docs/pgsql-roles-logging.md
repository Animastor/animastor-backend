# PostgreSQL roles и journal подключений (animastor-prod)

Обновлено: 2026-10-28. Без паролей.

## Роли

| Роль | Атрибуты | Назначение |
|------|----------|------------|
| `animastor` | LOGIN, владелец БД `animastor`, всех 43 таблиц и 16 последовательностей | Рабочая роль бэкенда. После п.3: **NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS**. Бэкенд ходит в PG под ней (`PG_USER=animastor`). |
| `animastor_admin` | SUPERUSER LOGIN | Административная роль кластера. Создана вместо `pg_admin` (имена ролей с префиксом `pg_` зарезервированы PostgreSQL). Используется только для администрирования (ALTER ROLE, pg_authid, ALTER SYSTEM). |

`pg_dumpall` перед изменениями: `/home/animastor/backups/pgrole-20261028/` (dir 700, файлы 600).

## Где хранятся пароли

- Пароль `animastor_admin` — только в `/home/animastor/.pg_admin` (права 600, владелец animastor). Не печатать, не коммитить.
- Пароль `animastor` — переменные окружения контейнера `animastor-backend` (`PG_USER`, `PG_PASSWORD`, `PG_HOST=postgres`, `PG_PORT=5432`, `PG_DB=animastor`) и том `animastor_pg-data` (инициализация кластера через `POSTGRES_USER`/`POSTGRES_PASSWORD`).
- Файл `/home/animastor/.pg_admin` не входит в репозиторий (см. `.gitignore`).

## Журнал подключений PG

Настроено `ALTER SYSTEM` (запись в `postgresql.auto.conf`) + `pg_reload_conf()`; `logging_collector=on` вступил после рестарта только контейнера `animastor-pg`.

Параметры:
- `log_connections=on`, `log_disconnections=on`
- `logging_collector=on`, `log_directory='log'` (внутри PGDATA-тома `animastor_pg-data` — переживает пересоздание контейнера)
- `log_filename='postgresql-%a.log'` (7 файлов, по дню недели; `log_rotation_age=1d`, `log_truncate_on_rotation=on` → хранение ~7 дней)
- `log_line_prefix='%m [%p] %u@%d %h '`
- `log_min_messages=warning`, `log_statement='ddl'`

## Как читать логи PG

```bash
# подключение к контейнере БД (только аутентифицированные роли)
docker exec animastor-pg ls -la /var/lib/postgresql/data/log/
docker exec animastor-pg cat /var/lib/postgresql/data/log/postgresql-$(date +%a).log
```

Пример строки подключения (с IP-адресом клиента):

```
2026-10-28 04:28:19.811 UTC [90] animastor_admin@animastor 127.0.0.1 LOG:  connection authorized: user=animastor_admin database=animastor application_name=psql
```

Поля префикса: `%m` время с мс, `[%p]` PID, `%u@%d` пользователь@БД, `%h` удалённый хост/IP.

## Откат

Если после п.3 появились ошибки `permission denied` / `must be superuser` — вернуть `animastor` атрибут `SUPERUSER` от имени `animastor_admin` и пересоздать `animastor-backend`.
