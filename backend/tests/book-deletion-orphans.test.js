// =====================================================
// Book deletion — the leftovers found on 2026-11-22
// =====================================================
// reports/2026-11-22/books-cleanup.md / books-cleanup-recon.md: the standard
// cascade (services/book-deletion.cjs) left
//   - Redis animastor:iu:<unit_id> (keyed by UNIT, no book-keyed pattern),
//   - PG iu_image_pointers / iu_image_fence_reservations (not in the list),
//   - PG gen_command_skips (keyed by command) and agent_steps /
//     agent_conversations / agent_messages (children of agent_sessions) —
//     covered only by FK cascades the code did not rely on explicitly.
// Real test PG (the *_test database), mock Redis.

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const { createMockRedis } = require('./mocks/redis-mock');
const storage = require('../src/storage');
const { createBookDeletion } = require('../src/services/book-deletion.cjs');

const q = (sql, params) => storage.postgres.query(sql, params);
const n = async (sql, params) => Number((await q(sql, params)).rows[0].n);

describe('Book deletion — IU registry keys, IU image tables, gen_command_skips, agent_* children', function () {
    this.timeout(20000);
    const BOOK = `del_orphans_${Date.now()}`;
    const OTHER = `${BOOK}_other`;
    const BUILD = `build_${BOOK}`;
    const ws = crypto.randomUUID();
    const user = crypto.randomUUID();
    const cmd = crypto.randomUUID();
    let redis;

    async function cleanupRows() {
        for (const b of [BOOK, OTHER]) {
            await q('DELETE FROM gen_command_skips WHERE command_id IN (SELECT command_id FROM gen_commands WHERE book_id = $1)', [b]).catch(() => {});
            for (const t of ['gen_commands', 'image_units', 'iu_image_pointers', 'iu_image_fence_reservations', 'agent_sessions']) {
                await q(`DELETE FROM ${t} WHERE book_id = $1`, [b]).catch(() => {});
            }
        }
    }

    before(async () => {
        await cleanupRows();
        // IU image state of the book
        await q(`INSERT INTO image_units (book_id, build_id, chapter_id, scene_id, unit_id) VALUES
            ($1, $2, 'ch-1', 'sc-1', 'iu-pg000001'), ($1, $2, 'ch-1', 'sc-1', 'iu-shared01')`, [BOOK, BUILD]);
        await q(`INSERT INTO image_units (book_id, build_id, chapter_id, scene_id, unit_id) VALUES ($1, 'build_x', 'ch-1', 'sc-1', 'iu-shared01')`, [OTHER]);
        await q(`INSERT INTO iu_image_pointers (book_id, chapter_id, scene_id, iu_id, build_id, path, publish_fence, created_at, updated_at)
            VALUES ($1, 'ch-1', 'sc-1', 'iu-ptr00001', $2, '/x.png', 1, 0, 0)`, [BOOK, BUILD]);
        await q(`INSERT INTO iu_image_fence_reservations (idem_key, book_id, chapter_id, scene_id, iu_id, build_id, fence, created_at)
            VALUES ($1, $2, 'ch-1', 'sc-1', 'iu-fen00001', $3, 1, 0)`, [`idem-${BOOK}`, BOOK, BUILD]);
        // agent session tree
        const s = (await q(`INSERT INTO agent_sessions (book_id) VALUES ($1) RETURNING session_id`, [BOOK])).rows[0].session_id;
        const st = (await q(`INSERT INTO agent_steps (session_id, step_type) VALUES ($1, 'create_scenes') RETURNING step_id`, [s])).rows[0].step_id;
        const c = (await q(`INSERT INTO agent_conversations (session_id, step_id) VALUES ($1, $2) RETURNING conversation_id`, [s, st])).rows[0].conversation_id;
        await q(`INSERT INTO agent_messages (conversation_id, role, content) VALUES ($1, 'user', 'x')`, [c]);
        // a v2 command with a skip row
        await q(`INSERT INTO gen_commands (command_id, workspace_id, user_id, book_id, kind, scope, layers)
            VALUES ($1, $2, $3, $4, 'regenerate', '{"level":"book"}'::jsonb, ARRAY['audio'])`, [cmd, ws, user, BOOK]);
        await q(`INSERT INTO gen_command_skips (command_id, chapter_id, scene_id, reason) VALUES ($1, 'ch-1', 'sc-1', 'skipped_needs_audio')`, [cmd]);

        redis = createMockRedis();
        const reg = (id, build) => redis.set(`animastor:iu:${id}`, JSON.stringify({ build_id: build }));
        await reg('iu-pg000001', BUILD);          // from image_units
        await reg('iu-ptr00001', BUILD);          // from iu_image_pointers
        await reg('iu-fen00001', BUILD);          // from iu_image_fence_reservations
        await reg('iu-bundle01', 'demo_static_007'); // from the bundle, manifest build id
        await reg('iu-shared01', BUILD);          // also a unit of OTHER → kept
        await reg('iu-foreign1', 'build_someone'); // unrelated → kept
        await reg('iu-bundle02', 'build_someone'); // a bundle unit id whose key belongs to another build → kept
    });

    after(async () => {
        await cleanupRows();
    });

    it('deleteBook removes them and keeps what belongs to another book/build', async () => {
        const deletion = createBookDeletion({
            book: {
                resetBook: async () => {},
                loadBook: () => ({
                    manifest: { build_id: 'demo_static_007' },
                    chapters: [{ chapter_id: 'ch-1', scenes: [{ scene_id: 'sc-1', units: [{ id: 'iu-bundle01' }, { id: 'iu-bundle02' }] }] }],
                }),
            },
            redis,
            storage,
            config: { BOOKS_DIR: '/tmp/del-orphans-books', OUTPUT_DIR: '/tmp/del-orphans-output' },
            getAllChunks: async () => [],
            getChunk: async () => null,
            cleanBookRedisKeys: async () => ({}),
            log: () => {},
            setCancelFlag: async () => {},
            agentSessionControl: { cancelSessions: async () => {} },
            purgeAssistantForBook: async () => {},
            removeBookArtifacts: () => {},
            isV2Book: async () => true, // no hub call
        });
        const r = await deletion.deleteBook(BOOK);
        expect(r.deleted).to.equal(true);

        const has = async (id) => (await redis.get(`animastor:iu:${id}`)) != null;
        for (const id of ['iu-pg000001', 'iu-ptr00001', 'iu-fen00001', 'iu-bundle01']) expect(await has(id), id).to.equal(false);
        for (const id of ['iu-shared01', 'iu-foreign1', 'iu-bundle02']) expect(await has(id), id).to.equal(true);

        expect(await n('SELECT count(*) AS n FROM iu_image_pointers WHERE book_id = $1', [BOOK])).to.equal(0);
        expect(await n('SELECT count(*) AS n FROM iu_image_fence_reservations WHERE book_id = $1', [BOOK])).to.equal(0);
        expect(await n('SELECT count(*) AS n FROM image_units WHERE book_id = $1', [BOOK])).to.equal(0);
        expect(await n('SELECT count(*) AS n FROM image_units WHERE book_id = $1', [OTHER])).to.equal(1);
        expect(await n('SELECT count(*) AS n FROM gen_command_skips WHERE command_id = $1', [cmd])).to.equal(0);
        expect(await n('SELECT count(*) AS n FROM agent_sessions WHERE book_id = $1', [BOOK])).to.equal(0);
        expect(await n(`SELECT count(*) AS n FROM agent_messages m JOIN agent_conversations c ON c.conversation_id = m.conversation_id
            JOIN agent_sessions s ON s.session_id = c.session_id WHERE s.book_id = $1`, [BOOK])).to.equal(0);
    });

    it('the explicit child deletes run BEFORE their parents (no FK reliance)', () => {
        const src = require('fs').readFileSync(require.resolve('../src/services/book-deletion.cjs'), 'utf8');
        const at = (s) => src.indexOf(s);
        expect(at("table: 'agent_messages'")).to.be.lessThan(at("table: 'agent_conversations'"));
        expect(at("table: 'agent_conversations'")).to.be.lessThan(at("'agent_sessions',"));
        expect(at("table: 'agent_steps'")).to.be.lessThan(at("'agent_sessions',"));
        expect(at('DELETE FROM gen_command_skips')).to.be.lessThan(at('v2.purgeGenV2(bookId)'));
    });
});
