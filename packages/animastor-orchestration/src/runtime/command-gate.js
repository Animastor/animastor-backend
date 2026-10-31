// ======================================================
// COMMAND GATE — «генерация только по явной команде»
// ======================================================
// Правило владельца (2026-10-31, разбор reports/2026-10-31/
// auto-image-task-ba-incident.md §6/§8): GPU-генерация запускается ТОЛЬКО
// кнопками «аудио» / «картинки» / «всё». Никаких автозапусков следующих
// стадий, никаких фоновых запусков, задачи только на включённые слои.
//
// ИНВАРИАНТ. Сцена×стадия попадает в active index / dispatch ТОЛЬКО когда
// одновременно:
//   1. есть АКТИВНАЯ задача реестра (generation-progress, создаётся явной
//      командой POST /regenerate), в targets которой есть эта сцена и чей
//      type — эта стадия;
//   2. слой стадии включён в layer-config книги;
//   3. у книги нет отмены (cancel flag в Redis / tombstone в PG).
//
// Этот модуль — единственное место, где инвариант вычисляется. Им пользуются:
//   • active-scenes-index.addActiveScene  — запись в active index;
//   • runtime-scheduler.shouldScheduleAssets — выбор стадий для dispatch;
//   • reconciliation-engine — ремонтные фиксы, которые раньше ставили работу;
//   • scene-window.startScene — оконный старт сцены.
//
// Реестр задач читается ТОЛЬКО через ProgressEventsPort (O-5), отмена — через
// PersistencePort (O-2) и cancel flag scene-window; Redis-ключи хост-сервисов
// здесь не появляются. Ошибка чтения реестра — fail-closed (стадия НЕ
// авторизована): без доказанной команды работы нет.
//
// Docs: animastor-docs/architecture/COMMAND_ONLY_GENERATION.md
// ======================================================

const mediaRegistry = require('@animastor/generation').mediaRegistry;
const { lazyHostBinding } = require('../host/host-bindings');
const state = lazyHostBinding('state');
const progressEventsOp = require('./progress-events-port').progressEventsOp;
const persist = require('./persistence-port').persist;

const logPrefix = '[COMMAND-GATE]';

function log(msg) {
    console.log(`${logPrefix} ${msg}`);
}

function warn(msg) {
    console.warn(`${logPrefix} ⚠️ ${msg}`);
}

// ======================================================
// LAYER CONFIG
// ======================================================

/**
 * Read the book layer config (Redis `animastor:layer-config:<book>`).
 * Missing/broken config → every registered layer enabled (registry default).
 */
async function getLayerConfig(redis, bookId) {
    const layerRaw = await redis.get(`animastor:layer-config:${bookId}`);
    if (layerRaw) {
        try { return JSON.parse(layerRaw); } catch (_) { /* fall through to defaults */ }
    }
    const defaults = {};
    for (const t of mediaRegistry.listMediaTypes()) { defaults[`${t}_enabled`] = true; }
    return defaults;
}

function isLayerEnabled(layerCfg, stage) {
    return !layerCfg || layerCfg[`${stage}_enabled`] !== false;
}

// ======================================================
// CANCELLATION
// ======================================================

/**
 * True if the user explicitly cancelled generation for this book (Redis
 * cancel flag and/or PG tombstone). A PG error reads as "not cancelled"
 * (the Redis flag is still honoured) — the same semantics the reconcile
 * resurrection guard always had.
 */
async function isBookCancelled(redis, bookId) {
    try {
        // Lazy: scene-window requires active-scenes-index, which requires
        // this module — resolve at call time to keep the module graph acyclic.
        if (await require('./scene-window').isCancelled(redis, bookId)) return true;
    } catch (_) { /* flag unreadable — fall through to tombstone */ }
    try {
        return !!(await persist('cancel.isCancelled')(bookId));
    } catch (_) {
        return false;
    }
}

// ======================================================
// AUTHORIZATION
// ======================================================

/** Per-pass memo (one scheduler tick / one reconcile pass). */
function createGateCache() {
    return { layer: new Map(), cancelled: new Map() };
}

async function memo(cache, bucket, bookId, fn) {
    if (!cache) return fn();
    if (cache[bucket].has(bookId)) return cache[bucket].get(bookId);
    const value = await fn();
    cache[bucket].set(bookId, value);
    return value;
}

const EMPTY_TASK_STATE = Object.freeze({ managed: false, activeTypes: new Set() });

/**
 * Which stages of one scene are authorized by an explicit command right now.
 *
 * @returns {Promise<{stages:Set<string>, denied:Object<string,string>,
 *   cancelled:boolean, layerCfg:object, taskState:{managed:boolean, activeTypes:Set<string>}}>}
 *   `denied[stage]` ∈ 'cancelled' | 'no_active_task' | 'layer_disabled'.
 */
async function getAuthorizedStages(redis, bookId, chapterId, sceneId, cache = null) {
    const cancelled = await memo(cache, 'cancelled', bookId, () => isBookCancelled(redis, bookId));
    const layerCfg = await memo(cache, 'layer', bookId, () => getLayerConfig(redis, bookId));

    let taskState = EMPTY_TASK_STATE;
    try {
        const ts = await progressEventsOp('getSceneTaskState')(redis, bookId, chapterId, sceneId);
        if (ts && ts.activeTypes instanceof Set) taskState = ts;
    } catch (err) {
        // Fail-closed: an unreadable registry proves no command.
        warn(`task registry unreadable for ${bookId}/${chapterId}/${sceneId}: ${err.message} — no stage authorized`);
    }

    const stages = new Set();
    const denied = {};
    for (const stage of mediaRegistry.listMediaTypes()) {
        if (cancelled) { denied[stage] = 'cancelled'; continue; }
        if (!taskState.activeTypes.has(stage)) { denied[stage] = 'no_active_task'; continue; }
        if (!isLayerEnabled(layerCfg, stage)) { denied[stage] = 'layer_disabled'; continue; }
        stages.add(stage);
    }
    return { stages, denied, cancelled, layerCfg, taskState };
}

