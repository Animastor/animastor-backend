const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');
const sceneState = require('../src/state/scene-state');
const activeScenes = require('../node_modules/@animastor/orchestration/src/runtime/active-scenes-index');
const generationProgress = require('../src/services/generation-progress');

function createResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

function createHarness(redis, chunks, chunkIds) {
    let handler = null;
    const app = {
        get(path, callback) {
            if (path.endsWith('/progress-panel')) handler = callback;
        },
    };
    const deps = {
        state: sceneState,
        activeScenes,
        getAllChunks: async () => chunkIds,
        getChunk: async id => chunks.get(id) || null,
        iuRepo: { getImageUnitsForScene: async () => [] },
        utils: { log: () => {} },
    };
    require('../src/routes/book/progress-panel.cjs')(app, redis, deps);
    return async bookId => {
        const res = createResponse();
        await handler({ params: { bookId }, query: {} }, res);
        return res;
    };
}

function addChunk(chunks, chunkIds, bookId, chapterId, sceneId, index, data) {
    const id = `${bookId}_${chapterId}_${sceneId}_${String(index).padStart(4, '0')}`;
    chunkIds.push(id);
    chunks.set(id, {
        book_id: bookId,
        chapter_id: chapterId,
        scene_id: sceneId,
        build_id: 'build-1',
        chunk_index: String(index).padStart(4, '0'),
        ...data,
    });
}

