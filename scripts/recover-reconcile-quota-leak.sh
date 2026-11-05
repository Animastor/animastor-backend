#!/usr/bin/env bash
# ============================================================
# scripts/recover-reconcile-quota-leak.sh — prod state recovery after the
# reconcile-quota-leak incident (2026-11-05, BA ba_1788172242081).
# ============================================================
# RUN ONLY AFTER the fixed backend (orchestration 0.3.5) is deployed —
# with the old code the leak re-forms within 1–2 scheduler ticks.
#
# Modes:
#   --dry-run  (default) READ-ONLY: Redis GET/TTL/SCAN/HGETALL/LRANGE, PG under
#              default_transaction_read_only=on, the committed-audio probe
#              (src/audio/validation.isSceneAudioCommitted — the SAME predicate
#              the backend uses) executed read-only inside animastor-backend.
#   --apply    writes, after a backup:
#                1. phantom dispatches of the book (status=dispatched, no
#                   jobs_enqueued, no hub job) → DEL meta + lease;
#                2. animastor:runtime:active-<stage> → number of LIVE dispatches
#                   (all books) — SET only if it differs.
#              PG is NOT written: stale scenes with a confirmed commit are
#              restored to READY by the fixed dispatch path itself (READY_RESTORE
#              → completeStage version gate) on the next «Генерировать аудио →
#              Вся книга» — no GPU. A direct PG UPDATE would bypass the gate.
#   --rollback <backup-dir>  restore the Redis keys saved by --apply.
#
# Usage:
#   scripts/recover-reconcile-quota-leak.sh [--dry-run] [--book <id>] [--stage audio]
#   scripts/recover-reconcile-quota-leak.sh --apply [--book <id>]
#   scripts/recover-reconcile-quota-leak.sh --rollback /home/animastor/backups/rql-<UTC>
#
# Never prints secrets: no .env is read, redis-cli/psql run inside the
# containers with their own credentials.

set -euo pipefail

MODE="dry-run"
BOOK="ba_1788172242081"
STAGE="audio"
ROLLBACK_DIR=""
REDIS_C="animastor-redis"
PG_C="animastor-pg"
BACKEND_C="animastor-backend"
BACKUP_ROOT="/home/animastor/backups"
GRACE_MS=$((2 * 60 * 1000))

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) MODE="dry-run" ;;
        --apply) MODE="apply" ;;
        --rollback) MODE="rollback"; ROLLBACK_DIR="${2:?--rollback needs a dir}"; shift ;;
        --book) BOOK="${2:?}"; shift ;;
        --stage) STAGE="${2:?}"; shift ;;
        *) echo "unknown arg: $1" >&2; exit 2 ;;
    esac
    shift
done

