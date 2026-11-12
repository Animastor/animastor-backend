// ======================================================
// gen/sql/005-voice-reference — kind voice_reference (1.4.0, VOICE_REFERENCES.md)
// ======================================================
// gen_jobs.kind gains 'voice_reference' (executor gpu:audio, layer audio);
// gen_commands.kind gains 'voice_reference'. The four constraints keep their
// NAMES and get new definitions (001/002 add them only when the name is
// missing, so the old definitions never come back). Idempotent: a constraint
// is replaced only while its definition does not mention voice_reference.

'use strict';

const REPLACE_CHECK = (table, name, expr) => `
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '${name}' AND conrelid = '${table}'::regclass
          AND pg_get_constraintdef(oid) NOT LIKE '%voice_reference%'
    ) THEN
        ALTER TABLE ${table} DROP CONSTRAINT ${name};
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '${name}' AND conrelid = '${table}'::regclass
    ) THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr});
    END IF;
END $$`;

const LAYER_OF_KIND_SQL = `CASE kind
    WHEN 'audio_chunk' THEN 'audio' WHEN 'audio_merge' THEN 'audio' WHEN 'voice_reference' THEN 'audio'
    WHEN 'iu_image' THEN 'image'
    WHEN 'video_group' THEN 'video' WHEN 'video_merge' THEN 'video' END`;

const GEN_VOICE_REFERENCE_SQL = Object.freeze([
    REPLACE_CHECK('gen_jobs', 'gen_jobs_kind_check',
        `kind IN ('audio_chunk','iu_image','video_group','audio_merge','video_merge','voice_reference')`),
    REPLACE_CHECK('gen_jobs', 'gen_jobs_kind_executor_check',
        `(kind IN ('audio_chunk','voice_reference') AND executor = 'gpu:audio')
      OR (kind = 'iu_image'    AND executor = 'gpu:image')
      OR (kind = 'video_group' AND executor = 'gpu:video')
      OR (kind IN ('audio_merge','video_merge') AND executor = 'local')`),
    REPLACE_CHECK('gen_jobs', 'gen_jobs_layer_kind_check', `layer = (${LAYER_OF_KIND_SQL})`),
    REPLACE_CHECK('gen_commands', 'gen_commands_kind_check', `kind IN ('regenerate','generate_all','voice_reference')`),
]);

module.exports = { GEN_VOICE_REFERENCE_SQL, LAYER_OF_KIND_SQL };