/** Is ONE stage of a scene authorized? */
async function isStageAuthorized(redis, bookId, chapterId, sceneId, stage, cache = null) {
    const auth = await getAuthorizedStages(redis, bookId, chapterId, sceneId, cache);
    return auth.stages.has(stage);
}

function describeDenied(denied) {
    return Object.entries(denied || {}).map(([s, r]) => `${s}:${r}`).join(',') || 'none';
}

// ======================================================
// STATE HYGIENE WITHOUT WORK
// ======================================================

/**
 * GENERATING → DIRTY (FSM-valid edge). Used where a dead/unsent generation
 * must be released WITHOUT re-queueing it: without a command a stage may not
 * sit in PENDING (PENDING is "queued work" — the incident's mine).
 * Only GENERATING is touched; every other state is left as-is.
 */
async function rollbackGeneratingToDirty(redis, bookId, chapterId, sceneId, stage, reason) {
    const states = await state.getAssetStates(redis, bookId, chapterId, sceneId);
    const current = states?.[stage];
    if (current !== state.AssetState.GENERATING) {
        return { changed: false, reason: `state_${current || 'new'}` };
    }
    const check = state.validateAssetTransition(current, state.AssetState.DIRTY);
    if (!check.valid) {
        return { changed: false, reason: `invalid_transition:${current}->dirty` };
    }
    await state.unsafeRestoreAssetState(redis, bookId, chapterId, sceneId, stage, state.AssetState.DIRTY);
    log(`${bookId}/${chapterId}/${sceneId} ${stage}: generating → dirty (reason=${reason}) — not re-queued`);
    return { changed: true, from: current, to: state.AssetState.DIRTY };
}

// ======================================================
// NO WORKER → BLOCKED (no auto-retry)
// ======================================================

/**
 * A stage could not be enqueued because no live worker of its type exists.
 * The command that asked for it is BLOCKED (task registry + PG) with the
 * reason «нет воркера <type>»; the stage loses its authorization, so the
 * scheduler never retries it. Only a NEW command retries.
 * Storage writes happen host-side behind ProgressEventsPort.blockSceneStage.
 */
async function blockStageNoWorker(redis, bookId, chapterId, sceneId, stage) {
    const reason = `no_worker:${stage}`;
    let result = { tasks: [] };
    try {
        result = (await progressEventsOp('blockSceneStage')(redis, bookId, chapterId, sceneId, stage, reason)) || result;
    } catch (err) {
        warn(`blockSceneStage failed for ${bookId}/${chapterId}/${sceneId}:${stage}: ${err.message}`);
    }
    const ids = (result.tasks || []).map(t => t.task_id || t).join(',') || 'none';
    log(`BLOCKED ${bookId}/${chapterId}/${sceneId}:${stage} — нет воркера ${stage}; tasks=[${ids}] — no auto-retry, a new command is required`);
    return { reason, ...result };
}

// ======================================================
// FORCE — only for the scene×stage pairs of the command
// ======================================================
// The former `animastor:force-dispatch:<book>` flag bypassed the duplicate/
// lease guards for the WHOLE book for 120 s (incident §6 item 7). The force
// set below holds exactly the scene×stage pairs reset by one regeneration.

const FORCE_STAGES_KEY_PREFIX = 'animastor:force-dispatch-stages:';

function forceStagesKey(bookId) {
    return `${FORCE_STAGES_KEY_PREFIX}${bookId}`;
}

function forceMember(chapterId, sceneId, stage) {
    return JSON.stringify([String(chapterId), String(sceneId), String(stage)]);
}

async function addForceStages(redis, bookId, pairs, ttlSeconds) {
    const members = [];
    for (const p of pairs || []) {
        for (const stage of p.stages || []) members.push(forceMember(p.chapter_id, p.scene_id, stage));
    }
    if (members.length === 0) return 0;
    const key = forceStagesKey(bookId);
    await redis.sadd(key, ...members);
    await redis.expire(key, ttlSeconds);
    return members.length;
}

/** @returns {Promise<Set<string>>} force members of the book (see forceMember). */
async function getForceStages(redis, bookId) {
    try {
        return new Set(await redis.smembers(forceStagesKey(bookId)) || []);
    } catch (_) {
        return new Set();
    }
}

/** Stages of one scene present in a book force set. */
function forcedStagesForScene(forceSet, chapterId, sceneId) {
    const out = new Set();
    if (!forceSet || forceSet.size === 0) return out;
    for (const stage of mediaRegistry.listMediaTypes()) {
        if (forceSet.has(forceMember(chapterId, sceneId, stage))) out.add(stage);
    }
    return out;
}

async function clearForceStages(redis, bookId) {
    try { await redis.del(forceStagesKey(bookId)); } catch (_) { /* best effort */ }
}

module.exports = {
    getLayerConfig,
    isLayerEnabled,
    isBookCancelled,
    createGateCache,
    getAuthorizedStages,
    isStageAuthorized,
    describeDenied,
    rollbackGeneratingToDirty,
    blockStageNoWorker,
    FORCE_STAGES_KEY_PREFIX,
    forceStagesKey,
    forceMember,
    addForceStages,
    getForceStages,
    forcedStagesForScene,
    clearForceStages,
};
