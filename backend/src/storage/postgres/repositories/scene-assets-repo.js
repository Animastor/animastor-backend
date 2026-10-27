const nodePath = require('path');
const { query, withTransaction } = require('../database');
const runtimeConfig = require('../../../config/runtime-config');

const logPrefix = '[SCENE-ASSETS-REPO]';

function rowToAsset(row) {
    if (!row) return null;
    return {
        id: row.id,
        book_id: row.book_id,
        chapter_id: row.chapter_id,
        scene_id: row.scene_id,
        asset_type: row.asset_type,
        path: row.path,
        duration_sec: row.duration_sec,
        width: row.width,
        height: row.height,
        format: row.format,
        sample_rate: row.sample_rate,
        channel_count: row.channel_count,
        chunks: row.chunks,
        build_id: row.build_id,
        scene_hash: row.scene_hash,
        scene_content_version: row.scene_content_version,
        scene_audio_config_version: row.scene_audio_config_version,
        status: row.status,
        error: row.error,
        metadata: row.metadata,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

function nullBuildLockKey(bookId, chapterId, sceneId, assetType) {
    return `scene_assets|null|${bookId}|${chapterId}|${sceneId}|${assetType}`;
}

async function lockNullBuildKey(client, bookId, chapterId, sceneId, assetType) {
    await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [nullBuildLockKey(bookId, chapterId, sceneId, assetType)]
    );
}

// ── Stage 73: доказанный versioned-эквивалент legacy NULL-строки ──────
// Legacy-строка `build_id IS NULL` считается ДОКАЗАННЫМ ДУБЛЕКОМ, когда у
// того же ключа (book, chapter, scene, asset_type) есть versioned-строка с
// тем же немусорным путём artifact'а (byte-identical path). Именно такую
// пару доказала Stage 72 для 21338/48353: один и тот же путь, один файл на
// диске, build_id versioned-строки == manifest.build_id.
//
// Такие строки исключаются из ВСЕХ выборок, превращающих состояние строк
// ключа в dirty/stale-сигнал (getDirtyMarkers / getDirtyScenesByVersion /
// getAudioConfigVersions / getVersionStalenessRows): сигналом для ключа
// владеет сама versioned-строка, а не её legacy-дубль — иначе каждый старте
// self-heal (rebuildWorkList → markDirtyScene → markStale) сбрасывал READY
// канонического артефакта и порождал лишний dispatch-цикл (Stage 72 §B.4).
//
// Что НЕ покрывается правилом (сознательно — прежнее поведение сохраняется):
//   • legacy-ключи без versioned-строк вообще (437 исторических строк
//     принадлежат двум сохраняемым книгам — не все они лишние);
//   • строки с `path IS NULL` (9 ba_-строк + 2 синтетические pending,
//     категория К-5 Stage 70): у них нет доказанной artifact-идентичности;
//   • строки с другим/отсутствующим у versioned-брата путём.
function provenNullDuplicateCondition(alias) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(alias))) {
        throw new Error(`provenNullDuplicateCondition: unsafe alias ${JSON.stringify(alias)}`);
    }
    return `EXISTS (
            SELECT 1 FROM scene_assets twin
            WHERE twin.book_id = ${alias}.book_id
              AND twin.chapter_id = ${alias}.chapter_id
              AND twin.scene_id = ${alias}.scene_id
              AND twin.asset_type = ${alias}.asset_type
              AND twin.build_id IS NOT NULL
              AND twin.path IS NOT NULL
              AND twin.path = ${alias}.path
        )`;
}

// Строка УЧАСТВУЕТ в выборке сигнала (не является доказанным NULL-дублем).
// Для LEFT JOIN без строки ассета (alias.* IS NULL) условие истинно:
// `build_id IS NULL` → TRUE, EXISTS по NULL-ключу → FALSE → NOT(FALSE) → TRUE.
function notProvenNullDuplicateCondition(alias) {
    return `NOT (${alias}.build_id IS NULL AND ${provenNullDuplicateCondition(alias)})`;
}

