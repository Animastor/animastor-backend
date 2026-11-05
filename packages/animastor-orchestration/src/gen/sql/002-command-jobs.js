// ======================================================
// gen/sql/002-command-jobs — ADR ORCHESTRATION_V2 §4.1, §4.2, §4.2a (редакция 06.11)
// ======================================================
// Idempotent on top of 001 (safe on every start):
//   gen_jobs.build_id  TEXT NOT NULL      (was input.build_id; backfilled)
//   gen_jobs.layer     TEXT NOT NULL      audio|image|video, derived from kind
//   gen_commands.summary JSONB            {jobs_created, joined, skipped_ready}
//   gen_command_jobs (command_id, job_id) PK — which commands wait for a job
//                                         (backfilled from gen_jobs.command_id)

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

const LAYER_OF_KIND_SQL = `CASE kind
    WHEN 'audio_chunk' THEN 'audio' WHEN 'audio_merge' THEN 'audio'
    WHEN 'iu_image' THEN 'image'
    WHEN 'video_group' THEN 'video' WHEN 'video_merge' THEN 'video' END`;

const GEN_COMMAND_JOBS_SQL = Object.freeze([
    // ── gen_jobs.build_id ────────────────────────────────────────────────
    `ALTER TABLE gen_jobs ADD COLUMN IF NOT EXISTS build_id TEXT`,
    `UPDATE gen_jobs SET build_id = COALESCE(NULLIF(input->>'build_id', ''), 'default') WHERE build_id IS NULL`,
    `ALTER TABLE gen_jobs ALTER COLUMN build_id SET NOT NULL`,

    // ── gen_jobs.layer ───────────────────────────────────────────────────
    `ALTER TABLE gen_jobs ADD COLUMN IF NOT EXISTS layer TEXT`,
    `UPDATE gen_jobs SET layer = ${LAYER_OF_KIND_SQL} WHERE layer IS NULL`,
    `ALTER TABLE gen_jobs ALTER COLUMN layer SET NOT NULL`,
    ADD_CHECK('gen_jobs', 'gen_jobs_layer_check', `layer IN ('audio','image','video')`),
    ADD_CHECK('gen_jobs', 'gen_jobs_layer_kind_check', `layer = (${LAYER_OF_KIND_SQL})`),
    `CREATE INDEX IF NOT EXISTS idx_gen_jobs_book_layer_live ON gen_jobs (book_id, layer) WHERE status IN ('queued','running')`,

    // ── gen_commands.summary ─────────────────────────────────────────────
    `ALTER TABLE gen_commands ADD COLUMN IF NOT EXISTS summary JSONB`,

    // ── gen_command_jobs (§4.2a) ─────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS gen_command_jobs (
        command_id  UUID NOT NULL REFERENCES gen_commands(command_id) ON DELETE CASCADE,
        job_id      UUID NOT NULL REFERENCES gen_jobs(job_id) ON DELETE CASCADE,
        PRIMARY KEY (command_id, job_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gen_command_jobs_job ON gen_command_jobs (job_id)`,
    `INSERT INTO gen_command_jobs (command_id, job_id)
        SELECT command_id, job_id FROM gen_jobs
        ON CONFLICT DO NOTHING`,
]);

module.exports = { GEN_COMMAND_JOBS_SQL };
