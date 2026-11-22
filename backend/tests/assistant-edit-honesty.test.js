// =====================================================
// Assistant edit turns on a VBook 4 book — honest outcome (assistant 0.3.1)
// =====================================================
// Regression for reports/2026-11-22/assistant-edit-bug.md: on 19.11 the
// assistant answered "Done. I've added "The Unexpected Visitor" as Scene 2…
// filled in video.action" while the v4 book stayed at one empty scene. The
// model never called edit_book (the book context told it to "return the full
// changed version in your response" — it pasted JSON instead), and the
// routes passed its text through as is.
//
// The whole contour runs here with the REAL host legs: the book on disk
// (VBook 4 blank book, as POST /book/blank creates it), Book Model load,
// the bundle validator, persistBook (assistant-ports). Only the cloud model
// is a local stub that replays scripted answers.
//   1. claim without edit_book (twice) → "NOT changed", book unchanged, one
//      corrective retry sent;
//   2. claim, then edit_book on the retry → the scene is saved;
//   3. edit_book adds a scene (ids assigned by the server) and sets
//      video.action of an existing unit → both on disk;
//   4. edit_book rejected (3.1 path) + model text "Done" → the error, not "Done";
//   5. the non-streaming route behaves the same;
//   6. the system prompt no longer asks for JSON in the reply;
//   7. edit_book outside the Edit mode is refused;
//   8. empty reply with finish_reason=length → a budget message.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const config = require('../src/config/runtime-config');
const book = require('../src/book');
const lazyBook = require('../src/book/lazy-book');
const bookModel = require('../src/book/book-model.cjs');
const bundleValidator = require('../src/book/bundle-validator.cjs');
const { createAssistantPorts } = require('../src/services/assistant-ports.cjs');
const { emptyBehaviourGlobals } = require('@animastor/vbook-runtime/character-validator.cjs');
const { defaultNarrator } = require('@animastor/vbook-runtime/lazy-book/draft');
const { safeFetch } = require('@animastor/url-safety');
// The published package the backend ships with (^0.3.1 — the fix).
const assistant = require('@animastor/assistant');

const ORIG_BOOKS_DIR = config.BOOKS_DIR;

function blankV4Book(bookId) {
    return {
        manifest: { vbook_version: 4, book_id: bookId, build_id: `manual_${Date.now()}`, created_at: new Date().toISOString() },
        book: {
            book_id: bookId, title: 'New book', author: '', language: 'en',
            structure: { chapters_order: ['ch-9927d41b.json'], characters_order: ['narrator'] },
            defaults: { narration_voice: 'narrator' },
        },
        bible: {},
        heroes: [defaultNarrator('en')],
        behaviour: emptyBehaviourGlobals(),
        locations: {},
        chapters: [{
            chapter_id: 'ch-9927d41b', chapter_title: 'New chapter', type: 'chapter',
            scenes: [{
                scene_id: 'sc-31d19003', scene_title: 'Scene 1', type: 'narration', participants: [],
                audio: { voice: 'narrator', full_text: '' },
                units: [{ id: 'iu-409eacdd', type: 'narration', text: '' }],
            }],
        }],
    };
}

function memorySessionRepo() {
    const sessions = new Map();
    return {
        sessions,
        async listSessionsForBook(bookId) { return [...sessions.values()].filter((s) => s.book_id === bookId); },
        async getSession(id) { return sessions.get(id) || null; },
        async getMessages(id) { return [...((sessions.get(id) || {}).messages || [])]; },
        async createSession(s) { sessions.set(s.id, { ...s, messages: [...(s.messages || [])] }); return s; },
        async setMessages(id, messages) { const s = sessions.get(id); if (s) s.messages = messages; },
        async renameSession() {},
        async deleteSession(id) { sessions.delete(id); },
        async getBookIdForSession(id) { return (sessions.get(id) || {}).book_id || null; },
        async purgeSessionsForBook() {},
    };
}