function buildIdFromArtifactPath(artifactPath) {
    if (typeof artifactPath !== 'string' || artifactPath.length === 0) return null;
    const root = nodePath.resolve(runtimeConfig.OUTPUT_DIR);
    let resolved;
    try {
        resolved = nodePath.resolve(artifactPath);
    } catch (_) {
        return null;
    }
    if (!resolved.startsWith(root + nodePath.sep)) return null;
    const relative = resolved.slice(root.length + 1);
    const separatorIndex = relative.indexOf(nodePath.sep);
    if (separatorIndex <= 0 || separatorIndex === relative.length - 1) return null;
    const buildDir = relative.slice(0, separatorIndex);
    return buildDir.length > 0 ? buildDir : null;
}

function upsertAssetParams(asset) {
    const {
        book_id, chapter_id, scene_id, asset_type,
        path = null, duration_sec = null, width = null, height = null,
        format = null, sample_rate = null, channel_count = null,
        chunks = null, build_id = null, scene_hash = null,
        scene_content_version = null, scene_audio_config_version = null,
        status = 'pending', error = null, metadata = null,
    } = asset;
    return {
        book_id, chapter_id, scene_id, asset_type,
        path, duration_sec, width, height,
        format, sample_rate, channel_count,
        chunks, build_id, scene_hash,
        scene_content_version, scene_audio_config_version,
        status, error, metadata,
    };
}

async function upsertAssetWithNullBuildId(asset) {
    const {
        book_id, chapter_id, scene_id, asset_type,
        path, duration_sec, width, height,
        format, sample_rate, channel_count,
        chunks, scene_hash,
        scene_content_version, scene_audio_config_version,
        status, error, metadata,
    } = upsertAssetParams(asset);

    const values = [
        book_id, chapter_id, scene_id, asset_type,
        path, duration_sec, width, height,
        format, sample_rate, channel_count,
        chunks ? JSON.stringify(chunks) : null, scene_hash,
        scene_content_version, scene_audio_config_version,
        status, error,
        metadata ? JSON.stringify(metadata) : null,
    ];

    return withTransaction(async (client) => {
        await lockNullBuildKey(client, book_id, chapter_id, scene_id, asset_type);

        const updated = await client.query(`
            UPDATE scene_assets SET
                path = COALESCE($5, path),
                duration_sec = COALESCE($6, duration_sec),
                width = COALESCE($7, width),
                height = COALESCE($8, height),
                format = COALESCE($9, format),
                sample_rate = COALESCE($10, sample_rate),
                channel_count = COALESCE($11, channel_count),
                chunks = COALESCE($12::jsonb, chunks),
                scene_hash = COALESCE($13, scene_hash),
                scene_content_version = COALESCE($14, scene_content_version),
                scene_audio_config_version = COALESCE($15, scene_audio_config_version),
                status = $16,
                error = $17,
                metadata = COALESCE($18::jsonb, metadata),
                updated_at = EXTRACT(EPOCH FROM NOW())::bigint
            WHERE id = (
                SELECT id FROM scene_assets
                WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3 AND asset_type = $4
                  AND build_id IS NULL
                ORDER BY updated_at DESC, id DESC
                LIMIT 1
            )
            RETURNING *
        `, values);
        if (updated.rows[0]) return rowToAsset(updated.rows[0]);

        const inserted = await client.query(`
            INSERT INTO scene_assets (
                book_id, chapter_id, scene_id, asset_type,
                path, duration_sec, width, height,
                format, sample_rate, channel_count,
                chunks, scene_hash,
                scene_content_version, scene_audio_config_version,
                status, error, metadata,
                updated_at
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18::jsonb,
                    EXTRACT(EPOCH FROM NOW())::bigint)
            RETURNING *
        `, values);
        return rowToAsset(inserted.rows[0]);
    });
}

