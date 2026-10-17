// ======================================================
// Stage 59 — Book-registry gate for read-time self-heal
// ======================================================
// A deleted book whose disk book.json remains must NOT be resurrected by
// client-driven BOOK-RECOVER (recoverMissingRedisChunks). The recovery is
// now gated on isBookRegistered (host port: does the book own a `books`
// row?). These tests exercise the gate against the real package source
// (packages/animastor-editor/src/read-recovery.cjs — loaded by relative
// path so the gate is verified, not a node_modules copy).

const { expect } = require('chai');
const { recoverMissingRedisChunks } = require('../../packages/animastor-editor/src/read-recovery.cjs');

describe('BOOK-RECOVER registry gate (stage 59)', () => {
    const bookId = 'новая_книга_1788747351369';

    function makeCtx({ isBookRegistered }) {
        const savedChunks = [];
        const logs = [];
        const redisStore = new Map();
        return {
            savedChunks,
            logs,
            ctx: {
                redis: {
                    get: async (k) => redisStore.get(k),
                    set: async (k, v) => { redisStore.set(k, v); },
                },
                book: {
                    loadBook: (id) => (id === bookId ? { chapters: [] } : null),
                    collectScenes: () => [{ chapter_id: 'ch-c289a7ac', scene_id: 'sc-eebaac15', scene_order: 0 }],
                },
                state: {},
                activeScenes: {},
                config: {
                    BOOK_SCENE_TOTAL: (id) => `animastor:book-scenes:${id}:total`,
                    BOOK_SCENE_NEXT: (id) => `animastor:book-scenes:${id}:next-index`,
                },
                getAllChunks: async () => [],
                saveChunk: async (chunkId, data) => { savedChunks.push({ chunkId, data }); },
                log: (...a) => { logs.push(a.join(' ')); },
                isBookRegistered,
            },
        };
    }

    it('skips recovery (creates no chunks) when the book is NOT registered', async () => {
        const { ctx, savedChunks, logs } = makeCtx({ isBookRegistered: async () => false });
        await recoverMissingRedisChunks(ctx, 'manual_1788747351369', bookId);
        expect(savedChunks).to.have.lengthOf(0);
        expect(logs.join('\n')).to.match(/skipped — book not registered/);
    });

    it('still creates missing chunks when the book IS registered', async () => {
        const { ctx, savedChunks, logs } = makeCtx({ isBookRegistered: async () => true });
        await recoverMissingRedisChunks(ctx, 'manual_1788747351369', bookId);
        expect(savedChunks).to.have.lengthOf(1);
        expect(savedChunks[0].chunkId).to.equal(`${bookId}_ch-c289a7ac_sc-eebaac15_0001`);
        expect(logs.join('\n')).to.match(/created 1 missing Redis chunks/);
    });

    it('keeps legacy behaviour when isBookRegistered is not injected (defensive)', async () => {
        const { ctx, savedChunks } = makeCtx({ isBookRegistered: undefined });
        await recoverMissingRedisChunks(ctx, 'manual_1788747351369', bookId);
        expect(savedChunks).to.have.lengthOf(1);
    });

    it('registered keep book still recovers; deleted book is skipped (same ctx)', async () => {
        const keepBookId = 'ba_1788172242081';
        const deletedBookId = bookId;
        const savedChunks = [];
        const ctx = {
            redis: { get: async () => '0', set: async () => {} },
            book: {
                loadBook: () => ({ chapters: [] }),
                collectScenes: () => [{ chapter_id: 'ch1', scene_id: 'sc1', scene_order: 0 }],
            },
            state: {}, activeScenes: {},
            config: {
                BOOK_SCENE_TOTAL: (id) => `t:${id}`,
                BOOK_SCENE_NEXT: (id) => `n:${id}`,
            },
            getAllChunks: async () => [],
            saveChunk: async (chunkId) => { savedChunks.push(chunkId); },
            log: () => {},
            // keep book registered, deleted book not:
            isBookRegistered: async (id) => id === keepBookId,
        };

        await recoverMissingRedisChunks(ctx, 'default', keepBookId);
        expect(savedChunks).to.deep.equal([`${keepBookId}_ch1_sc1_0001`]);

        await recoverMissingRedisChunks(ctx, 'default', deletedBookId);
        expect(savedChunks).to.have.lengthOf(1); // no new chunk for the deleted book
    });
});
