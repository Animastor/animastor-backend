// ======================================================
// Startup — interrupted window sessions are NOT resumed (unit)
// ======================================================
// Command-only generation (2026-10-31): Phase C5 marks sessions that were
// generating/pending at shutdown as interrupted; it never starts window
// generation in the background (the former resumeIncompleteSessions did).

const { expect } = require('chai');

const GEN_SESSION_PATH = require.resolve('../src/storage/postgres/repositories/gen-session-repo');
const STARTUP_RESUME_PATH = require.resolve('../src/startup-resume');

function loadStartupResume(genSessionMock) {
    delete require.cache[GEN_SESSION_PATH];
    delete require.cache[STARTUP_RESUME_PATH];
    require.cache[GEN_SESSION_PATH] = { exports: genSessionMock, loaded: true };
    return require(STARTUP_RESUME_PATH);
}

describe('startup-resume: interrupted sessions (command-only generation)', () => {
    afterEach(() => {
        delete require.cache[GEN_SESSION_PATH];
        delete require.cache[STARTUP_RESUME_PATH];
    });

    it('marks generating/pending sessions interrupted and resumes nothing', async () => {
        const updated = [];
        const { interruptIncompleteSessions, INTERRUPTED_ERROR } = loadStartupResume({
            getActiveSessions: async () => [
                { id: 's1', book_id: 'b1', window_index: 0, status: 'generating' },
                { id: 's2', book_id: 'b2', window_index: 1, status: 'pending' },
                { id: 's3', book_id: 'b3', window_index: 2, status: 'queued' },
            ],
            updateSession: async (id, updates) => { updated.push({ id, updates }); return {}; },
        });

        const n = await interruptIncompleteSessions(() => {});

        expect(n).to.equal(2);
        expect(updated.map(u => u.id)).to.deep.equal(['s1', 's2']); // queued untouched
        for (const u of updated) {
            expect(u.updates.status).to.equal('failed');
            expect(u.updates.error).to.equal(INTERRUPTED_ERROR);
        }
    });

    it('the module exposes no resume entry point', () => {
        const mod = loadStartupResume({ getActiveSessions: async () => [], updateSession: async () => ({}) });
        expect(mod.resumeIncompleteSessions).to.equal(undefined);
    });

    it('a PG error is logged and reported as 0 (startup continues)', async () => {
        const errors = [];
        const origErr = console.error;
        console.error = (...a) => { errors.push(a.join(' ')); };
        try {
            const { interruptIncompleteSessions } = loadStartupResume({
                getActiveSessions: async () => { throw new Error('pg down'); },
                updateSession: async () => ({}),
            });
            expect(await interruptIncompleteSessions(() => {})).to.equal(0);
            expect(errors.join('\n')).to.include('pg down');
        } finally {
            console.error = origErr;
        }
    });
});