// The 19.11 answer shape: prose claiming the change + a ```json scene, no tool call.
const CLAIM_REPLY = 'Done. I’ve added **“The Unexpected Visitor”** as Scene 2 in your chapter and filled in the `video.action` field.\n\n'
    + '```json\n{\n  "scene_id": "sc-unexpected",\n  "scene_title": "The Unexpected Visitor",\n  "units": [{ "text": "A knock.", "video": { "action": "The door opens." } }]\n}\n```';

const toolCall = (patches, id = 'call_1') => ({
    id, type: 'function', function: { name: 'edit_book', arguments: JSON.stringify({ patches }) },
});
const answer = ({ content = '', toolCalls, finish = 'stop' } = {}) => ({
    choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }],
});

const NEW_SCENE = {
    scene_title: 'The Unexpected Visitor', type: 'narration',
    units: [
        { type: 'narration', text: 'A knock at the door breaks the silence.', video: { action: 'The door slowly swings open.' } },
        { type: 'narration', text: 'A stranger steps inside.', video: { action: 'Camera tracks the stranger.' } },
    ],
};

describe('Assistant edit turns on a VBook 4 book — honest outcome (0.3.1)', function () {
    this.timeout(20000);
    let tmpDir; let bookId; let upstream; let upstreamBase; let script; let bodies; let app; let server; let base;
    let sessionRepo; let logLines;

    before(async () => {
        upstream = http.createServer((req, res) => {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                bodies.push(JSON.parse(raw || '{}'));
                const next = script.shift() || answer({ content: '' });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(next));
            });
        });
        await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
        upstreamBase = `http://127.0.0.1:${upstream.address().port}/v1`;
    });

    after(async () => {
        await new Promise((r) => upstream.close(r));
    });

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-honesty-'));
        config.BOOKS_DIR = tmpDir;
        bookId = `new_book_${Date.now()}`;
        book.saveBookBundle(blankV4Book(bookId));
        script = [];
        bodies = [];
        logLines = [];
        sessionRepo = memorySessionRepo();
        const chatEngine = assistant.createChatEngine(config, {
            validateBundleObject: bundleValidator.validateBundleObject, aiProfile: null,
        });
        const ports = createAssistantPorts({
            bookModel, book, lazyBook, bundleValidator,
            providerGateway: {
                chat: {
                    resolveProvider: async () => ({
                        baseUrl: upstreamBase, apiKey: 'test-key', model: 'nvidia/test-model',
                        source: 'system', validatePublic: false,
                    }),
                    sourceToken: () => 'system',
                },
            },
            chatEngine,
            sessionRepo,
            urlSafety: { safeFetch },
            sharedPool: { runSharedInference: async () => ({ ok: false, code: 'runtime_error' }), describeSharedError: () => 'x' },
            log: (...a) => logLines.push(a.join(' ')),
        });
        app = express();
        app.use(express.json({ limit: '5mb' }));
        assistant.createAssistantRoutes(app, null, {
            chatEngine,
            assistantPorts: ports,
            utils: { log: (...a) => logLines.push(a.join(' ')) },
        });
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    afterEach(async () => {
        await new Promise((r) => server.close(r));
        config.BOOKS_DIR = ORIG_BOOKS_DIR;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    async function createSession(mode = 'edit') {
        const r = await fetch(`${base}/api/v1/ai/sessions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ book_id: bookId, mode }),
        });
        const j = await r.json();
        return j.session_id || j.id || (j.session && j.session.id);
    }

    async function streamTurn(sessionId, message, mode = 'edit') {
        const r = await fetch(`${base}/api/v1/ai/chat/stream`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sessionId, book_id: bookId, message, mode }),
        });
        const text = await r.text();
        const frames = text.split('\n\n').filter(Boolean).map((f) => {
            const ev = /event: (\w+)/.exec(f);
            const data = /data: (.*)/.exec(f);
            return { event: ev && ev[1], data: data ? JSON.parse(data[1]) : null };
        }).filter((f) => f.event);
        return frames.find((f) => f.event === 'done' || f.event === 'error');
    }

    const diskBook = () => bookModel.loadBook(bookId, { mode: 'lazy' });
    const scenes = () => diskBook().chapters[0].scenes;

    it('1. 19.11 repro: a claim without edit_book (twice) → "NOT changed", book unchanged, one corrective retry', async () => {
        script.push(answer({ content: CLAIM_REPLY }), answer({ content: CLAIM_REPLY }));
        const sid = await createSession();
        const done = await streamTurn(sid, 'add a scene with text and fill video.action');
        expect(done.event).to.equal('done');
        expect(done.data.reply).to.match(/^⚠️ The book was NOT changed/);
        expect(done.data.reply).to.not.match(/\bDone\b/);
        expect(done.data.patches_applied).to.equal(0);
        expect(done.data.edit_outcome).to.equal('claimed_not_applied');
        expect(scenes()).to.have.length(1);
        expect(bodies).to.have.length(2);
        const retryTurn = bodies[1].messages[bodies[1].messages.length - 1];
        expect(retryTurn.role).to.equal('user');
        expect(retryTurn.content).to.match(/You have NOT called the `edit_book` tool/);
        // the honest text, not the claim, is what the session keeps
        const stored = sessionRepo.sessions.get(sid).messages;
        expect(stored[stored.length - 1].content).to.match(/NOT changed/);
        expect(logLines.some((l) => /turn session=.* edit=claimed_not_applied patches=0 retry=1/.test(l))).to.equal(true);
    });

    it('2. a claim, then edit_book on the corrective retry → the scene is saved on disk', async () => {
        script.push(
            answer({ content: CLAIM_REPLY }),
            answer({ content: '', toolCalls: [toolCall([{ op: 'add', path: '/chapters/0/scenes/-', value: NEW_SCENE }])] }),
        );
        const sid = await createSession();
        const done = await streamTurn(sid, 'add a scene with text');
        expect(done.data.edit_outcome).to.equal('applied');
        expect(done.data.patches_applied).to.equal(1);
        expect(done.data.reply).to.match(/Changes applied/);
        const sc = scenes();
        expect(sc).to.have.length(2);
        expect(sc[1].scene_title).to.equal('The Unexpected Visitor');
        expect(sc[1].units.map((u) => u.video && u.video.action)).to.deep.equal(['The door slowly swings open.', 'Camera tracks the stranger.']);
    });

    it('3. edit_book adds a scene (server-assigned ids) and sets video.action of an existing unit', async () => {
        script.push(answer({
            content: 'Added the scene and the action.',
            toolCalls: [toolCall([
                { op: 'add', path: '/chapters/0/scenes/-', value: NEW_SCENE },
                { op: 'add', path: '/chapters/0/scenes/0/units/0/video/action', value: 'Slow push-in on the empty room.' },
                { op: 'replace', path: '/chapters/0/scenes/0/units/0/text', value: 'The room is empty.' },
            ])],
        }));
        const sid = await createSession();
        const done = await streamTurn(sid, 'add a scene and set the action');
        expect(done.data.edit_outcome).to.equal('applied');
        expect(done.data.patches_applied).to.equal(3);
        expect(done.data.reply).to.equal('Added the scene and the action.');
        const sc = scenes();
        expect(sc).to.have.length(2);
        expect(sc[0].units[0].text).to.equal('The room is empty.');
        expect(sc[0].units[0].video).to.deep.equal({ action: 'Slow push-in on the empty room.' });
        expect(sc[1].scene_id).to.match(/^sc-[0-9a-f]{8}$/);
        expect(sc[1].participants).to.deep.equal([]);
        for (const u of sc[1].units) expect(u.id).to.match(/^iu-[0-9a-f]{8}$/);
        // the chapter file on disk carries the new scene
        const chapterFile = JSON.parse(fs.readFileSync(path.join(tmpDir, bookId, 'chapters', 'ch-9927d41b.json'), 'utf8'));
        expect(chapterFile.scenes).to.have.length(2);
    });

    it('4. edit_book rejected (a 3.1 path) + model text "Done" → the error, never "Done"', async () => {
        script.push(answer({
            content: 'Done! The character was updated.',
            toolCalls: [toolCall([{ op: 'replace', path: '/characters/narrator/name', value: 'X' }])],
        }));
        const sid = await createSession();
        const before = fs.readFileSync(path.join(tmpDir, bookId, 'chapters', 'ch-9927d41b.json'), 'utf8');
        const done = await streamTurn(sid, 'rename the narrator');
        expect(done.data.edit_outcome).to.equal('rejected');
        expect(done.data.patches_applied).to.equal(0);
        expect(done.data.reply).to.match(/^⚠️ The book was NOT changed: Path \/characters\/narrator\/name is not part of VBook 4/);
        expect(done.data.reply).to.not.match(/Done/);
        expect(fs.readFileSync(path.join(tmpDir, bookId, 'chapters', 'ch-9927d41b.json'), 'utf8')).to.equal(before);
        expect(logLines.some((l) => /edit_book not applied/.test(l))).to.equal(true);
    });

    it('5. the non-streaming route: same honesty and the same save', async () => {
        script.push(answer({ content: CLAIM_REPLY }), answer({ content: CLAIM_REPLY }));
        const sid = await createSession();
        let r = await fetch(`${base}/api/v1/ai/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sid, book_id: bookId, message: 'add a scene', mode: 'edit' }),
        });
        let j = await r.json();
        expect(j.edit_outcome).to.equal('claimed_not_applied');
        expect(j.reply).to.match(/NOT changed/);
        expect(scenes()).to.have.length(1);

        script.push(answer({ content: '', toolCalls: [toolCall([{ op: 'add', path: '/chapters/0/scenes/-', value: NEW_SCENE }])] }));
        r = await fetch(`${base}/api/v1/ai/chat`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session_id: sid, book_id: bookId, message: 'add a scene', mode: 'edit' }),
        });
        j = await r.json();
        expect(j.edit_outcome).to.equal('applied');
        expect(j.patches_applied).to.equal(1);
        expect(scenes()).to.have.length(2);
    });

    it('6. the edit-turn system prompt asks for edit_book, not for JSON in the reply', async () => {
        script.push(answer({ content: 'What would you like to change?' }));
        const sid = await createSession();
        const done = await streamTurn(sid, 'hi');
        expect(done.data.edit_outcome).to.equal('none');
        const sys = bodies[0].messages[0].content;
        expect(sys).to.not.match(/return the full changed version/);
        expect(sys).to.match(/READ-ONLY snapshot/);
        expect(sys).to.match(/add \/chapters\/<chapter_index>\/scenes\/-/);
        expect(sys).to.not.match(/Always confirm changes with the user before applying/);
        expect(bodies[0].tools.map((t) => t.function.name)).to.deep.equal(['edit_book']);
        expect(bodies).to.have.length(1); // a question is not a claim — no retry
    });

    it('7. edit_book outside the Edit mode is refused (content-embedded call)', async () => {
        script.push(answer({
            content: '〖tool_call〗{"name": "edit_book", "arguments": {"patches": [{"op": "replace", "path": "/chapters/0/scenes/0/units/0/text", "value": "X"}]}}〖/tool_call〗',
        }));
        const sid = await createSession('conversation');
        const done = await streamTurn(sid, 'change the text', 'conversation');
        expect(done.data.edit_outcome).to.equal('rejected');
        expect(done.data.reply).to.match(/cannot be changed in this mode/);
        expect(scenes()[0].units[0].text).to.equal('');
        expect(bodies[0].tools).to.equal(undefined);
        expect(bodies[0].messages[0].content).to.match(/In this mode you cannot change the book/);
    });

    it('8. an empty reply cut by finish_reason=length says so', async () => {
        script.push(answer({ content: '', finish: 'length' }));
        const sid = await createSession();
        const done = await streamTurn(sid, 'add a scene');
        expect(done.data.reply).to.match(/ran out of its answer budget/);
        expect(done.data.edit_outcome).to.equal('none');
    });
});
