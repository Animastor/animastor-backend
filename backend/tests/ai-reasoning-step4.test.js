// ======================================================
// Provider reasoning settings everywhere (VBOOK_FORMAT_V4 §12, step 4)
// ======================================================
// disable_thinking / reasoning_effort of a provider (system or workspace) are
// applied by ONE helper (services/ai-reasoning.js) to every
// /chat/completions body: the analysis (ai-service — step 2b), the chat
// assistant (@animastor/assistant, injected withReasoning) and the provider
// connection test (workspace-ai-provider.testConnection). Plus the version
// gate of the assistant (a 3.1 book → the GET /book 409).

'use strict';

const { expect } = require('chai');
const http = require('http');
const fs = require('fs');
const path = require('path');

const aiReasoning = require('../src/services/ai-reasoning');
const workspaceAi = require('../src/services/workspace-ai-provider');
const { buildChatRequestExtras, createChatEngine } = require('@animastor/assistant');

describe('provider reasoning settings — one helper for analysis, chat and the connection test (step 4)', () => {
    describe('ai-reasoning.withReasoning', () => {
        it('no settings → the model extras unchanged', () => {
            const extras = { max_tokens: 16384, enable_thinking: true };
            expect(aiReasoning.withReasoning(extras, null)).to.deep.equal(extras);
            expect(aiReasoning.withReasoning(extras, { disableThinking: false, reasoningEffort: null })).to.deep.equal(extras);
        });
        it('disable_thinking → chat_template_kwargs {enable_thinking:false}; the Qwen switch is dropped', () => {
            const out = aiReasoning.withReasoning({ max_tokens: 16384, enable_thinking: true }, { disableThinking: true });
            expect(out).to.deep.equal({ max_tokens: 16384, chat_template_kwargs: { enable_thinking: false } });
        });
        it('reasoning_effort is sent as the OpenAI field; the body equals the analysis body fields', () => {
            const provider = { disableThinking: true, reasoningEffort: 'low' };
            const out = aiReasoning.withReasoning({ max_tokens: 1 }, provider);
            expect(out).to.deep.equal({ max_tokens: 1, ...aiReasoning.reasoningBodyFields(provider) });
            expect(out.reasoning_effort).to.equal('low');
        });
        it('the input object is not mutated', () => {
            const extras = { enable_thinking: true };
            aiReasoning.withReasoning(extras, { disableThinking: true });
            expect(extras).to.deep.equal({ enable_thinking: true });
        });
    });

    describe('ai-reasoning.reasoningForTest — the settings under test', () => {
        it('the stored provider by default; the body wins; a bad value → error', () => {
            const stored = { disableThinking: true, reasoningEffort: 'high' };
            expect(aiReasoning.reasoningForTest({}, stored)).to.deep.equal({ ok: true, value: { disableThinking: true, reasoningEffort: 'high' } });
            expect(aiReasoning.reasoningForTest({ disable_thinking: false, reasoning_effort: null }, stored)).to.deep.equal({ ok: true, value: { disableThinking: false, reasoningEffort: null } });
            expect(aiReasoning.reasoningForTest({}, null)).to.deep.equal({ ok: true, value: { disableThinking: false, reasoningEffort: null } });
            expect(aiReasoning.reasoningForTest({ reasoning_effort: 'turbo' }, stored).ok).to.equal(false);
            expect(aiReasoning.reasoningForTest({ disable_thinking: 'yes' }, stored).ok).to.equal(false);
        });
    });

    describe('chat assistant (@animastor/assistant 0.3.0)', () => {
        const engine = (withReasoning) => createChatEngine({}, {
            validateBundleObject: () => ({ valid: true, errors: [] }),
            withReasoning,
        });
        it('chatRequestExtras = the model extras + the provider settings through the injected helper', () => {
            const ce = engine(aiReasoning.withReasoning);
            const tools = [{ type: 'function', function: { name: 'edit_book' } }];
            const input = { model: 'qwen/qwen3-32b', baseUrl: 'https://dashscope.example/v1', tools };
            expect(buildChatRequestExtras(input)).to.include({ enable_thinking: true });
            expect(ce.chatRequestExtras(input, { disableThinking: true, reasoningEffort: 'minimal' }))
                .to.deep.equal({ max_tokens: 16384, chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'minimal' });
            expect(ce.chatRequestExtras(input, { disableThinking: false })).to.deep.equal(buildChatRequestExtras(input));
        });
        it('without an injected helper the extras stay as before (package default)', () => {
            const ce = engine(undefined);
            const input = { model: 'nvidia/nemotron', baseUrl: 'https://integrate.api.nvidia.com/v1', tools: [] };
            expect(ce.chatRequestExtras(input, { disableThinking: true })).to.deep.equal(buildChatRequestExtras(input));
        });
        it('both chat routes (non-streaming and SSE) build the body through chatRequestExtras with the provider snapshot', () => {
            const src = fs.readFileSync(path.join(__dirname, '../../packages/animastor-assistant/src/assistant-routes.cjs'), 'utf8');
            // 0.3.1: ONE cloud body builder (cloudChatCompletion) serves both
            // routes through runCloudTurn.
            expect(src.match(/chatEngine\.chatRequestExtras\(\{ model: ai\.model, baseUrl: ai\.baseUrl, tools \}, ai\)/g)).to.have.length(1);
            expect(src.match(/await runCloudTurn\(ai, apiMessages, tools, bookData, bookId,/g)).to.have.length(2);
            expect(src).to.not.match(/\.\.\.buildChatRequestExtras\(/);
        });
        it('the chat provider snapshot carries the reasoning settings (provider gateway)', async () => {
            const gateway = require('../src/services/provider-gateway');
            const orig = workspaceAi.resolveAIForBook;
            workspaceAi.resolveAIForBook = async () => ({ source: 'workspace', endpoint: 'https://llm.example/v1', apiKey: 'k', model: 'm', disableThinking: true, reasoningEffort: 'high' });
            try {
                const ai = await gateway.chat.resolveProvider('some_book', { fallbackBaseUrl: 'https://fallback.example/v1' });
                expect(ai).to.include({ disableThinking: true, reasoningEffort: 'high', model: 'm' });
            } finally {
                workspaceAi.resolveAIForBook = orig;
            }
        });
    });

    describe('provider connection test (workspace-ai-provider.testConnection)', () => {
        let server; let bodies; let savedBase;
        before(async () => {
            bodies = [];
            server = http.createServer((req, res) => {
                let raw = '';
                req.on('data', (c) => { raw += c; });
                req.on('end', () => {
                    bodies.push(JSON.parse(raw));
                    res.setHeader('content-type', 'application/json');
                    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
                });
            });
            await new Promise((r) => server.listen(0, '127.0.0.1', r));
            savedBase = process.env.AI_API_BASE_URL;
            // the operator fallback endpoint (no explicit endpoint → no public-address check)
            process.env.AI_API_BASE_URL = `http://127.0.0.1:${server.address().port}`;
            workspaceAi.setChatRequestExtras(buildChatRequestExtras);
        });
        after(async () => {
            process.env.AI_API_BASE_URL = savedBase;
            await new Promise((r) => server.close(r));
        });

        it('sends the provider reasoning settings exactly like the chat body', async () => {
            const r = await workspaceAi.testConnection({ apiKey: 'test-key', model: 'qwen/qwen3-32b', reasoning: { disableThinking: true, reasoningEffort: 'low' } });
            expect(r.ok, JSON.stringify(r)).to.equal(true);
            const body = bodies.pop();
            expect(body.chat_template_kwargs).to.deep.equal({ enable_thinking: false });
            expect(body.reasoning_effort).to.equal('low');
            expect(body).to.not.have.property('enable_thinking');
            expect(body.max_tokens).to.equal(1);
        });
        it('without reasoning settings the body is the one before step 4', async () => {
            await workspaceAi.testConnection({ apiKey: 'test-key', model: 'qwen/qwen3-32b' });
            const body = bodies.pop();
            expect(body).to.not.have.property('chat_template_kwargs');
            expect(body).to.not.have.property('reasoning_effort');
            expect(body.enable_thinking).to.equal(true);
        });
        it('both test routes (system and workspace) pass the settings through reasoningForTest', () => {
            for (const file of ['../src/routes/admin-routes.cjs', '../src/routes/settings-ai-routes.cjs']) {
                const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
                expect(src, file).to.match(/reasoningForTest\(body, fromStored \? stored : null\)/);
                expect(src, file).to.match(/reasoning: reasoning\.value/);
            }
        });
    });
});

describe('VBook version gate (VBOOK_FORMAT_V4 §9, step 4)', () => {
    const gate = require('../src/middleware/vbook-version-gate');
    const manifests = { old31: { vbook_version: '3.1', book_id: 'old31' }, v4: { vbook_version: 4, book_id: 'v4' }, newer: { vbook_version: 5, book_id: 'newer' } };
    const getBookManifest = (id) => manifests[id] || null;
    function run(mw, req) {
        return new Promise((resolve) => {
            const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
            mw({ headers: {}, params: {}, path: '/x', method: 'POST', ...req }, res, () => resolve({ next: true }));
        });
    }
    it('book routes: a 3.1 / newer book → 409 unsupported_vbook_version; v4 and unknown books pass', async () => {
        const mw = gate.createBookVersionGate({ getBookManifest });
        const r = await run(mw, { params: { bookId: 'old31' } });
        expect(r.status).to.equal(409);
        expect(r.body).to.include({ error: 'unsupported_vbook_version', vbook_version: '3.1', supported: 4 });
        expect((await run(mw, { params: { bookId: 'newer' } })).status).to.equal(409);
        expect(await run(mw, { params: { bookId: 'v4' } })).to.deep.equal({ next: true });
        expect(await run(mw, { params: { bookId: 'nope' } })).to.deep.equal({ next: true });
    });
    it('deleting the 3.1 book itself is let through (the only action left, §9)', async () => {
        const mw = gate.createBookVersionGate({ getBookManifest });
        expect(await run(mw, { params: { bookId: 'old31' }, method: 'DELETE', path: '/' })).to.deep.equal({ next: true });
        expect((await run(mw, { params: { bookId: 'old31' }, method: 'DELETE', path: '/cache' })).status).to.equal(409);
    });
    it('the assistant (req.scopedBookId) answers the same 409 body, in the request language', async () => {
        const mw = gate.createScopedBookVersionGate({ getBookManifest });
        const r = await run(mw, { scopedBookId: 'old31', headers: { 'accept-language': 'ru' } });
        expect(r.status).to.equal(409);
        expect(r.body.message).to.match(/^Книга сохранена в формате VBook 3\.1/);
        expect(await run(mw, { scopedBookId: 'v4' })).to.deep.equal({ next: true });
        expect(await run(mw, { scopedBookId: 'old31', method: 'DELETE' })).to.deep.equal({ next: true });
    });
    it('backend.cjs mounts both gates (book routes after the access guard, assistant after the AI book guard)', () => {
        const src = fs.readFileSync(path.join(__dirname, '../src/backend.cjs'), 'utf8');
        const access = src.indexOf("app.use('/api/v1/book/:bookId', inputGuard.bookIdPathGuard");
        const bookGate = src.indexOf('vbookVersionGate.createBookVersionGate(');
        const aiGuard = src.indexOf("return aiBookGuard(req, res, next);");
        const aiGate = src.indexOf('vbookVersionGate.createScopedBookVersionGate(');
        expect(access).to.be.greaterThan(-1);
        expect(bookGate).to.be.greaterThan(access);
        expect(aiGate).to.be.greaterThan(aiGuard);
    });
});