describe('Progress panel independent generation tasks', () => {
    it('shows Audio and Image tasks with their own targets', async () => {
        const redis = createMockRedis();
        const bookId = 'parallel-types-book';
        const chunks = new Map();
        const chunkIds = [];

        addChunk(chunks, chunkIds, bookId, 'ch-1', 'audio-scene', 1, {
            expected_chunk_count: 2,
            audio_status: 'ready',
            image_status: 'ready',
        });
        addChunk(chunks, chunkIds, bookId, 'ch-1', 'audio-scene', 2, {
            expected_chunk_count: 2,
            audio_status: 'pending',
            image_status: 'ready',
        });
        addChunk(chunks, chunkIds, bookId, 'ch-1', 'image-scene', 1, {
            expected_chunk_count: 1,
            audio_status: 'ready',
            image_status: 'pending',
        });

        await sceneState.unsafeRestoreAssetStates(redis, bookId, 'ch-1', 'audio-scene', {
            audio: sceneState.AssetState.GENERATING,
            image: sceneState.AssetState.READY,
            video: sceneState.AssetState.NEW,
        });
        await sceneState.unsafeRestoreAssetStates(redis, bookId, 'ch-1', 'image-scene', {
            audio: sceneState.AssetState.READY,
            image: sceneState.AssetState.GENERATING,
            video: sceneState.AssetState.NEW,
        });

        const [audioTask] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'audio-scene' },
            [{ chapter_id: 'ch-1', scene_id: 'audio-scene', dirty_layers: ['audio'] }]
        );
        const [imageTask] = await generationProgress.createTasks(
            redis,
            bookId,
            ['image'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'image-scene' },
            [{ chapter_id: 'ch-1', scene_id: 'image-scene', dirty_layers: ['image'] }]
        );

        const res = await createHarness(redis, chunks, chunkIds)(bookId);

        expect(res.statusCode).to.equal(200);
        expect(res.body.tasks).to.have.length(2);
        expect(res.body.tasks.map(task => task.task_id))
            .to.have.members([audioTask.task_id, imageTask.task_id]);

        const audio = res.body.tasks.find(task => task.task_id === audioTask.task_id);
        const image = res.body.tasks.find(task => task.task_id === imageTask.task_id);
        expect(audio).to.include({
            type: 'audio',
            scene_id: 'audio-scene',
            ready: 1,
            total: 2,
            done: false,
        });
        expect(image).to.include({
            type: 'image',
            scene_id: 'image-scene',
            ready: 0,
            total: 1,
            done: false,
        });
    });

    it('keeps two Audio commands as two progress rows', async () => {
        const redis = createMockRedis();
        const bookId = 'parallel-audio-book';
        const chunks = new Map();
        const chunkIds = [];

        addChunk(chunks, chunkIds, bookId, 'ch-1', 'scene-a', 1, {
            expected_chunk_count: 2,
            audio_status: 'ready',
        });
        addChunk(chunks, chunkIds, bookId, 'ch-1', 'scene-a', 2, {
            expected_chunk_count: 2,
            audio_status: 'pending',
        });
        addChunk(chunks, chunkIds, bookId, 'ch-2', 'scene-b', 1, {
            expected_chunk_count: 1,
            audio_status: 'pending',
        });

        await sceneState.unsafeRestoreAssetState(
            redis, bookId, 'ch-1', 'scene-a', 'audio', sceneState.AssetState.GENERATING
        );
        await sceneState.unsafeRestoreAssetState(
            redis, bookId, 'ch-2', 'scene-b', 'audio', sceneState.AssetState.PENDING
        );

        const [firstTask] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-a' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-a', dirty_layers: ['audio'] }]
        );
        const [secondTask] = await generationProgress.createTasks(
            redis,
            bookId,
            ['audio'],
            { scope: 'current_scene', chapterId: 'ch-2', sceneId: 'scene-b' },
            [{ chapter_id: 'ch-2', scene_id: 'scene-b', dirty_layers: ['audio'] }]
        );

        const res = await createHarness(redis, chunks, chunkIds)(bookId);
        const audioRows = res.body.tasks.filter(task => task.type === 'audio');

        expect(audioRows).to.have.length(2);
        expect(audioRows.map(task => task.task_id))
            .to.have.members([firstTask.task_id, secondTask.task_id]);
        expect(audioRows.find(task => task.task_id === firstTask.task_id))
            .to.include({ scene_id: 'scene-a', ready: 1, total: 2 });
        expect(audioRows.find(task => task.task_id === secondTask.task_id))
            .to.include({ scene_id: 'scene-b', ready: 0, total: 1 });
    });

    // GPU retry policy (2026-11-02): failed task + classified error; a task
    // in a retry pause stays active with last_error + retry fields.
    it('shows a failed task with error_class/error_message and a retrying task with retry fields', async () => {
        const redis = createMockRedis();
        const bookId = 'gpu-retry-panel-book';
        const chunks = new Map();
        const chunkIds = [];
        addChunk(chunks, chunkIds, bookId, 'ch-1', 'scene-a', 1, { expected_chunk_count: 1, audio_status: 'pending' });
        addChunk(chunks, chunkIds, bookId, 'ch-1', 'scene-b', 1, { expected_chunk_count: 1, image_status: 'pending' });
        await sceneState.unsafeRestoreAssetStates(redis, bookId, 'ch-1', 'scene-a', {
            audio: sceneState.AssetState.FAILED, image: sceneState.AssetState.NEW, video: sceneState.AssetState.NEW,
        });
        await sceneState.unsafeRestoreAssetStates(redis, bookId, 'ch-1', 'scene-b', {
            audio: sceneState.AssetState.NEW, image: sceneState.AssetState.FAILED, video: sceneState.AssetState.NEW,
        });
        const [audioTask] = await generationProgress.createTasks(redis, bookId, ['audio'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-a' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-a', dirty_layers: ['audio'] }]);
        const [imageTask] = await generationProgress.createTasks(redis, bookId, ['image'],
            { scope: 'current_scene', chapterId: 'ch-1', sceneId: 'scene-b' },
            [{ chapter_id: 'ch-1', scene_id: 'scene-b', dirty_layers: ['image'] }]);

        const failed = await generationProgress.failSceneStage(redis, bookId, 'ch-1', 'scene-a', 'audio', {
            error_class: 'deterministic', error_code: 'comfy_missing_node',
            error_message: 'No prompt_id: invalid_prompt: node Qwen3TTSGenerate does not exist', attempts: 1,
        });
        expect(failed.tasks.map(t => t.task_id)).to.deep.equal([audioTask.task_id]);
        await generationProgress.updateTask(redis, bookId, imageTask.task_id, {
            last_error: { error_class: 'transient', error_code: 'worker_lost', error_message: 'worker_timeout', at: 1 },
            retry: { scene: { chapter_id: 'ch-1', scene_id: 'scene-b' }, retry_no: 1, max_retries: 2, due_at: 12345 },
        });

        const res = await createHarness(redis, chunks, chunkIds)(bookId);
        expect(res.statusCode).to.equal(200);
        const audio = res.body.tasks.find(t => t.task_id === audioTask.task_id);
        const image = res.body.tasks.find(t => t.task_id === imageTask.task_id);
        expect(audio).to.include({
            status: 'failed', failed: true, done: false, error_class: 'deterministic',
            error_code: 'comfy_missing_node', retrying: false,
        });
        expect(audio.error_message).to.match(/Qwen3TTSGenerate/);
        expect(audio.failed_scene).to.deep.equal({ chapter_id: 'ch-1', scene_id: 'scene-a' });
        expect(image).to.include({
            status: 'active', failed: false, error_class: 'transient', error_message: 'worker_timeout',
            retrying: true, retry_no: 1, retry_max: 2, retry_at: 12345,
        });
        // failed is not "in progress"; the retrying task still is.
        expect(res.body.any_incomplete).to.equal(true);
        await generationProgress.updateTask(redis, bookId, imageTask.task_id, { status: 'cancelled', cancelled_at: Date.now(), retry: null });
        const res2 = await createHarness(redis, chunks, chunkIds)(bookId);
        expect(res2.body.any_incomplete).to.equal(false);
    });
});
