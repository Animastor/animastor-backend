// ======================================================
// VBook 4 step 2b — reasoning models and the analysis transport
// ======================================================
// Acceptance 2.6 (reports/2026-11-17/vbook-v4-acceptance-2.6.md): a reasoning
// model spent max_tokens on reasoning and returned an empty content; the
// analysis retried it into the same nothing. Covered here:
//   1. provider setting disable_thinking / reasoning_effort: validation, stored
//      in system_ai_providers / workspace_ai_providers like the other fields,
//      default off, kept when not given, exposed in meta and in the snapshot;
//   2. ai-service.callAI sends chat_template_kwargs / reasoning_effort only
//      when the provider asks for it;
//   3. finish_reason=length with an empty content → a clear error, ONE request,
//      no retries (neither ai-service nor ai-caller);
//   4. a JSON cut at max_tokens says so; output budgets of the per-unit steps.
// Real PG (test stack); HTTP is a recording stub — no LLM is called.

'use strict';

const { expect } = require('chai');

const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');
const aiReasoning = require('../src/services/ai-reasoning');
const systemAi = require('../src/services/system-ai');
const workspaceAi = require('../src/services/workspace-ai-provider');
const aiService = require('../src/services/ai-service');
const aiCaller = require('../src/services/agent/ai-caller');
const { unitOutputBudget } = require('../src/services/agent/pipeline-steps');

const stamp = `rsn${Date.now()}`;
const SYSTEM = { source: 'system', provider: 'openai-compatible', endpoint: 'https://llm.example.test/v1', apiKey: 'k-test', model: 'm' };

