// ======================================================
// «■ Снять» on a stopped Generator row (2026-11-05, задача K)
// ======================================================
// POST /cancel-worker {task_id} for a task that stopped without finishing
// (interrupted / blocked / failed) cancels ONLY that task: registry + PG
// generation_tasks → cancelled, its leftovers (active index, lease, PG
// pending) released by the same task-scoped path as an active row, no
// book-wide cancel flag / tombstone, other tasks of the book untouched.
// Repeat → 200, same answer. completed → untouched.
//
// Real modules: generation-routes cancel-worker handler, stage-cancellation,
// progress-panel route, orchestration runtime, task registry over the Redis
// mock, PG repositories against the TEST database (test-db-safety guards it).

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');

const orchestration = require('@animastor/orchestration');
const scheduler = orchestration.runtime.scheduler;
const sceneState = require('../src/state/scene-state');
const activeScenes = require('../node_modules/@animastor/orchestration/src/runtime/active-scenes-index');
const generationProgress = require('../src/services/generation-progress');
const stageCancellation = require('../src/services/stage-cancellation.cjs');
const taskRepo = require('../src/storage/postgres/repositories/task-repo');
const { query } = require('../src/storage/postgres/database');

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const CH = 'ch-stop';
const S1 = 'sc-stop-1';
const S2 = 'sc-stop-2';

function book(tag) { return `stoprow-${tag}-${RUN}`; }

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function harness(redis) {
    const posts = new Map();
    const gets = new Map();
    const app = {
        post(path, h) { posts.set(path, h); },
        get(path, h) { gets.set(path, h); },
        put() {},
        delete() {},
    };
    const sessionCalls = [];
    require('../src/routes/book/generation-routes.cjs')(app, redis, {
        config: { HUB_URL: 'http://127.0.0.1:9', GPU_HUB_API_KEY: null },
        runtime: { scheduler, sceneWindow: { setCancelFlag: async () => { sessionCalls.push('cancel-flag'); } } },
        utils: { log: () => {} },
        stageCancellation,
        agentSessionControl: { cancelSessions: async () => { sessionCalls.push('vbook-sessions'); } },
    });
    require('../src/routes/book/progress-panel.cjs')(app, redis, {
        state: sceneState,
        activeScenes,
        getAllChunks: async () => [],
        getChunk: async () => null,
        iuRepo: { getImageUnitsForScene: async () => [] },
        utils: { log: () => {} },
    });
    const cancelWorker = async (bookId, body) => {
        const res = createResponse();
        await posts.get('/api/v1/book/:bookId/cancel-worker')({ params: { bookId }, body }, res);
        return res;
    };
    const panel = async (bookId) => {
        const res = createResponse();
        await gets.get('/api/v1/book/:bookId/progress-panel')({ params: { bookId }, query: {} }, res);
        return res.body;
    };
    return { cancelWorker, panel, sessionCalls };
}

async function command(redis, bookId, type, scenes) {
    const [task] = await generationProgress.createTasks(redis, bookId, [type],
        { scope: 'current_scene', chapterId: scenes[0].chapter_id, sceneId: scenes[0].scene_id }, scenes);
    for (const s of scenes) {
        await taskRepo.createTask(task.task_id, bookId, s.chapter_id, s.scene_id, type, { scope: 'current_scene' }, null);
    }
    await taskRepo.updateTaskStatus(task.task_id, 'running');
    return task;
}

async function pgStatuses(taskId) {
    const r = await query('SELECT status FROM generation_tasks WHERE task_id = $1', [taskId]);
    return r.rows.map(x => x.status);
}

async function activeKeysOf(redis, bookId) {
    return (await redis.smembers(scheduler.ACTIVE_SCENES_KEY)).filter(k => k.startsWith(`${bookId}:`));
}

/** Push the registry clock past TERMINAL_RETENTION_MS for one task. */
async function ageTerminal(redis, bookId, taskId) {
    const t = await generationProgress.getTask(redis, bookId, taskId);
    const old = Date.now() - generationProgress.TERMINAL_RETENTION_MS - 1000;
    await generationProgress.updateTask(redis, bookId, taskId, {
        ...(t.cancelled_at ? { cancelled_at: old } : {}),
        ...(t.completed_at ? { completed_at: old } : {}),
    });
}

