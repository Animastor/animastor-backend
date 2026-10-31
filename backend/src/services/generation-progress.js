// ======================================================
// Independent generation task registry — host Redis adapter (S-4 correction)
// ======================================================
// The pure task-registry domain logic (task ids, scope/target normalization,
// record creation, task-map validation/retention, registry queries) lives in
// the Generation core: generation/generation-progress.js.
//
// THIS module is the host/infrastructure adapter: it owns the Redis key
// namespace (`animastor:generation-progress:*`) and implements the registry
// persistence (HSET/HGET/HGETALL/HDEL/DEL/EXPIRE) over the redis client
// injected by the callers. Redis keys, TTLs, lifecycle/progress behavior and
// the public API are unchanged (S-6 will formalize this seam as a port).

const core = require('@animastor/generation').generationProgress;

const KEY_PREFIX = 'animastor:generation-progress';
const TTL_SECONDS = 4 * 60 * 60;
const TERMINAL_RETENTION_MS = core.TERMINAL_RETENTION_MS;

function key(bookId) {
    return `${KEY_PREFIX}:${bookId}`;
}

async function writeTask(redis, bookId, task) {
    await redis.hset(key(bookId), task.task_id, JSON.stringify(task));
    await redis.expire(key(bookId), TTL_SECONDS);
    return task;
}

async function createTasks(redis, bookId, workerTypes, scope, dirtyScenes) {
    if (!redis || !bookId) return [];
    const created = core.createTaskRecords(workerTypes, scope, dirtyScenes);
    for (const task of created) {
        await writeTask(redis, bookId, task);
    }
    return created;
}

async function listTasks(redis, bookId) {
    if (!redis || !bookId) return [];
    const raw = await redis.hgetall(key(bookId));
    const { tasks, expiredIds } = core.filterTaskMap(raw);
    for (const id of expiredIds) {
        await redis.hdel(key(bookId), id);
    }
    return tasks;
}

async function getTask(redis, bookId, id) {
    if (!redis || !bookId || !id) return null;
    const raw = await redis.hget(key(bookId), id);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        await redis.hdel(key(bookId), id);
        return null;
    }
}

async function updateTask(redis, bookId, id, updates) {
    const task = await getTask(redis, bookId, id);
    if (!task) return null;
    return writeTask(redis, bookId, { ...task, ...updates, task_id: task.task_id || id });
}

async function markCompleted(redis, bookId, id) {
    const task = await getTask(redis, bookId, id);
    if (!task || task.status !== 'active') return task;
    return updateTask(redis, bookId, id, {
        status: 'completed',
        completed_at: Date.now(),
    });
}

async function markCancelled(redis, bookId, id) {
    const task = await getTask(redis, bookId, id);
    if (!task || task.status === 'cancelled') return task;
    return updateTask(redis, bookId, id, {
        status: 'cancelled',
        cancelled_at: Date.now(),
    });
}

async function getSceneTaskState(redis, bookId, chapterId, sceneId) {
    return core.sceneTaskState(await listTasks(redis, bookId), chapterId, sceneId);
}

async function hasActiveTasks(redis, bookId) {
    return core.hasActiveTasks(await listTasks(redis, bookId));
}

async function getActiveTasksByType(redis, bookId, type) {
    return core.activeTasksByType(await listTasks(redis, bookId), type);
}

async function reconcileCompletedTasks(redis, bookId, getAssetStates) {
    if (typeof getAssetStates !== 'function') return [];

    const tasks = (await listTasks(redis, bookId))
        .filter(task => task.status === 'active' && (task.targets || []).length > 0);
    const stateCache = new Map();
    const completed = [];

    for (const task of tasks) {
        let allReady = true;
        for (const target of task.targets) {
            const targetKey = `${target.chapter_id}:${target.scene_id}`;
            let assetStates = stateCache.get(targetKey);
            if (!assetStates) {
                assetStates = await getAssetStates(
                    redis,
                    bookId,
                    target.chapter_id,
                    target.scene_id
                );
                stateCache.set(targetKey, assetStates);
            }
            if (assetStates?.[task.type] !== 'ready') {
                allReady = false;
                break;
            }
        }
        if (!allReady) continue;

        const updated = await markCompleted(redis, bookId, task.task_id);
        if (updated?.status === 'completed') completed.push(updated);
    }

    return completed;
}

