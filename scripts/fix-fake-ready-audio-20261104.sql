-- ============================================================
-- 2026-11-04 — data repair for audio rows marked ready over a placeholder
-- ============================================================
-- Found by reports/2026-11-04/audio-placeholder-ready.md.
--
-- Scene ba_1788172242081/ch-5e5a8c76/sc-4bb85e02 has
--   scene_assets.status = 'ready' (id 52433)
-- while the file is a silent placeholder (path relative to OUTPUT_DIR):
--   build_ba_1788172242081/ba_1788172242081_ch-5e5a8c76_sc-4bb85e02.mp3
--   87021 bytes, 10.848 s, 24 kHz mono, max_volume -91.0 dB, 0 committed chunks.
--
-- This script is NOT executed. Run it only AFTER the code fix is deployed
-- (on the old code a 'stale' record was still fast-tracked to ready).
--
-- Safety rules (AGENTS.md, «Данные»): backup first, exact WHERE, transaction,
-- verify the row count, reversible rollback at the bottom.
--
-- Apply (as a single transaction):
--   docker exec -e PGOPTIONS='-c default_transaction_read_only=off' animastor-pg \
--     psql -U animastor -d animastor -v ON_ERROR_STOP=1 \
--     -f /path/fix-fake-ready-audio-20261104.sql
-- ============================================================

BEGIN;

-- 1. Backup the exact rows this script may touch (full row copy).
CREATE TABLE IF NOT EXISTS scene_assets_backup_20261104 AS
SELECT * FROM scene_assets WHERE false;

INSERT INTO scene_assets_backup_20261104
SELECT * FROM scene_assets
WHERE id IN (52433);

-- 2. Pre-flight: exactly one row, still in the state we investigated.
DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n FROM scene_assets
     WHERE id = 52433
       AND book_id = 'ba_1788172242081'
       AND chapter_id = 'ch-5e5a8c76'
       AND scene_id = 'sc-4bb85e02'
       AND asset_type = 'audio'
       AND status = 'ready';
    IF n <> 1 THEN
        RAISE EXCEPTION 'pre-flight failed: expected 1 ready audio row (id 52433), found %', n;
    END IF;
END $$;

-- 3. Demote to 'stale' — NOT to 'placeholder'. 'stale' means "this generation
--    was never rendered"; the asset state machine then requires a command, and
--    the fixed code dispatches real GPU work instead of answering already_ready.
UPDATE scene_assets
   SET status = 'stale',
       updated_at = EXTRACT(epoch FROM now())::bigint
 WHERE id IN (52433)
   AND status = 'ready';

-- 4. Post-flight: one row demoted, no other audio row changed.
DO $$
DECLARE n integer;
BEGIN
    SELECT count(*) INTO n FROM scene_assets WHERE id = 52433 AND status = 'stale';
    IF n <> 1 THEN
        RAISE EXCEPTION 'post-flight failed: row 52433 is not stale';
    END IF;
END $$;

COMMIT;

-- ============================================================
-- VERIFY (read-only)
-- ============================================================
-- SELECT id, book_id, chapter_id, scene_id, status, duration_sec, path
--   FROM scene_assets
--  WHERE id = 52433;
-- -- Expected: status = 'stale'
--
-- Other silent files are already 'stale' (no action needed):
--   ch-10331e4d/sc-79201cbd, ch-66e6f9a6/sc-19f26ac4,
--   ch-921d5fcb/sc-662cf28a, ch-fb6bfe85/sc-1716ab2e,
--   ch-fb6bfe85/sc-37c165a6, ch-fb6bfe85/sc-749bf8bc,
--   ch-fb6bfe85/sc-cb53ee34  (7 rows, max_volume -91.0 dB each)
--
-- Re-check for future regressions (ready rows over silence cannot be detected
-- from SQL alone — the sidecar marker does not exist for these legacy files;
-- the runtime probe now requires committed chunks):
--   SELECT sa.id, sa.book_id, sa.chapter_id, sa.scene_id
--     FROM scene_assets sa
--    WHERE sa.asset_type = 'audio' AND sa.status = 'ready';

-- ============================================================
-- ROLLBACK (run instead of step 3 if the fix must be reverted)
-- ============================================================
-- BEGIN;
-- UPDATE scene_assets sa
--    SET status = b.status,
--        updated_at = b.updated_at
--   FROM scene_assets_backup_20261104 b
--  WHERE sa.id = b.id;
-- -- Verify: SELECT count(*) FROM scene_assets_backup_20261104;  -- must be 1
-- COMMIT;
--
-- Cleanup after a successful rollback / acceptance:
--   DROP TABLE scene_assets_backup_20261104;