function stubFetch(responses) {
    const calls = [];
    const saved = global.fetch;
    global.fetch = async (url, opts) => {
        calls.push({ url: String(url), body: JSON.parse(opts.body) });
        const r = responses[Math.min(calls.length - 1, responses.length - 1)];
        return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { calls, restore: () => { global.fetch = saved; } };
}
const answer = (content, finish = 'stop', reasoning = 0) => ({
    choices: [{ message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 4096, total_tokens: 4106, completion_tokens_details: { reasoning_tokens: reasoning } },
});

describe('VBook 4 step 2b — reasoning settings of an AI provider', function () {
    this.timeout(20000);
    let quiet;
    before(async () => { await runMigrations(); });
    beforeEach(() => {
        quiet = { log: console.log, warn: console.warn, error: console.error };
        console.log = () => {}; console.warn = () => {}; console.error = () => {};
    });
    afterEach(() => {
        Object.assign(console, quiet);
        workspaceAi.invalidateAllCache();
        systemAi.invalidateAll();
    });
    after(async () => {
        await query(`DELETE FROM workspace_ai_providers WHERE workspace_id IN (SELECT id FROM workspaces WHERE name LIKE $1)`, [`%${stamp}%`]);
        await query(`DELETE FROM workspaces WHERE name LIKE $1`, [`%${stamp}%`]);
        await query(`DELETE FROM system_ai_providers WHERE id = 'default'`);
    });

    describe('the API fields', () => {
        it('disable_thinking is a boolean; reasoning_effort is null or a known level', () => {
            expect(aiReasoning.parseReasoningInput({})).to.deep.equal({ ok: true, value: {} });
            expect(aiReasoning.parseReasoningInput({ disable_thinking: true, reasoning_effort: 'LOW ' }).value)
                .to.deep.equal({ disableThinking: true, reasoningEffort: 'low' });
            expect(aiReasoning.parseReasoningInput({ reasoning_effort: null }).value).to.deep.equal({ reasoningEffort: null });
            expect(aiReasoning.parseReasoningInput({ reasoning_effort: '' }).value).to.deep.equal({ reasoningEffort: null });
            for (const bad of [{ disable_thinking: 'yes' }, { disable_thinking: 1 }, { reasoning_effort: 'max' }, { reasoning_effort: 3 }]) {
                expect(aiReasoning.parseReasoningInput(bad).ok, JSON.stringify(bad)).to.equal(false);
            }
        });

        it('body fields: nothing by default; chat_template_kwargs and reasoning_effort when set', () => {
            expect(aiReasoning.reasoningBodyFields(null)).to.deep.equal({});
            expect(aiReasoning.reasoningBodyFields({ disableThinking: false, reasoningEffort: null })).to.deep.equal({});
            expect(aiReasoning.reasoningBodyFields({ disableThinking: true })).to.deep.equal({ chat_template_kwargs: { enable_thinking: false } });
            expect(aiReasoning.reasoningBodyFields({ reasoningEffort: 'low' })).to.deep.equal({ reasoning_effort: 'low' });
            expect(aiReasoning.reasoningBodyFields({ reasoningEffort: 'bogus' })).to.deep.equal({});
        });
    });

    describe('storage — like the other provider fields', () => {
        it('system provider: off by default, set, kept when not given, cleared explicitly; meta and snapshot carry it', async () => {
            let meta = await systemAi.upsertSystemProvider({ endpoint: 'https://llm.example.test/v1', apiKey: 'k-system', model: 'm' });
            expect(meta).to.include({ disable_thinking: false, reasoning_effort: null });

            meta = await systemAi.upsertSystemProvider({ endpoint: 'https://llm.example.test/v1', model: 'm', disableThinking: true, reasoningEffort: 'low' });
            expect(meta).to.include({ disable_thinking: true, reasoning_effort: 'low' });
            const snap = await systemAi.resolveSystemProvider();
            expect(snap).to.include({ disableThinking: true, reasoningEffort: 'low' });
            expect(aiReasoning.reasoningBodyFields(snap)).to.deep.equal({ chat_template_kwargs: { enable_thinking: false }, reasoning_effort: 'low' });

            meta = await systemAi.upsertSystemProvider({ endpoint: 'https://llm.example.test/v1', model: 'm2' });
            expect(meta).to.include({ model: 'm2', disable_thinking: true, reasoning_effort: 'low' });

            meta = await systemAi.upsertSystemProvider({ endpoint: 'https://llm.example.test/v1', model: 'm2', disableThinking: false, reasoningEffort: null });
            expect(meta).to.include({ disable_thinking: false, reasoning_effort: null });
            expect(JSON.stringify(meta)).to.not.include('k-system');
        });

        it('workspace provider: off by default, set, kept when not given; meta and snapshot carry it', async () => {
            const { rows } = await query(`INSERT INTO workspaces (name, type) VALUES ($1, 'personal') RETURNING id`, [`w-${stamp}`]);
            const ws = rows[0].id;
            let meta = await workspaceAi.upsertProvider(ws, { providerType: 'openai-compatible', endpoint: 'https://llm.example.test/v1', apiKey: 'k-ws', model: 'm' });
            expect(meta).to.include({ disable_thinking: false, reasoning_effort: null });

            meta = await workspaceAi.upsertProvider(ws, { endpoint: 'https://llm.example.test/v1', model: 'm', disableThinking: true });
            expect(meta).to.include({ disable_thinking: true, reasoning_effort: null });
            const snap = await workspaceAi.resolveAIForWorkspace(ws);
            expect(snap).to.include({ source: 'workspace', disableThinking: true, reasoningEffort: null });

            meta = await workspaceAi.upsertProvider(ws, { endpoint: 'https://llm.example.test/v1', model: 'm3' });
            expect(meta).to.include({ model: 'm3', disable_thinking: true });
            expect((await workspaceAi.getProviderMeta(ws))).to.include({ disable_thinking: true, reasoning_effort: null });
        });
    });

    describe('the analysis transport (ai-service.callAI)', () => {
        it('sends chat_template_kwargs only for a provider with disable_thinking', async () => {
            const stub = stubFetch([answer('{"ok":true}')]);
            try {
                await aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 100 }, SYSTEM);
                await aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 100 }, { ...SYSTEM, disableThinking: true, reasoningEffort: 'low' });
            } finally { stub.restore(); }
            expect(stub.calls[0].body).to.not.have.any.keys('chat_template_kwargs', 'reasoning_effort');
            expect(stub.calls[1].body).to.include({ reasoning_effort: 'low' });
            expect(stub.calls[1].body.chat_template_kwargs).to.deep.equal({ enable_thinking: false });
        });

        it('finish_reason=length with an empty content → "exhausted its token limit on reasoning", one request, not retried', async () => {
            const stub = stubFetch([answer('', 'length', 4096)]);
            let err;
            try { await aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 4096 }, SYSTEM); } catch (e) { err = e; } finally { stub.restore(); }
            expect(err).to.be.an('error');
            expect(err.code).to.equal('reasoning_budget_exhausted');
            expect(err.message).to.include('exhausted its token limit on reasoning').and.include('reasoning_tokens=4096').and.include('disable_thinking');
            expect(stub.calls).to.have.length(1);
        });

        it('the error names who can change the provider: system → the administrator, workspace → personal (owner, step 6)', async () => {
            const run = async (provider) => {
                const stub = stubFetch([answer('', 'length', 4096)]);
                try { await aiService.callAI([{ role: 'user', content: 'x' }], { maxTokens: 4096 }, provider); } catch (e) { return e; } finally { stub.restore(); }
                return null;
            };
            const sys = await run(SYSTEM);
            expect(sys.providerSource).to.equal('system');
            expect(sys.message).to.include('Provider: system.').and.include('Ask the administrator');
            // a workspace endpoint goes through the public-address check (DNS) — the factory directly
            const aiReasoning = require('../src/services/ai-reasoning');
            const own = aiReasoning.reasoningExhaustedError({ maxTokens: 1, provider: { source: 'workspace' } });
            expect(own.providerSource).to.equal('personal');
            expect(own.message).to.include('Provider: personal.').and.include('your AI provider settings');
            expect(aiReasoning.reasoningExhaustedError({ maxTokens: 1, provider: { source: 'global' } }).providerSource).to.equal('system');
            const unknown = aiReasoning.reasoningExhaustedError({ maxTokens: 1 });
            expect(unknown.providerSource).to.equal(null);
            expect(unknown.message).to.not.include('Provider:');
            const { analysisErrorBody } = require('../src/routes/book/import-routes.cjs');
            expect(analysisErrorBody(sys)).to.deep.equal({ error: sys.message, code: 'reasoning_budget_exhausted', provider_source: 'system' });
            expect(analysisErrorBody(new Error('boom'))).to.deep.equal({ error: 'boom' });
        });

        it('the agent caller does not retry it either (acceptance 2.6: 1 request instead of 3×3)', async () => {
            const stub = stubFetch([answer('', 'length', 4096)]);
            let err;
            try { await aiCaller.callAI([{ role: 'user', content: 'x' }], { maxTokens: 4096, provider: SYSTEM }); } catch (e) { err = e; } finally { stub.restore(); }
            expect(err.code).to.equal('reasoning_budget_exhausted');
            expect(stub.calls).to.have.length(1);
        });

        it('an empty content that is NOT a length cut keeps the old behaviour (parse error, retried by the caller)', async () => {
            const stub = stubFetch([answer('', 'stop'), answer('', 'stop'), answer('{"a":1}', 'stop')]);
            let out;
            try { out = await aiCaller.callAI([{ role: 'user', content: 'x' }], { maxTokens: 100, provider: SYSTEM, retries: 3 }); } finally { stub.restore(); }
            expect(out).to.deep.equal({ a: 1 });
            expect(stub.calls).to.have.length(3);
        });

        it('a JSON cut at max_tokens says so in the error', async () => {
            const stub = stubFetch([answer('{"units":[{"a":', 'length')]);
            let err;
            try { await aiCaller.callAI([{ role: 'user', content: 'x' }], { maxTokens: 512, provider: SYSTEM, retries: 1 }); } catch (e) { err = e; } finally { stub.restore(); }
            expect(err.message).to.include('output cut at max_tokens=512, finish_reason=length');
        });
    });

    describe('output budgets of the per-unit steps', () => {
        it('follow the number of units between 4096 and 16384', () => {
            expect(unitOutputBudget(0, 200)).to.equal(4096);
            expect(unitOutputBudget(10, 200)).to.equal(4096);
            expect(unitOutputBudget(44, 200)).to.equal(1024 + 44 * 200);   // the visuals of scene 7 that were cut at 4096
            expect(unitOutputBudget(83, 100)).to.equal(1024 + 83 * 100);   // reconcile / polish of window 2
            expect(unitOutputBudget(500, 200)).to.equal(16384);
        });
    });
});
