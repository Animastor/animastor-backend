// ======================================================
// ANIMASTOR BACKEND — DEBUG ROUTES
// ======================================================
// /api/v1/debug/* (platform admins only — backend.cjs requireAdmin).
//
// 2026-11-28 (ORCHESTRATION_V2 §12 этап 4, шаг 7): the legacy runtime
// diagnostics are removed together with the legacy orchestration — scene /
// asset states, scene events, asset registry, every /debug/runtime/* view and
// action (metrics, counters, leases, dispatches, quotas, failures, drift,
// retries, snapshots, stuck scenes, recover-video, reset-scene, status,
// apply-fix) and POST /debug/audio/recover (audio-recovery). What stays reads
// disk / Redis chunk records only. Orchestration v2 state is in PG
// (gen_commands / gen_jobs; GET /book/:id/generate/progress).

const path = require('path');
const { isValidBuildId, joinInside } = require('@animastor/vbook-runtime/safe-paths');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;
const fs = require('fs');

module.exports = function(app, redis, deps) {
    const { config, book, utils, getChunk } = deps;
    const { log } = utils;
    const OUTPUT_DIR = config.OUTPUT_DIR;

    // ======================================================
    // SCENE ASSETS
    // ======================================================
    app.get('/api/v1/debug/scene-assets/:bookId/:chapterId/:sceneId', async (req, res) => {
        try {
            const { bookId, chapterId, sceneId } = req.params;
            const buildId = req.query.build_id || 'default';
            if (!isValidBuildId(buildId)) return res.status(400).json({ error: 'invalid build id' });

            const dir = joinInside(OUTPUT_DIR, buildId);
            let files = [];
            try { files = fs.readdirSync(dir).filter(f => f.startsWith(artifactNaming.scenePrefix(bookId, chapterId, sceneId))); } catch (_) {}

            const chunkId = artifactNaming.sceneChunkAudioName(bookId, chapterId, sceneId, 1).replace(/\.mp3$/, '');
            const chunk = await getChunk(chunkId);

            const sceneBook = book.loadBook(bookId);
            let sceneData = null;
            if (sceneBook) {
                for (const ch of sceneBook.chapters || []) {
                    if (ch.chapter_id === chapterId) {
                        for (const sc of ch.scenes || []) {
                            if (sc.scene_id === sceneId) { sceneData = sc; break; }
                        }
                        break;
                    }
                }
            }

            res.json({
                book_id: bookId, chapter_id: chapterId, scene_id: sceneId, build_id: buildId,
                files, chunk, scene_data: sceneData,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CLEANUP RETENTION
    // ======================================================
    app.post('/api/v1/debug/cleanup/retention', async (req, res) => {
        try {
            const { build_ttl_hours } = req.body || {};
            const ttlHours = build_ttl_hours || 48;
            const now = Date.now();
            const ttlMs = ttlHours * 60 * 60 * 1000;

            const builds = [];
            try {
                const dirs = fs.readdirSync(OUTPUT_DIR).filter(name => {
                    const fullPath = path.join(OUTPUT_DIR, name);
                    try { return fs.statSync(fullPath).isDirectory(); } catch (_) { return false; }
                });

                for (const dir of dirs) {
                    const dirPath = path.join(OUTPUT_DIR, dir);
                    const stat = fs.statSync(dirPath);
                    const ageMs = now - stat.mtimeMs;
                    if (ageMs > ttlMs) {
                        builds.push({ build_id: dir, age_hours: (ageMs / 3600000).toFixed(1) });
                    }
                }
            } catch (_) {}

            res.json({
                builds_to_cleanup: builds.length,
                builds: builds.slice(0, 50),
                ttl_hours: ttlHours,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    log('[ROUTES] Debug routes loaded');
};