[[ "$BOOK" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad book id" >&2; exit 2; }
[[ "$STAGE" =~ ^(audio|image|video)$ ]] || { echo "bad stage" >&2; exit 2; }

r() { docker exec -i "$REDIS_C" redis-cli "$@"; }
pgq() {
    docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' "$PG_C" \
        sh -c 'psql -U "$POSTGRES_USER" -d animastor -At -F "|" -c "$0"' "$1"
}
now_ms() { echo $(( $(date +%s%3N) )); }
COUNTER="animastor:runtime:active-${STAGE}"

# ── rollback ────────────────────────────────────────────────
if [[ "$MODE" == "rollback" ]]; then
    [[ -f "$ROLLBACK_DIR/redis-keys.tsv" ]] || { echo "no redis-keys.tsv in $ROLLBACK_DIR" >&2; exit 2; }
    n=0
    while IFS=$'\t' read -r key ttl b64; do
        [[ -n "$key" ]] || continue
        val="$(printf '%s' "$b64" | base64 -d)"
        if [[ "$ttl" -gt 0 ]]; then r SET "$key" "$val" EX "$ttl" >/dev/null; else r SET "$key" "$val" >/dev/null; fi
        n=$((n + 1))
    done < "$ROLLBACK_DIR/redis-keys.tsv"
    echo "rollback: restored $n key(s) from $ROLLBACK_DIR"
    exit 0
fi

echo "== reconcile-quota-leak recovery — mode=$MODE book=$BOOK stage=$STAGE $(date -u +%FT%TZ)"

# ── 1. hub-held dispatch ids (running + every queue lane) ───
HUB_IDS="$(
    { r --raw HVALS animastor:running 2>/dev/null || true
      for q in $(r --scan --pattern 'animastor:queue:*'); do
          [[ "$(r TYPE "$q")" == "list" ]] && r --raw LRANGE "$q" 0 -1
      done
    } | { grep -o '"dispatch_id":"[^"]*"' || true; } | cut -d'"' -f4 | sort -u
)"
echo "hub jobs: $(printf '%s' "$HUB_IDS" | grep -c . || true) dispatch id(s) in running/queues"

# ── 2. classify dispatches of the stage (all books — the counter is global)
NOW="$(now_ms)"
live=0; phantom_keys=()
printf '%-70s %-10s %-6s %-5s %-6s %s\n' "lease (book/chapter/scene)" "status" "jobs" "hub" "age_s" "verdict"
for lk in $(r --scan --pattern "animastor:dispatch-lease:*:${STAGE}" | sort); do
    mk="${lk/dispatch-lease/dispatch-meta}"
    meta="$(r --raw GET "$mk")"
    tok="$(r --raw GET "$lk")"
    short="${lk#animastor:dispatch-lease:}"
    if [[ -z "$meta" ]]; then
        printf '%-70s %-10s %-6s %-5s %-6s %s\n' "$short" "-" "-" "-" "-" "LIVE (lease without meta — ownership unknown, kept)"
        live=$((live + 1)); continue
    fi
    did="$(printf '%s' "$meta" | { grep -o '"dispatch_id":"[^"]*"' || true; } | cut -d'"' -f4)"
    st="$(printf '%s' "$meta" | { grep -o '"status":"[^"]*"' || true; } | cut -d'"' -f4)"
    started="$(printf '%s' "$meta" | { grep -o '"started_at":[0-9]*' || true; } | cut -d: -f2)"
    jobs="no"; printf '%s' "$meta" | grep -q '"jobs_enqueued":true' && jobs="yes"
    mtok="$(printf '%s' "$meta" | { grep -o '"lease_token":"[^"]*"' || true; } | cut -d'"' -f4)"
    inhub="no"; printf '%s\n' "$HUB_IDS" | grep -qx "$did" && inhub="yes"
    age=$(( (NOW - ${started:-$NOW}) / 1000 ))
    verdict="LIVE"
    if [[ "$mtok" == "$tok" && "$jobs" == "no" && "$inhub" == "no" && $((age * 1000)) -ge $GRACE_MS ]]; then
        verdict="PHANTOM"
        [[ "$short" == "${BOOK}:"* ]] && phantom_keys+=("$lk") || verdict="PHANTOM (other book — not touched)"
    fi
    [[ "$verdict" == LIVE ]] && live=$((live + 1))
    [[ "$verdict" == "PHANTOM (other book — not touched)" ]] && live=$((live + 1))
    printf '%-70s %-10s %-6s %-5s %-6s %s\n' "$short" "$st" "$jobs" "$inhub" "$age" "$verdict"
done
cur="$(r --raw GET "$COUNTER")"; cur="${cur:-0}"
echo "counter $COUNTER = $cur (TTL $(r TTL "$COUNTER")); live dispatches = $live; phantom (book) = ${#phantom_keys[@]}"
echo "after apply: counter → $live"

# ── 3. scenes of the book: PG status vs committed probe ─────
echo "== scene_assets ($STAGE) of $BOOK — PG vs fenced commit"
rows="$(pgq "select chapter_id, scene_id, status, coalesce(build_id,'') from scene_assets where book_id='${BOOK}' and asset_type='${STAGE}' order by chapter_id, scene_id")"
if [[ "$STAGE" == "audio" ]]; then
    probe_in="$(printf '%s\n' "$rows")"
    docker exec -i -w /app "$BACKEND_C" node -e '
        const v = require("./src/audio/validation");
        const book = process.argv[1];
        const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
        (async () => {
            const tally = {};
            for (const l of lines) {
                const [ch, sc, st, build] = l.split("|");
                const b = build || `build_${book}`;
                let p; try { p = await v.isSceneAudioCommitted(b, book, ch, sc, null); } catch (e) { p = { ready: false, reason: "probe_error:" + e.message }; }
                const action = st === "ready" ? (p.ready ? "ok" : "CHECK (ready without commit — задача G)")
                    : st === "placeholder" ? "GPU (placeholder)"
                    : (p.ready ? "RESTORE without GPU on next command (version gate)" : "GPU (no commit)");
                tally[action] = (tally[action] || 0) + 1;
                console.log(`${ch}/${sc}\tpg=${st}\tcommitted=${p.ready}(${p.reason})\t→ ${action}`);
            }
            console.log("summary: " + JSON.stringify(tally));
            process.exit(0);
        })().catch(e => { console.error(e.message); process.exit(1); });
    ' "$BOOK" <<<"$probe_in" 2>/dev/null | { grep -v '^\[' || true; }
fi
echo "== generation_tasks (non-terminal) of $BOOK"
pgq "select task_id, status, count(*) from generation_tasks where book_id='${BOOK}' and status in ('running','pending','queued') group by 1,2 order by 1"
echo "== task registry"
r --raw HGETALL "animastor:generation-progress:${BOOK}" | paste - - | while IFS=$'\t' read -r id json; do
    printf '%s status=%s\n' "$id" "$(printf '%s' "$json" | { grep -o '"status":"[^"]*"' || true; } | head -1 | cut -d'"' -f4)"
done

[[ "$MODE" == "apply" ]] || { echo "dry-run: nothing written"; exit 0; }

# ── 4. apply: backup → write → verify ────────────────────────
ver="$(docker exec -w /app "$BACKEND_C" node -p 'require("@animastor/orchestration/package.json").version')"
case "$ver" in 0.3.[5-9]|0.[4-9].*|[1-9].*) ;; *) echo "REFUSING: orchestration $ver in $BACKEND_C — deploy the fix (>=0.3.5) first" >&2; exit 3 ;; esac
BK="$BACKUP_ROOT/rql-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 700 "$BK"
: > "$BK/redis-keys.tsv"; chmod 600 "$BK/redis-keys.tsv"
for k in "$COUNTER" "${phantom_keys[@]}" "${phantom_keys[@]/dispatch-lease/dispatch-meta}"; do
    v="$(r --raw GET "$k")"; [[ -n "$v" ]] || continue
    t="$(r TTL "$k")"
    printf '%s\t%s\t%s\n' "$k" "$t" "$(printf '%s' "$v" | base64 -w0)" >> "$BK/redis-keys.tsv"
done
pgq "select * from scene_assets where book_id='${BOOK}' and asset_type='${STAGE}'" > "$BK/scene_assets.psv"
pgq "select * from generation_tasks where book_id='${BOOK}'" > "$BK/generation_tasks.psv"
chmod 600 "$BK"/*
echo "backup: $BK ($(wc -l < "$BK/redis-keys.tsv") redis key(s))"
for lk in "${phantom_keys[@]}"; do
    r DEL "$lk" "${lk/dispatch-lease/dispatch-meta}" >/dev/null
done
[[ "$cur" == "$live" ]] || r SET "$COUNTER" "$live" >/dev/null
echo "applied: removed ${#phantom_keys[@]} phantom dispatch(es); $COUNTER $cur → $(r --raw GET "$COUNTER")"
echo "rollback: $0 --rollback $BK"
