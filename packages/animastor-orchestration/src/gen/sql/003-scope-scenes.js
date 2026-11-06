// ======================================================
// gen/sql/003-scope-scenes — ADR ORCHESTRATION_V2 §11.1, §13 п.8 (stage 1c)
// ======================================================
// gen_commands.scope gains level 'scenes' {level:'scenes', scene_ids:[…]}
// («from the current scene to the end», expanded by the host in book order).
// The constraint keeps its NAME (gen_commands_scope_check) and gets a new
// definition: 001's ADD_CHECK adds it only when the name is missing, so the
// old definition never comes back on the next start. Idempotent.
// NULL-safe: a CHECK that evaluates to NULL passes, hence the COALESCEs.

'use strict';

const SCOPE_CHECK = `jsonb_typeof(scope) = 'object'
    AND COALESCE(scope->>'level', '') IN ('book','chapter','scenes','scene','unit')
    AND CASE WHEN scope->>'level' = 'scenes'
             THEN COALESCE(jsonb_typeof(scope->'scene_ids'), '') = 'array' AND COALESCE(scope->'scene_ids' <> '[]'::jsonb, false)
             ELSE true END`;

const GEN_SCOPE_SCENES_SQL = Object.freeze([
    `DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'gen_commands_scope_check' AND conrelid = 'gen_commands'::regclass
          AND pg_get_constraintdef(oid) NOT LIKE '%scenes%'
    ) THEN
        ALTER TABLE gen_commands DROP CONSTRAINT gen_commands_scope_check;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'gen_commands_scope_check' AND conrelid = 'gen_commands'::regclass
    ) THEN
        ALTER TABLE gen_commands ADD CONSTRAINT gen_commands_scope_check CHECK (${SCOPE_CHECK});
    END IF;
END $$`,
]);

module.exports = { GEN_SCOPE_SCENES_SQL, SCOPE_CHECK };
