// ======================================================
// ANIMASTOR BACKEND — REDIS CHUNK STORE (text chunk records + window counters)
// ======================================================
// 2026-11-28 (ORCHESTRATION_V2 этап 4, шаг 7): the live remainder of the
// deleted helpers/redis-helpers.cjs. What stays is NOT orchestration state:
//
//   animastor:chunk:{chunkId}        chunk record of a scene — written by the
//                                    import (POST /book/import), read by the
//                                    player (@animastor/player: scene media,
//                                    IU media, playback queue)
//   animastor:chunks:{bookId}        the book's chunk index (same writers/readers)
//   animastor:book-scenes:{bookId}:* window counters (BOOK_SCENE_TOTAL / _NEXT) —
//                                    import writes, getBookWindowStatus reads
//
// Gone with the legacy orchestration: the per-asset Redis states
// (asset-state:*) the window status and the disk recovery wrote/read, the
// versioned IU pointer proof (iu_image_pointers), the IU registry
// (animastor:iu:*), the availability mode (animastor:mode:*) and the
// cleanup of ~60 legacy key families (scripts/purge-legacy-redis.cjs
// removes what is left of them once).

'use strict';

const path = require('path');
const fs = require('fs');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;
const config = require('../config/runtime-config');
const { isValidBookId, isValidBuildId, joinInside } = require('@animastor/vbook-runtime/safe-paths');

/** Book-keyed families removed with a book / its cache (live families only). */
function bookKeyPatterns(bookId, { skipChunks = false } = {}) {
    const bookEsc = String(bookId).replace(/[*?[\]\\]/g, '\\$&');
    return [
        ...(skipChunks ? [] : [
            `animastor:chunk:${bookEsc}_*`,
            `animastor:chunks:${bookEsc}`,
        ]),
        `animastor:book-scenes:${bookEsc}:*`,
        // VBook cancel signal (until task H): the deletion cascade re-arms it
        // right after this purge, so a running agent still observes it.
        `animastor:cancelled-workers:${bookEsc}`,
    ];
}