function targetsScene(task, chapterId, sceneId) {
    return (task.targets || []).some(t => t.chapter_id === chapterId && t.scene_id === sceneId);
}

/**
 * Command-only generation: a stage could not be enqueued because no live
 * worker of its type exists. Every ACTIVE task of that type targeting the
 * scene becomes `blocked` (reason «нет воркера <type>»). A blocked task is
 * NOT active: it authorizes nothing, so nothing retries it; it stays visible
 * in the progress panel until a new command supersedes it or a cancel.
 * @returns {Promise<{tasks: object[]}>} the tasks that were blocked now.
 */
async function blockSceneStage(redis, bookId, chapterId, sceneId, type, reason) {
    if (!redis || !bookId) return { tasks: [] };
    const blocked = [];
    for (const task of await listTasks(redis, bookId)) {
        if (task.status !== 'active' || task.type !== type) continue;
        if (!targetsScene(task, chapterId, sceneId)) continue;
        const updated = await updateTask(redis, bookId, task.task_id, {
            status: 'blocked',
            blocked_reason: reason || `no_worker:${type}`,
            blocked_at: Date.now(),
            blocked_scene: { chapter_id: chapterId, scene_id: sceneId },
        });
        if (updated) blocked.push(updated);
    }
    return { tasks: blocked };
}

/**
 * Backend start: every task still `active` in the registry belonged to a run
 * the restart interrupted. It becomes `interrupted` (visible, resumable only
 * by a button) — the backend never resumes it by itself.
 * @returns {Promise<object[]>} the interrupted tasks.
 */
async function interruptActiveTasks(redis, bookId) {
    if (!redis || !bookId) return [];
    const out = [];
    for (const task of await listTasks(redis, bookId)) {
        if (task.status !== 'active') continue;
        const updated = await updateTask(redis, bookId, task.task_id, {
            status: 'interrupted',
            interrupted_at: Date.now(),
        });
        if (updated) out.push(updated);
    }
    return out;
}

/** Book ids that have a task-registry hash (SCAN, no KEYS). */
async function listBooksWithTasks(redis) {
    const books = [];
    if (!redis) return books;
    let cursor = '0';
    do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}:*`, 'COUNT', 200);
        cursor = next;
        for (const k of keys || []) books.push(k.slice(KEY_PREFIX.length + 1));
    } while (cursor !== '0');
    return books;
}

/**
 * A new explicit command supersedes the blocked/interrupted tasks of the
 * same worker types on the same scenes: they are dropped from the registry
 * so the panel shows only the new command.
 * @param {string[]} types
 * @param {Array<{chapter_id:string, scene_id:string}>} scenes
 * @returns {Promise<string[]>} removed task ids.
 */
async function removeSupersededTasks(redis, bookId, types, scenes) {
    if (!redis || !bookId) return [];
    const typeSet = new Set(types || []);
    const sceneKeys = new Set((scenes || []).map(s => `${s.chapter_id}:${s.scene_id}`));
    const removed = [];
    for (const task of await listTasks(redis, bookId)) {
        if (task.status !== 'blocked' && task.status !== 'interrupted') continue;
        if (!typeSet.has(task.type)) continue;
        const overlaps = (task.targets || []).some(t => sceneKeys.has(`${t.chapter_id}:${t.scene_id}`));
        if (!overlaps) continue;
        await redis.hdel(key(bookId), task.task_id);
        removed.push(task.task_id);
    }
    return removed;
}

async function removeTask(redis, bookId, id) {
    if (!redis || !bookId || !id) return;
    await redis.hdel(key(bookId), id);
}

async function clear(redis, bookId) {
    if (!redis || !bookId) return;
    await redis.del(key(bookId));
}

module.exports = {
    KEY_PREFIX,
    TTL_SECONDS,
    TERMINAL_RETENTION_MS,
    key,
    createTasks,
    listTasks,
    getTask,
    updateTask,
    markCompleted,
    markCancelled,
    getSceneTaskState,
    hasActiveTasks,
    getActiveTasksByType,
    reconcileCompletedTasks,
    blockSceneStage,
    interruptActiveTasks,
    listBooksWithTasks,
    removeSupersededTasks,
    removeTask,
    clear,
};
