// ======================================================
// gen/sql/001-gen-core — v2 orchestration schema (ADR ORCHESTRATION_V2 §4)
// ======================================================
// Style of the backend schema.js (host storage): an ordered list of idempotent
// statements (CREATE … IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, constraints
// guarded by a pg_constraint lookup). Safe to run on every start.
//
// Pre-existing host tables touched (additive only, nothing dropped):
//   books.orchestration      TEXT NOT NULL DEFAULT 'legacy' CHECK IN (legacy, v2)
//   workers.current_job_id   UUID
//   scene_assets.job_id      UUID   (ADR §4.3 — written only by acceptance, §7)
//   scene_assets.sha256      TEXT   (ADR §4.3)
//
// Table/constraint names are resolved through search_path (regclass), so the
// same statements run unchanged inside a per-test schema.

'use strict';

const ADD_CHECK = (table, name, expr) => `
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '${name}' AND conrelid = '${table}'::regclass
    ) THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr});
    END IF;
END $$`;

const GEN_CORE_SQL = Object.freeze([
    // ── host tables: additive columns ─────────────────────────────────────
    `ALTER TABLE books ADD COLUMN IF NOT EXISTS orchestration TEXT NOT NULL DEFAULT 'legacy'`,
    ADD_CHECK('books', 'books_orchestration_check', `orchestration IN ('legacy','v2')`),
    `ALTER TABLE workers ADD COLUMN IF NOT EXISTS current_job_id UUID`,
    `ALTER TABLE scene_assets ADD COLUMN IF NOT EXISTS job_id UUID`,
    `ALTER TABLE scene_assets ADD COLUMN IF NOT EXISTS sha256 TEXT`,

    // ── gen_commands (ADR §4.1) ───────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS gen_commands (
        command_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id      UUID NOT NULL,
        user_id           UUID NOT NULL,
        book_id           TEXT NOT NULL,
        kind              TEXT NOT NULL,
        scope             JSONB NOT NULL,
        layers            TEXT[] NOT NULL,
        force             BOOLEAN NOT NULL DEFAULT false,
        client_action_id  TEXT,
        status            TEXT NOT NULL DEFAULT 'active',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at       TIMESTAMPTZ,
        cancelled_by      TEXT,
        error             TEXT,
        CONSTRAINT gen_commands_client_action_uniq UNIQUE (book_id, client_action_id)
    )`,
    ADD_CHECK('gen_commands', 'gen_commands_kind_check', `kind IN ('regenerate','generate_all')`),
    ADD_CHECK('gen_commands', 'gen_commands_status_check',
        `status IN ('active','done','partial','failed','cancelled')`),
    ADD_CHECK('gen_commands', 'gen_commands_scope_check',
        `jsonb_typeof(scope) = 'object' AND COALESCE(scope->>'level', '') IN ('book','chapter','scene','unit')`),
    ADD_CHECK('gen_commands', 'gen_commands_layers_check',
        `cardinality(layers) > 0 AND layers <@ ARRAY['audio','image','video']::text[]`),
    `CREATE INDEX IF NOT EXISTS idx_gen_commands_book_status ON gen_commands (book_id, status)`,

    // ── gen_jobs (ADR §4.2) ───────────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS gen_jobs (
        job_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        command_id        UUID NOT NULL REFERENCES gen_commands(command_id) ON DELETE CASCADE,
        workspace_id      UUID NOT NULL,
        user_id           UUID NOT NULL,
        book_id           TEXT NOT NULL,
        chapter_id        TEXT NOT NULL,
        scene_id          TEXT NOT NULL,
        unit_key          TEXT NOT NULL,
        kind              TEXT NOT NULL,
        executor          TEXT NOT NULL,
        lane              JSONB,
        status            TEXT NOT NULL DEFAULT 'queued',
        attempt           INTEGER NOT NULL DEFAULT 0,
        max_attempts      INTEGER NOT NULL DEFAULT 1,
        worker_id         UUID,
        deadline          TIMESTAMPTZ,
        not_before        TIMESTAMPTZ NOT NULL DEFAULT now(),
        input             JSONB NOT NULL DEFAULT '{}'::jsonb,
        result_path       TEXT,
        result_sha256     TEXT,
        result_bytes      BIGINT,
        error_class       TEXT,
        error             TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        claimed_at        TIMESTAMPTZ,
        finished_at       TIMESTAMPTZ
    )`,
    ADD_CHECK('gen_jobs', 'gen_jobs_status_check',
        `status IN ('queued','running','done','failed','cancelled')`),
    ADD_CHECK('gen_jobs', 'gen_jobs_kind_check',
        `kind IN ('audio_chunk','iu_image','video_group','audio_merge','video_merge')`),
    ADD_CHECK('gen_jobs', 'gen_jobs_executor_check',
        `executor IN ('gpu:audio','gpu:image','gpu:video','local')`),
    // kind ↔ executor are bound one-to-one (no audio job on a video worker)
    ADD_CHECK('gen_jobs', 'gen_jobs_kind_executor_check',
        `(kind = 'audio_chunk' AND executor = 'gpu:audio')
      OR (kind = 'iu_image'    AND executor = 'gpu:image')
      OR (kind = 'video_group' AND executor = 'gpu:video')
      OR (kind IN ('audio_merge','video_merge') AND executor = 'local')`),
    // GPU work always carries a lane (§4.2, gpu-dispatcher.js:213–222); local work none
    ADD_CHECK('gen_jobs', 'gen_jobs_lane_check',
        `(executor = 'local' AND lane IS NULL)
      OR (executor <> 'local' AND COALESCE(lane->>'kind', '') IN ('private','policy','system'))`),
    ADD_CHECK('gen_jobs', 'gen_jobs_attempt_check', `attempt >= 0 AND max_attempts >= 1`),
    ADD_CHECK('gen_jobs', 'gen_jobs_running_check',
        `status <> 'running' OR (deadline IS NOT NULL AND attempt >= 1)`),

    // claim (§4.2 «выдача»)
    `CREATE INDEX IF NOT EXISTS idx_gen_jobs_claim ON gen_jobs (executor, status, not_before) WHERE status = 'queued'`,
    // one live job per unit (§4.2, §6.2)
    `CREATE UNIQUE INDEX IF NOT EXISTS uniq_gen_jobs_live_unit
        ON gen_jobs (book_id, chapter_id, scene_id, kind, unit_key)
        WHERE status IN ('queued','running')`,
    // sweeper (§4.2 «сторож»)
    `CREATE INDEX IF NOT EXISTS idx_gen_jobs_deadline ON gen_jobs (deadline) WHERE status = 'running'`,
    // progress (§4.2)
    `CREATE INDEX IF NOT EXISTS idx_gen_jobs_command_status ON gen_jobs (command_id, status)`,
    // beacon / worker_offline sweep / fairness counts (additions, not in ADR list)
    `CREATE INDEX IF NOT EXISTS idx_gen_jobs_worker_running ON gen_jobs (worker_id) WHERE status = 'running'`,
    `CREATE INDEX IF NOT EXISTS idx_gen_jobs_ws_running ON gen_jobs (workspace_id, executor) WHERE status = 'running'`,
    `CREATE INDEX IF NOT EXISTS idx_gen_jobs_book_scene ON gen_jobs (book_id, chapter_id, scene_id)`,
]);

module.exports = { GEN_CORE_SQL };