module.exports = function createChunkStore(redis) {
    const pad = (n) => String(n).padStart(4, '0');
    const log = (...args) => console.log(new Date().toISOString(), ...args);

    async function saveChunk(id, data) {
        const chunkForRedis = {
            build_id: data.build_id,
            book_id: data.book_id,
            scene_order: data.scene_order,
            chapter_id: data.chapter_id,
            scene_id: data.scene_id,
            chunk_index: data.chunk_index,
            expected_chunk_count: data.expected_chunk_count || null,
            runtime_type: data.runtime_type || 'scene',
            scene_type: data.scene_type || 'narration',
            image: !!data.image,
            audio: !!data.audio,
            video: !!data.video,
            image_status: data.image_status || 'pending',
            video_status: data.video_status || 'pending',
            audio_status: data.audio_status || 'pending',
            padded_text: !!data.padded_text,
            unit_id: data.unit_id || null,
        };
        await redis.set(`animastor:chunk:${id}`, JSON.stringify(chunkForRedis));
        await redis.sadd(`animastor:chunks:${data.book_id}`, id);
    }

    async function getChunk(id) {
        const raw = await redis.get(`animastor:chunk:${id}`);
        if (!raw) return null;
        const c = JSON.parse(raw);
        if (c.video === undefined) c.video = false;
        if (!c.video_status) c.video_status = 'pending';
        if (!c.audio_status) c.audio_status = 'pending';
        if (!c.image_status) c.image_status = c.image ? 'ready' : 'pending';
        c.chunk_index = pad(parseInt(c.chunk_index) || 0);
        c.chapter_id = c.chapter_id || null;
        c.scene_id = c.scene_id || null;
        c.runtime_type = c.runtime_type || 'scene';
        c.scene_type = c.scene_type || 'narration';
        return c;
    }

    async function getAllChunks(bookId) {
        const ids = await redis.smembers(`animastor:chunks:${bookId}`);
        if (ids.length <= 1) return ids;
        try {
            const keys = ids.map(id => `animastor:chunk:${id}`);
            const raw = await redis.mget(keys);
            const pairs = ids.map((id, i) => {
                const data = raw[i] ? JSON.parse(raw[i]) : {};
                return { id, chapter_id: data.chapter_id || '', scene_id: data.scene_id || '', chunk_index: data.chunk_index || '0001' };
            });

            // Global scene order from the book structure (playback order even
            // when the stored per-chapter scene_order conflicts across chapters).
            let sceneIndexMap = null;
            try {
                const book = require('../book');
                const bookData = book.loadBook(bookId);
                if (bookData) {
                    const allScenes = book.collectScenes(bookData);
                    sceneIndexMap = new Map();
                    allScenes.forEach((s, idx) => {
                        sceneIndexMap.set(`${s.chapter_id}:${s.scene_id}`, idx);
                    });
                }
            } catch (_) {}

            pairs.sort((a, b) => {
                const aSceneIdx = sceneIndexMap ? (sceneIndexMap.get(`${a.chapter_id}:${a.scene_id}`) ?? null) : null;
                const bSceneIdx = sceneIndexMap ? (sceneIndexMap.get(`${b.chapter_id}:${b.scene_id}`) ?? null) : null;
                if (aSceneIdx !== null && bSceneIdx !== null) {
                    if (aSceneIdx !== bSceneIdx) return aSceneIdx - bSceneIdx;
                    return String(a.chunk_index || '0000').localeCompare(String(b.chunk_index || '0000'));
                }
                return String(a.chunk_index || '0000').localeCompare(String(b.chunk_index || '0000'));
            });
            return pairs.map(p => p.id);
        } catch (e) {
            log('getAllChunks sort failed, falling back:', e.message);
            return ids.sort((a, b) => a.localeCompare(b));
        }
    }

    /**
     * Window status of a book (player playback queue). ready_scenes came from
     * the legacy per-asset Redis states (asset-state:*), which no v2 book ever
     * had — it is 0, as it already was for every v2 book; the field stays in
     * the contract.
     */
    async function getBookWindowStatus(bookId) {
        const book = require('../book');
        const bookData = book.loadBook(bookId);
        const scenes = bookData ? book.collectScenes(bookData) : [];
        const totalScenes = scenes.length;
        const nextIdx = parseInt(await redis.get(config.BOOK_SCENE_NEXT(bookId)) || '0', 10);
        return {
            total_scenes: totalScenes,
            started_scenes: Math.min(nextIdx, totalScenes),
            ready_scenes: 0,
            next_idx: nextIdx,
        };
    }

    /**
     * Re-create the chunk records of a re-imported .vbook whose scene audio is
     * already on disk (POST /book/import of an existing book with no chunks).
     */
    async function recoverChunksFromDisk(bookId, buildId, scenes) {
        if (!isValidBuildId(buildId) || !isValidBookId(bookId)) {
            log('Recovery: invalid id, skipped');
            return [];
        }
        const dir = joinInside(config.OUTPUT_DIR, buildId);
        if (!fs.existsSync(dir)) {
            log('Recovery: output dir not found:', dir);
            return [];
        }

        let dirFiles = [];
        try { dirFiles = fs.readdirSync(dir); } catch (_) {}
        const recovered = [];
        for (const scene of scenes) {
            const chapterId = scene.chapter_id;
            const sceneId = scene.scene_id;
            const audioPath = path.join(dir, artifactNaming.sceneAudioName(bookId, chapterId, sceneId));
            if (!fs.existsSync(audioPath)) continue;

            const scenePrefix = artifactNaming.iuImagePrefix(bookId, chapterId, sceneId);
            const hasIuImages = dirFiles.some(f => f.startsWith(scenePrefix) && f.endsWith('.png'));
            const hasVideo = fs.existsSync(path.join(dir, artifactNaming.sceneVideoName(bookId, chapterId, sceneId)));
            const chunkId = artifactNaming.sceneChunkAudioName(bookId, chapterId, sceneId, 1).replace(/\.mp3$/, '');

            await saveChunk(chunkId, {
                build_id: buildId,
                book_id: bookId,
                scene_order: scene.scene_order || 0,
                chapter_id: chapterId,
                scene_id: sceneId,
                chunk_index: '0001',
                expected_chunk_count: 1,
                scene_type: scene.scene_type || 'narration',
                audio: true,
                audio_status: 'ready',
                image: hasIuImages,
                image_status: hasIuImages ? 'ready' : 'pending',
                video: hasVideo,
                video_status: hasVideo ? 'ready' : 'pending',
            });

            recovered.push(chunkId);
            log('Recovered chunk:', chunkId, '(audio=true image=' + hasIuImages + ' video=' + hasVideo + ')');
        }
        return recovered;
    }

    /**
     * Delete the book-keyed live families (chunk records, chunk index, window
     * counters, VBook cancel signal) of one book.
     * @param {RedisClient} redisClient
     * @param {string} bookId
     * @param {{skipChunks?: boolean}} [options]
     * @returns {Promise<{deleted: number}>}
     */
    async function cleanBookRedisKeys(redisClient, bookId, options = {}) {
        const r = redisClient || redis;
        let totalDeleted = 0;
        for (const pattern of bookKeyPatterns(bookId, options)) {
            try {
                let cursor = '0';
                do {
                    const [next, keys] = await r.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
                    cursor = String(next);
                    if (keys.length > 0) {
                        await r.del(...keys);
                        totalDeleted += keys.length;
                    }
                } while (cursor !== '0');
            } catch (err) {
                console.warn('[CLEAN] Scan failed for pattern', pattern, ':', err.message);
            }
        }
        log(`[CLEAN] ${bookId}: deleted ${totalDeleted} Redis keys`);
        return { deleted: totalDeleted };
    }

    return { saveChunk, getChunk, getAllChunks, getBookWindowStatus, recoverChunksFromDisk, cleanBookRedisKeys };
};

module.exports.bookKeyPatterns = bookKeyPatterns;