async function upsertAsset(asset) {
    const params = upsertAssetParams(asset);
    const {
        book_id, chapter_id, scene_id, asset_type,
        path, duration_sec, width, height,
        format, sample_rate, channel_count,
        chunks, build_id, scene_hash,
        scene_content_version, scene_audio_config_version,
        status, error, metadata,
    } = params;

    if (build_id == null) {
        return upsertAssetWithNullBuildId(params);
    }

    const result = await query(`
        INSERT INTO scene_assets (
            book_id, chapter_id, scene_id, asset_type,
            path, duration_sec, width, height,
            format, sample_rate, channel_count,
            chunks, build_id, scene_hash,
            scene_content_version, scene_audio_config_version,
            status, error, metadata,
            updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19::jsonb,
                EXTRACT(EPOCH FROM NOW())::bigint)
        ON CONFLICT(book_id, chapter_id, scene_id, asset_type, build_id) DO UPDATE SET
            path = COALESCE(EXCLUDED.path, scene_assets.path),
            duration_sec = COALESCE(EXCLUDED.duration_sec, scene_assets.duration_sec),
            width = COALESCE(EXCLUDED.width, scene_assets.width),
            height = COALESCE(EXCLUDED.height, scene_assets.height),
            format = COALESCE(EXCLUDED.format, scene_assets.format),
            sample_rate = COALESCE(EXCLUDED.sample_rate, scene_assets.sample_rate),
            channel_count = COALESCE(EXCLUDED.channel_count, scene_assets.channel_count),
            chunks = COALESCE(EXCLUDED.chunks, scene_assets.chunks),
            scene_hash = COALESCE(EXCLUDED.scene_hash, scene_assets.scene_hash),
            scene_content_version = COALESCE(EXCLUDED.scene_content_version, scene_assets.scene_content_version),
            scene_audio_config_version = COALESCE(EXCLUDED.scene_audio_config_version, scene_assets.scene_audio_config_version),
            status = EXCLUDED.status,
            error = EXCLUDED.error,
            metadata = COALESCE(EXCLUDED.metadata, scene_assets.metadata),
            updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        RETURNING *
    `, [
        book_id, chapter_id, scene_id, asset_type,
        path, duration_sec, width, height,
        format, sample_rate, channel_count,
        chunks ? JSON.stringify(chunks) : null,
        build_id, scene_hash,
        scene_content_version, scene_audio_config_version,
        status, error,
        metadata ? JSON.stringify(metadata) : null,
    ]);
    return rowToAsset(result.rows[0]);
}

async function markReady(bookId, chapterId, sceneId, assetType, artifactPath, extras = {}) {
    const extrasWithBuildId = (extras && extras.build_id != null)
        ? extras
        : { ...extras, build_id: buildIdFromArtifactPath(artifactPath) };
    return upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId, asset_type: assetType,
        path: artifactPath, status: 'ready', ...extrasWithBuildId,
    });
}

async function markStale(bookId, chapterId, sceneId, assetType, buildId = null) {
    const where = ['book_id = $1', 'chapter_id = $2', 'scene_id = $3', 'asset_type = $4'];
    const params = [bookId, chapterId, sceneId, assetType];
    if (buildId) {
        where.push('build_id = $5');
        params.push(buildId);
    }
    const result = await query(`
        UPDATE scene_assets SET status = 'stale', updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE ${where.join(' AND ')}
    `, params);
    return result.rowCount || 0;
}