describe('cancel-worker: «Снять» a stopped task (2026-11-05)', function () {
    this.timeout(20000);
    const books = new Set();
    let redis;

    beforeEach(() => { redis = createMockRedis(); });

    after(async () => {
        for (const b of books) {
            try { await query('DELETE FROM generation_tasks WHERE book_id = $1', [b]); } catch (_) {}
            try { await query('DELETE FROM scene_assets WHERE book_id = $1', [b]); } catch (_) {}
        }
    });

    it('interrupted → «Снять» → cancelled (registry + PG); the row never comes back; other tasks untouched; repeat → 200', async () => {
        const b = book('interrupted');
        books.add(b);
        const h = harness(redis);
        const mine = await command(redis, b, 'audio', [{ chapter_id: CH, scene_id: S1 }]);
        const otherAudio = await command(redis, b, 'audio', [{ chapter_id: CH, scene_id: S2 }]);
        const otherImage = await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S1 }]);
        // Backend restart: every active task → interrupted. Then the user
        // restarts the image layer of S1 (active again) and the other audio
        // stays interrupted.
        await generationProgress.interruptActiveTasks(redis, b);
        await generationProgress.updateTask(redis, b, otherImage.task_id, { status: 'active' });
        // Leftover of the interrupted run: S1 still in the active index.
        await scheduler.addSceneToActiveIndex(redis, b, CH, S1);

        const before = await h.panel(b);
        expect(before.tasks.map(t => `${t.task_id}:${t.status}`)).to.have.members([
            `${mine.task_id}:interrupted`, `${otherAudio.task_id}:interrupted`, `${otherImage.task_id}:active`,
        ]);

        const res = await h.cancelWorker(b, { task_id: mine.task_id });
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.deep.include({ ok: true, book_id: b, task_ids: [mine.task_id] });
        expect(res.body.cancelled).to.deep.equal(['audio']);

        // registry + PG
        expect((await generationProgress.getTask(redis, b, mine.task_id)).status).to.equal('cancelled');
        expect(await pgStatuses(mine.task_id)).to.deep.equal(['cancelled']);
        // other tasks of the book untouched
        expect((await generationProgress.getTask(redis, b, otherAudio.task_id)).status).to.equal('interrupted');
        expect((await generationProgress.getTask(redis, b, otherImage.task_id)).status).to.equal('active');
        expect(await pgStatuses(otherAudio.task_id)).to.deep.equal(['running']);
        expect(await pgStatuses(otherImage.task_id)).to.deep.equal(['running']);
        // S1 stays in the index — the active image task still authorizes it.
        expect(await activeKeysOf(redis, b)).to.deep.equal([`${b}:${CH}:${S1}`]);
        // no book-wide flag / tombstone / vbook leg
        expect(h.sessionCalls).to.deep.equal([]);
        expect(await redis.smembers(`animastor:cancelled-workers:${b}`)).to.deep.equal([]);

        // progress-panel: never a stopped row again — a cancelled one, then gone.
        const after = await h.panel(b);
        const row = after.tasks.find(t => t.task_id === mine.task_id);
        expect(row.status).to.equal('cancelled');
        expect(row.interrupted).to.equal(false);
        await ageTerminal(redis, b, mine.task_id);
        const later = await h.panel(b);
        expect(later.tasks.map(t => t.task_id)).to.have.members([otherAudio.task_id, otherImage.task_id]);

        // repeat (still within retention) → 200, same answer, nothing touched
        const b2 = book('interrupted-repeat');
        books.add(b2);
        const t2 = await command(redis, b2, 'audio', [{ chapter_id: CH, scene_id: S1 }]);
        await generationProgress.interruptActiveTasks(redis, b2);
        const first = await h.cancelWorker(b2, { task_id: t2.task_id });
        const second = await h.cancelWorker(b2, { task_id: t2.task_id });
        expect(second.statusCode).to.equal(200);
        expect(second.body).to.deep.equal(first.body);
        expect((await generationProgress.getTask(redis, b2, t2.task_id)).status).to.equal('cancelled');
    });

    it('blocked and failed → cancelled; the leftover index entry is released', async () => {
        const b = book('blocked-failed');
        books.add(b);
        const h = harness(redis);
        const blocked = await command(redis, b, 'image', [{ chapter_id: CH, scene_id: S1 }]);
        await generationProgress.blockSceneStage(redis, b, CH, S1, 'image', 'no_worker:image');
        const failed = await command(redis, b, 'audio', [{ chapter_id: CH, scene_id: S2 }]);
        await generationProgress.failSceneStage(redis, b, CH, S2, 'audio', { error_class: 'deterministic', error_message: 'bad input' });
        await redis.sadd(scheduler.ACTIVE_SCENES_KEY, `${b}:${CH}:${S1}`);

        const r1 = await h.cancelWorker(b, { task_id: blocked.task_id });
        expect(r1.statusCode).to.equal(200);
        expect(r1.body.task_ids).to.deep.equal([blocked.task_id]);
        expect((await generationProgress.getTask(redis, b, blocked.task_id)).status).to.equal('cancelled');
        expect(await pgStatuses(blocked.task_id)).to.deep.equal(['cancelled']);
        expect(await activeKeysOf(redis, b)).to.deep.equal([]);
        expect((await generationProgress.getTask(redis, b, failed.task_id)).status).to.equal('failed');

        const r2 = await h.cancelWorker(b, { task_id: failed.task_id });
        expect(r2.statusCode).to.equal(200);
        expect(r2.body.task_ids).to.deep.equal([failed.task_id]);
        expect((await generationProgress.getTask(redis, b, failed.task_id)).status).to.equal('cancelled');
        expect(await pgStatuses(failed.task_id)).to.deep.equal(['cancelled']);
        expect(h.sessionCalls).to.deep.equal([]);
    });

    it('completed task is left untouched', async () => {
        const b = book('completed');
        books.add(b);
        const h = harness(redis);
        const t = await command(redis, b, 'audio', [{ chapter_id: CH, scene_id: S1 }]);
        await generationProgress.markCompleted(redis, b, t.task_id);
        await taskRepo.updateTaskStatus(t.task_id, 'completed');

        const res = await h.cancelWorker(b, { task_id: t.task_id });
        expect(res.statusCode).to.equal(200);
        expect(res.body.task_ids).to.deep.equal([]);
        expect((await generationProgress.getTask(redis, b, t.task_id)).status).to.equal('completed');
        expect(await pgStatuses(t.task_id)).to.deep.equal(['completed']);
    });
});
