// ======================================================
// gen/sql/004-command-skips — ADR ORCHESTRATION_V2 §6.5, §13 п.11 (stage 3, video)
// ======================================================
// gen_command_skips: why a command did NOT create work for a scene
// (skipped_needs_audio / skipped_image_dirty / skipped_needs_image, …).
// Written when the command is created (also mirrored into gen_commands.summary)
// and by stage transitions inside the acceptance transaction (a video command
// waited for images / audio and the scene turned out not ready). Insert-only:
// the acceptance transaction never updates gen_commands rows (it holds them
// FOR SHARE — an UPDATE there could deadlock two parallel acceptances).
// Progress reads it. Rows go with the command (ON DELETE CASCADE).

'use strict';

const GEN_COMMAND_SKIPS_SQL = Object.freeze([
    `CREATE TABLE IF NOT EXISTS gen_command_skips (
        command_id  UUID NOT NULL REFERENCES gen_commands(command_id) ON DELETE CASCADE,
        chapter_id  TEXT NOT NULL,
        scene_id    TEXT NOT NULL,
        reason      TEXT NOT NULL CHECK (reason ~ '^skipped_[a-z_]{1,48}$'),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (command_id, chapter_id, scene_id, reason)
    )`,
]);

module.exports = { GEN_COMMAND_SKIPS_SQL };