// ── Stage 50: dispatch-time scene-version stamping ────
// Делает scene_assets.scene_content_version / scene_audio_config_version
// семантикой «версия контента, под которую СТАРТОВАЛА эта генерация»:
//   • version gate в completeStage сравнивает версию строки с текущей
//     версией сцены — до фикса строка вообще не штамповалась при
//     генерации (только book-sync при stale-marking), поэтому после
//     перегенерации постиравшийся gate навсегда возвращал DIRTY
//     (риск бесконечного re-dispatch после convergence-fix stage 50);
//   • повторная регенерация после genuine stale штампует актуальную
//     версию → gate пропускает READY ровно один раз (сходимость).
// UPDATE-first по ВСЕМ строкам ассета (включая legacy-дубли с NULL
// build_id — ON CONFLICT с NULL в Postgres не матчится, INSERT плодил
// бы дубли; в production уже 450/503 строк с NULL build_id). Если строк
// нет вообще (первая генерация versioned-книги) — синтетическая pending-
// строка со штампом, по образцу book-sync.markSceneAssetsStale (R15+);
// для книг без строки в scenes (legacy) SELECT даёт 0 строк → no-op.
async function stampSceneVersionsForDispatch(bookId, chapterId, sceneId, assetType) {
    const updateResult = await query(`
        UPDATE scene_assets sa
        SET scene_content_version = sv.content_version,
            scene_audio_config_version = sv.audio_config_version,
            updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        FROM scenes sv
        WHERE sa.book_id = $1 AND sa.chapter_id = $2 AND sa.scene_id = $3
          AND sa.asset_type = $4
          AND sv.book_id = $1 AND sv.chapter_id = $2 AND sv.scene_id = $3
    `, [bookId, chapterId, sceneId, assetType]);
    if ((updateResult.rowCount || 0) > 0) {
        return { stamped: updateResult.rowCount, inserted: 0 };
    }

    return withTransaction(async (client) => {
        await lockNullBuildKey(client, bookId, chapterId, sceneId, assetType);

        const recheck = await client.query(`
            UPDATE scene_assets sa
            SET scene_content_version = sv.content_version,
                scene_audio_config_version = sv.audio_config_version,
                updated_at = EXTRACT(EPOCH FROM NOW())::bigint
            FROM scenes sv
            WHERE sa.book_id = $1 AND sa.chapter_id = $2 AND sa.scene_id = $3
              AND sa.asset_type = $4
              AND sv.book_id = $1 AND sv.chapter_id = $2 AND sv.scene_id = $3
        `, [bookId, chapterId, sceneId, assetType]);
        if ((recheck.rowCount || 0) > 0) {
            return { stamped: recheck.rowCount, inserted: 0 };
        }

        const insertResult = await client.query(`
            INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, status,
                                      scene_content_version, scene_audio_config_version, updated_at)
            SELECT $1, $2, $3, $4, 'pending',
                   sv.content_version, sv.audio_config_version,
                   EXTRACT(EPOCH FROM NOW())::bigint
            FROM scenes sv
            WHERE sv.book_id = $1 AND sv.chapter_id = $2 AND sv.scene_id = $3
              AND NOT EXISTS (
                  SELECT 1 FROM scene_assets sa
                  WHERE sa.book_id = $1 AND sa.chapter_id = $2 AND sa.scene_id = $3
                    AND sa.asset_type = $4 AND sa.build_id IS NULL
              )
            ON CONFLICT DO NOTHING
        `, [bookId, chapterId, sceneId, assetType]);
        return { stamped: 0, inserted: insertResult.rowCount || 0 };
    });
}

// Stage 76 (К-5 предотвращение ре-создания): синтетическая NULL-строка больше
// не вставляется, когда у ключа уже есть versioned-строки (build_id IS NOT NULL).
// unique-ключ (book, chapter, scene, asset_type, build_id) не матчит NULL, поэтому
// прежний INSERT плодил новую NULL-строку при каждом genuine edit versioned-сцены —
// ровно та ре-семейство, которую мигрирует Stage 75. Теперь ветка действий:
//   1. нет строки в scenes → no-op (legacy, без изменений);
//   2. есть NULL-строки ключа → обновить ИХ (как раньше; поведение для текущего
//      production-форма ba_ с NULL+versioned не меняется);
//   3. есть versioned-строки → обновить ВСЕ их (status→stale + штампы сцен),
//      INSERT запрещён: ни одна строка не удаляется, ни один build не выбирается
//      молча (fail-closed при нескольких builds — все консервативно stale,
//      канонический build определяет только следующий dispatch через markReady);
//   4. строк нет вообще (legacy-сцена без build-контекста) → прежний
//      синтетический NULL-INSERT (R15+ семантика маркера версии сохранена).
async function ensureSyntheticStaleAsset(bookId, chapterId, sceneId, assetType = 'audio') {
    return withTransaction(async (client) => {
        await lockNullBuildKey(client, bookId, chapterId, sceneId, assetType);

        const scene = await client.query(`
            SELECT content_version, audio_config_version FROM scenes
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        `, [bookId, chapterId, sceneId]);
        if (scene.rows.length === 0) return 0;
        const { content_version, audio_config_version } = scene.rows[0];

        const updated = await client.query(`
            UPDATE scene_assets SET
                status = 'stale',
                scene_content_version = $4,
                scene_audio_config_version = $5,
                updated_at = EXTRACT(EPOCH FROM NOW())::bigint
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
              AND asset_type = $6 AND build_id IS NULL
            RETURNING id
        `, [bookId, chapterId, sceneId, content_version, audio_config_version, assetType]);
        if ((updated.rowCount || 0) > 0) return updated.rowCount;

        const versioned = await client.query(`
            UPDATE scene_assets SET
                status = 'stale',
                scene_content_version = $4,
                scene_audio_config_version = $5,
                updated_at = EXTRACT(EPOCH FROM NOW())::bigint
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
              AND asset_type = $6 AND build_id IS NOT NULL
            RETURNING id
        `, [bookId, chapterId, sceneId, content_version, audio_config_version, assetType]);
        if ((versioned.rowCount || 0) > 0) return versioned.rowCount;

        const inserted = await client.query(`
            INSERT INTO scene_assets (book_id, chapter_id, scene_id, asset_type, status,
                                      scene_content_version, scene_audio_config_version, updated_at)
            VALUES ($1, $2, $3, $6, 'stale', $4, $5, EXTRACT(EPOCH FROM NOW())::bigint)
            RETURNING id
        `, [bookId, chapterId, sceneId, content_version, audio_config_version, assetType]);
        return inserted.rowCount || 0;
    });
}

