// ======================================================
// Startup after cancel / restart — Integration Test (real PG)
// ======================================================
// Command-only generation (2026-10-31, animastor-docs
// architecture/COMMAND_ONLY_GENERATION.md) REVISES Cathedral Recon #3 §5.4:
// a backend start never resumes a window session — cancelled or not. What was
// running is marked interrupted (status 'failed', error 'interrupted: …') and
// waits for the user's button. The former guarantee "a cancelled session is
// NOT resumed" therefore holds a fortiori, and a live session is not resumed
// either (it used to be — a start without a command).
//
// Real PostgreSQL connection + the REAL startup-resume module.

const { expect } = require('chai');

const TEST_BOOK_CANCELLED = 'recovery-test-cancelled';
const TEST_BOOK_LIVE = 'recovery-test-live';

const postgres = require('../src/storage/postgres');
const genSessionRepo = require('../src/storage/postgres/repositories/gen-session-repo');
const generationCancelRepo = require('../src/storage/postgres/repositories/generation-cancel-repo');
const { interruptIncompleteSessions, INTERRUPTED_ERROR } = require('../src/startup-resume');

async function sessionRow(id) {
    const r = await postgres.query('SELECT status, error FROM book_generation_sessions WHERE id = $1', [id]);
    return r.rows[0];
}

describe('startup after cancel / restart — no session resumed (real PG)', function () {
    this.timeout(20000);

    before(async () => {
        await postgres.initialize();
    });

    afterEach(async () => {
        for (const bookId of [TEST_BOOK_CANCELLED, TEST_BOOK_LIVE]) {
            await postgres.query('DELETE FROM book_generation_sessions WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM generation_cancellations WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM agent_sessions WHERE book_id = $1', [bookId]);
            await postgres.query('DELETE FROM generation_tasks WHERE book_id = $1', [bookId]);
        }
    });

    it('cancelled book: the interrupted session is marked interrupted, never resumed', async () => {
        const session = await genSessionRepo.createSession(TEST_BOOK_CANCELLED, 0, 3);
        await genSessionRepo.updateSession(session.id, { status: 'generating' });
        await generationCancelRepo.setCancelled(TEST_BOOK_CANCELLED, { reason: 'user_cancelled', createdBy: 'cancel-generation' });

        const marked = await interruptIncompleteSessions(() => {});

        expect(marked).to.be.at.least(1);
        const row = await sessionRow(session.id);
        expect(row.status).to.equal('failed');
        expect(row.error).to.equal(INTERRUPTED_ERROR);
    });

    it('live book (no tombstone): marked interrupted too — resumed only by a button', async () => {
        const session = await genSessionRepo.createSession(TEST_BOOK_LIVE, 0, 3);
        await genSessionRepo.updateSession(session.id, { status: 'pending' });

        await interruptIncompleteSessions(() => {});

        const row = await sessionRow(session.id);
        expect(row.status).to.equal('failed');
        expect(row.error).to.equal(INTERRUPTED_ERROR);
        // no longer counted as active → a new explicit trigger is not blocked
        const active = (await genSessionRepo.getActiveSessions()).filter(s => s.book_id === TEST_BOOK_LIVE);
        expect(active).to.deep.equal([]);
    });

    it('queued sessions are left for the explicit flow', async () => {
        const session = await genSessionRepo.createSession(TEST_BOOK_LIVE, 1, 3);
        await genSessionRepo.updateSession(session.id, { status: 'queued' });

        await interruptIncompleteSessions(() => {});

        expect((await sessionRow(session.id)).status).to.equal('queued');
    });
});