async function markFailed(bookId, chapterId, sceneId, assetType, error, buildId = null) {
    return upsertAsset({
        book_id: bookId, chapter_id: chapterId, scene_id: sceneId, asset_type: assetType,
        status: 'failed', error, build_id: buildId,
    });
}

async function getAsset(bookId, chapterId, sceneId, assetType, buildId = null) {
    const where = ['book_id = $1', 'chapter_id = $2', 'scene_id = $3', 'asset_type = $4'];
    const params = [bookId, chapterId, sceneId, assetType];
    if (buildId) {
        where.push('build_id = $5');
        params.push(buildId);
    }
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE ${where.join(' AND ')}
        ORDER BY (build_id IS NOT NULL) DESC, updated_at DESC
        LIMIT 1
    `, params);
    return rowToAsset(result.rows[0]);
}

async function getSceneAssets(bookId, chapterId, sceneId) {
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        ORDER BY asset_type
    `, [bookId, chapterId, sceneId]);
    return result.rows.map(rowToAsset);
}

// A1 (stage147): fallback-чтение version-gate — РОВНО строка того же ключа
// с build_id IS NULL (семейство Stage 73/76: в production 450/503 строк).
// getAsset с truthy buildId фильтрует `build_id = $5` и такую строку не
// видит, а markReady (единственный писатель build_id) вызывается ПОСЛЕ gate —
// замкнутый цикл DIRTY каждые 5 с (stage146 §5.4). Сознательно НЕ «последняя
// строка любого билда» (поведение getAsset при buildId=null): строка другого
// билда никогда не доказывает версии этого ключа.
async function getAssetNullBuild(bookId, chapterId, sceneId, assetType) {
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
          AND asset_type = $4 AND build_id IS NULL
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
    `, [bookId, chapterId, sceneId, assetType]);
    return rowToAsset(result.rows[0]);
}

async function getAssetsByType(bookId, assetType) {
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1 AND asset_type = $2
        ORDER BY chapter_id, scene_id
    `, [bookId, assetType]);
    return result.rows.map(rowToAsset);
}

async function getAssetsByBuild(buildId) {
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE build_id = $1
        ORDER BY chapter_id, scene_id, asset_type
    `, [buildId]);
    return result.rows.map(rowToAsset);
}

async function getStaleAssets(bookId) {
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1 AND status = 'stale'
        ORDER BY updated_at
    `, [bookId]);
    return result.rows.map(rowToAsset);
}

async function getOutdatedByHash(bookId, currentHashes) {
    if (!currentHashes || currentHashes.size === 0) return [];
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1
    `, [bookId]);
    const outdated = [];
    for (const row of result.rows) {
        const asset = rowToAsset(row);
        const key = `${asset.chapter_id}:${asset.scene_id}`;
        const current = currentHashes.get(key);
        if (current && asset.scene_hash && asset.scene_hash !== current && asset.status === 'ready') {
            outdated.push(asset);
        }
    }
    return outdated;
}

/**
 * R15: Find assets that are outdated based on version comparison.
 * An asset is outdated if its stored version is less than the scene's
 * current version. This is the version-based alternative to hash comparison.
 *
 * @param {string} bookId
 * @param {Map<string, {content_version: number, audio_config_version: number}>} sceneVersions
 *   Map of "chapter_id:scene_id" -> { content_version, audio_config_version }
 * @returns {Promise<Array>} outdated assets
 */
async function getOutdatedByVersions(bookId, sceneVersions) {
    if (!sceneVersions || sceneVersions.size === 0) return [];
    const result = await query(`
        SELECT * FROM scene_assets
        WHERE book_id = $1
    `, [bookId]);
    const outdated = [];
    for (const row of result.rows) {
        const asset = rowToAsset(row);
        const key = `${asset.chapter_id}:${asset.scene_id}`;
        const sv = sceneVersions.get(key);
        if (!sv || asset.status !== 'ready') continue;

        // Check content version
        if (asset.scene_content_version != null && sv.content_version != null &&
            asset.scene_content_version < sv.content_version) {
            outdated.push({
                ...asset,
                _outdated_reason: 'content_version',
                _expected_version: sv.content_version,
            });
            continue;
        }

        // Check audio config version
        if (asset.scene_audio_config_version != null && sv.audio_config_version != null &&
            asset.scene_audio_config_version < sv.audio_config_version) {
            outdated.push({
                ...asset,
                _outdated_reason: 'audio_config_version',
                _expected_version: sv.audio_config_version,
            });
        }
    }
    return outdated;
}

async function isSceneReady(bookId, chapterId, sceneId, assetType) {
    const asset = await getAsset(bookId, chapterId, sceneId, assetType);
    return !!(asset && asset.status === 'ready' && asset.path);
}

async function deleteSceneAssets(bookId, chapterId, sceneId) {
    await query(`
        DELETE FROM scene_assets
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);
}

async function deleteBookAssets(bookId) {
    await query('DELETE FROM scene_assets WHERE book_id = $1', [bookId]);
}

async function deleteBuildAssets(buildId) {
    await query('DELETE FROM scene_assets WHERE build_id = $1', [buildId]);
}

async function getBookAssetSummary(bookId) {
    const [total, ready, stale, pending, failed, placeholder] = await Promise.all([
        query('SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1', [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'ready'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'stale'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'pending'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'failed'", [bookId]),
        query("SELECT COUNT(*)::int as c FROM scene_assets WHERE book_id = $1 AND status = 'placeholder'", [bookId]),
    ]);
    return {
        total: total.rows[0].c,
        ready: ready.rows[0].c,
        stale: stale.rows[0].c,
        pending: pending.rows[0].c,
        failed: failed.rows[0].c,
        placeholder: placeholder.rows[0].c,
    };
}

/**
 * R13/R14: Bump version counters for dirty scenes.
 * Shared between PUT and /regenerate to eliminate duplicate SQL.
 * First ensures the row exists (UPSERT) so the UPDATE has effect.
 *
 * @param {string} bookId
 * @param {Array<{chapter_id:string, scene_id:string, reason:string, dirty_layers:string[]}>} dirtyScenes
 * @returns {Promise<number>} Number of scenes with bumped versions
 */
async function bumpSceneVersions(bookId, dirtyScenes) {
    let bumped = 0;
    for (const ds of dirtyScenes) {
        if (ds.reason === 'removed') continue;
        const bumpContent = ds.dirty_layers.includes('image') || ds.dirty_layers.includes('video');
        const bumpAudio = ds.dirty_layers.includes('audio');
        if (bumpContent || bumpAudio) {
            // First ensure the row exists (UPSERT — no-op if already present)
            await ensureSceneRow(bookId, ds.chapter_id, ds.scene_id);

            // R4.1: When bumping version, also set is_dirty = TRUE so the
            // persistent dirty flag survives Redis crashes. The scheduler
            // checks this flag as secondary dirty detection.
            const setClauses = [
                'is_dirty = TRUE',
                'updated_at = EXTRACT(EPOCH FROM NOW())::bigint'
            ];
            if (bumpContent) setClauses.push('content_version = content_version + 1');
            if (bumpAudio) setClauses.push('audio_config_version = audio_config_version + 1');
            await query(`
                UPDATE scenes
                SET ${setClauses.join(', ')}
                WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
            `, [bookId, ds.chapter_id, ds.scene_id]);
            bumped++;
        }
    }
    return bumped;
}

/**
 * Ensure a row exists in the scenes table for a given scene.
 * Uses INSERT … ON CONFLICT DO NOTHING to create the row if missing.
 * This is necessary because bumpSceneVersions and setDirtyUnitIds
 * both UPDATE scenes — without an existing row, the UPDATE is a no-op.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 */
async function ensureSceneRow(bookId, chapterId, sceneId) {
    await query(`
        INSERT INTO scenes (book_id, chapter_id, scene_id, content_version, audio_config_version, dirty_unit_ids, updated_at)
        VALUES ($1, $2, $3, 1, 1, '{}', EXTRACT(EPOCH FROM NOW())::bigint)
        ON CONFLICT (book_id, chapter_id, scene_id) DO NOTHING
    `, [bookId, chapterId, sceneId]);
}

/**
 * Set per-unit dirty IDs for a scene in PG.
 * These are the unit_ids whose content changed — used by executeImageDispatch
 * for granular force-regen instead of regenerating ALL units.
 *
 * Empty array = regenerate all units (no granular info available).
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @param {string[]} unitIds - Array of changed unit IDs (empty = all units stale)
 */
async function setDirtyUnitIds(bookId, chapterId, sceneId, unitIds) {
    const ids = (unitIds && Array.isArray(unitIds) && unitIds.length > 0) ? unitIds : [];
    // First ensure the row exists (UPSERT — no-op if already present)
    await ensureSceneRow(bookId, chapterId, sceneId);
    if (ids.length === 0) {
        // Empty array = no granular info; set as-is (backward compat)
        await query(`
            UPDATE scenes
            SET dirty_unit_ids = '{}', updated_at = EXTRACT(EPOCH FROM NOW())::bigint
            WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
        `, [bookId, chapterId, sceneId]);
        return;
    }
    // Merge with existing dirty_unit_ids (UNION + DISTINCT) instead of replacing.
    // This prevents losing previously saved dirty units when the user saves
    // multiple units in the same scene sequentially.
    await query(`
        UPDATE scenes
        SET dirty_unit_ids = (
            SELECT array_agg(DISTINCT x) FROM (
                SELECT unnest($4::text[])
                UNION
                SELECT unnest(COALESCE(dirty_unit_ids, '{}'::text[]))
            ) AS t(x)
        ), updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId, ids]);
}

/**
 * Get per-unit dirty IDs for a scene from PG.
 * Returns the array of unit_ids that need regeneration, or null if no row exists.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 * @returns {Promise<string[]|null>}
 */
async function getDirtyUnitIds(bookId, chapterId, sceneId) {
    const result = await query(`
        SELECT dirty_unit_ids FROM scenes
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);
    if (result.rows.length > 0 && result.rows[0].dirty_unit_ids) {
        return result.rows[0].dirty_unit_ids;
    }
    return null;
}

/**
 * Clear per-unit dirty IDs for a scene in PG.
 * Called AFTER executeImageDispatch reads and dispatches dirty units,
 * so the next scheduler tick does NOT re-delete already-regenerated files.
 *
 * @param {string} bookId
 * @param {string} chapterId
 * @param {string} sceneId
 */
/**
 * R4.1: Clear the persistent dirty flag after regeneration completes.
 * Called from scene-orchestrator after video callback succeeds.
 */
async function clearDirtyFlag(bookId, chapterId, sceneId) {
    await query(`
        UPDATE scenes
        SET is_dirty = FALSE, updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);
}

/**
 * R4.1: Get scenes whose version suggests they need regeneration.
 * A scene is "dirty by version" if its is_dirty flag is TRUE OR
 * if any asset has scene_content_version < scenes.content_version.
 * This is the primary dirty detection mechanism — independent of Redis.
 *
 * @param {string} bookId
 * @returns {Promise<Array<{chapter_id: string, scene_id: string, reason: string}>>}
 */
async function getDirtyScenesByVersion(bookId) {
    // Stage 73: version-mismatch — сигнал только от строк, не являющихся
    // доказанными NULL-дублями (см. provenNullDuplicateCondition). Дубль с
    // устаревшими штампами не должен помечать ключ stale, если у него есть
    // versioned-эквивалент: его собственные штампы/статус участвуют в
    // выборке независимо. `s.is_dirty` — scene-level сигнал, остаётся как был.
    const notDup = notProvenNullDuplicateCondition('a');
    const result = await query(`
        SELECT DISTINCT s.book_id, s.chapter_id, s.scene_id, s.content_version, s.audio_config_version,
               s.is_dirty,
               a.scene_content_version, a.scene_audio_config_version, a.asset_type, a.status
        FROM scenes s
        LEFT JOIN scene_assets a ON a.book_id = s.book_id
            AND a.chapter_id = s.chapter_id
            AND a.scene_id = s.scene_id
        WHERE s.book_id = $1
          AND (
              s.is_dirty = TRUE
              OR (
                  a.status = 'ready'
                  AND (
                      (a.scene_content_version IS NOT NULL AND a.scene_content_version < s.content_version)
                      OR
                      (a.scene_audio_config_version IS NOT NULL AND a.scene_audio_config_version < s.audio_config_version)
                  )
                  AND ${notDup}
              )
          )
        ORDER BY s.chapter_id, s.scene_id
    `, [bookId]);

    return result.rows.map(row => ({
        book_id: row.book_id,
        chapter_id: row.chapter_id,
        scene_id: row.scene_id,
        reason: row.is_dirty ? 'is_dirty_flag' : 'version_mismatch',
        content_version: row.content_version,
        audio_config_version: row.audio_config_version,
        scene_content_version: row.scene_content_version,
        scene_audio_config_version: row.scene_audio_config_version,
        asset_type: row.asset_type,
        status: row.status,
    }));
}

async function clearDirtyUnitIds(bookId, chapterId, sceneId) {
    await ensureSceneRow(bookId, chapterId, sceneId);
    await query(`
        UPDATE scenes
        SET dirty_unit_ids = '{}', updated_at = EXTRACT(EPOCH FROM NOW())::bigint
        WHERE book_id = $1 AND chapter_id = $2 AND scene_id = $3
    `, [bookId, chapterId, sceneId]);
}

/**
 * Per-scene version rows for the version-introspection surface
 * (GET /book/:bookId/versions). Raw rows — the caller builds the view.
 */
async function getSceneVersions(bookId) {
    const result = await query(`
        SELECT chapter_id, scene_id, content_version, audio_config_version, scene_hash, updated_at
        FROM scenes
        WHERE book_id = $1
        ORDER BY chapter_id, scene_id
    `, [bookId]);
    return result.rows;
}

/**
 * Per-asset version rows for the version-introspection surface
 * (GET /book/:bookId/versions). Raw rows — the caller builds the view.
 */
async function getSceneAssetVersions(bookId) {
    const result = await query(`
        SELECT chapter_id, scene_id, asset_type, scene_content_version, scene_audio_config_version, status, build_id
        FROM scene_assets
        WHERE book_id = $1
        ORDER BY chapter_id, scene_id, asset_type
    `, [bookId]);
    return result.rows;
}

/**
 * Scenes flagged dirty through the persistent PG markers:
 * is_dirty = TRUE or a non-empty dirty_unit_ids array.
 * Fallback dirty source for /regenerate when the diff path is empty.
 */
async function getFlaggedDirtyScenes(bookId) {
    const result = await query(`
        SELECT chapter_id, scene_id, is_dirty, dirty_unit_ids
        FROM scenes
        WHERE book_id = $1
          AND (is_dirty = TRUE OR (dirty_unit_ids IS NOT NULL AND array_length(dirty_unit_ids, 1) > 0))
        ORDER BY chapter_id, scene_id
    `, [bookId]);
    return result.rows;
}

module.exports = {
    upsertAsset,
    markReady,
    markStale,
    markFailed,
    // Stage 73: shared SQL predicates for the "proven NULL duplicate" rule
    provenNullDuplicateCondition,
    notProvenNullDuplicateCondition,
    stampSceneVersionsForDispatch,
    ensureSyntheticStaleAsset,
    getAsset,
    getAssetNullBuild,
    getSceneAssets,
    getAssetsByType,
    getAssetsByBuild,
    getStaleAssets,
    getOutdatedByHash,
    getOutdatedByVersions,
    bumpSceneVersions,
    ensureSceneRow,
    setDirtyUnitIds,
    getDirtyUnitIds,
    clearDirtyUnitIds,
    clearDirtyFlag,
    getDirtyScenesByVersion,
    getSceneVersions,
    getSceneAssetVersions,
    getFlaggedDirtyScenes,
    isSceneReady,
    deleteSceneAssets,
    deleteBookAssets,
    deleteBuildAssets,
    getBookAssetSummary,
};
