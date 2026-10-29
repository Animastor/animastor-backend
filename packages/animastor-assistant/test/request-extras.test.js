// ======================================================
// @animastor/assistant — CHAT REQUEST EXTRAS TESTS
// ======================================================
// RX1 — supportsEnableThinking / buildChatRequestExtras: enable_thinking
//       only for qwen* models, never for NVIDIA / non-qwen models
// RX2 — fetchChatCompletion: 400 "Unsupported parameter" → one retry
//       without the non-standard fields
// RX3 — describeUpstreamError: short provider message, keys masked
// RX4 — both chat routes (non-stream + SSE) retry and surface the
//       upstream error through the same path

const { expect } = require('chai');
const {
    supportsEnableThinking, buildChatRequestExtras,
    fetchChatCompletion, describeUpstreamError,
    MAX_TOKENS_WITH_TOOLS, MAX_TOKENS_PLAIN,
} = require('../src/request-extras.cjs');
const { createChatEngine, createAssistantRoutes, buildChatRequestExtras: exported } = require('../src/index.cjs');

const TOOLS = [{ type: 'function', function: { name: 'edit_book', parameters: { type: 'object' } } }];
const NVIDIA = 'https://integrate.api.nvidia.com/v1';
const QWEN_HOST = 'https://api.aicredits.in/v1';

const unsupported400 = () => ({
    ok: false, status: 400,
    text: async () => JSON.stringify({ error: { message: 'Unsupported parameter(s): enable_thinking' } }),
});
const ok200 = (content = 'hello') => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    text: async () => '',
});

function recordingFetch(responses) {
    const calls = [];
    const fn = async (url, init) => {
        calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
        return responses[Math.min(calls.length - 1, responses.length - 1)]();
    };
    fn.calls = calls;
    return fn;
}

describe('RX1: enable_thinking only for providers that support it', () => {
    it('qwen models → field present (true with tools, false without)', () => {
        expect(supportsEnableThinking({ model: 'qwen/qwen3-32b', baseUrl: QWEN_HOST })).to.equal(true);
        expect(supportsEnableThinking({ model: 'Qwen3-235B-A22B', baseUrl: QWEN_HOST })).to.equal(true);
        expect(buildChatRequestExtras({ model: 'qwen/qwen3-32b', baseUrl: QWEN_HOST, tools: TOOLS }))
            .to.deep.equal({ max_tokens: MAX_TOKENS_WITH_TOOLS, enable_thinking: true });
        expect(buildChatRequestExtras({ model: 'qwen/qwen3-32b', baseUrl: QWEN_HOST, tools: [] }))
            .to.deep.equal({ max_tokens: MAX_TOKENS_PLAIN, enable_thinking: false });
    });

    it('nvidia/nemotron → no field', () => {
        const x = buildChatRequestExtras({ model: 'nvidia/llama-3.3-nemotron-super-49b-v1', baseUrl: NVIDIA, tools: TOOLS });
        expect(x).to.not.have.property('enable_thinking');
        expect(x.max_tokens).to.equal(MAX_TOKENS_WITH_TOOLS);
    });

    it('qwen hosted on NVIDIA → no field (endpoint rejects it)', () => {
        expect(supportsEnableThinking({ model: 'qwen/qwen3-235b-a22b', baseUrl: NVIDIA })).to.equal(false);
        expect(buildChatRequestExtras({ model: 'qwen/qwen3-235b-a22b', baseUrl: NVIDIA, tools: TOOLS }))
            .to.not.have.property('enable_thinking');
    });

    it('other models / missing input → no field', () => {
        expect(supportsEnableThinking({ model: 'deepseek/deepseek-v4-flash', baseUrl: QWEN_HOST })).to.equal(false);
        expect(supportsEnableThinking({})).to.equal(false);
        expect(buildChatRequestExtras()).to.deep.equal({ max_tokens: MAX_TOKENS_PLAIN });
    });

    it('is the function exported from the package root', () => {
        expect(exported).to.equal(buildChatRequestExtras);
    });
});

describe('RX2: 400 Unsupported parameter → one retry without the field', () => {
    it('retries once without enable_thinking and succeeds', async () => {
        const f = recordingFetch([unsupported400, ok200]);
        const body = { model: 'qwen/qwen3-32b', messages: [], max_tokens: 16, enable_thinking: true };
        const { response } = await fetchChatCompletion(f, 'u', { method: 'POST' }, body);
        expect(response.ok).to.equal(true);
        expect(f.calls).to.have.length(2);
        expect(f.calls[0].body).to.have.property('enable_thinking', true);
        expect(f.calls[1].body).to.not.have.property('enable_thinking');
        expect(f.calls[1].body).to.deep.include({ model: 'qwen/qwen3-32b', max_tokens: 16 });
    });

    it('does not retry when the body carried no non-standard field', async () => {
        const f = recordingFetch([unsupported400, ok200]);
        const { response, errText } = await fetchChatCompletion(f, 'u', {}, { model: 'm', messages: [] });
        expect(response.ok).to.equal(false);
        expect(errText).to.include('Unsupported parameter');
        expect(f.calls).to.have.length(1);
    });

    it('does not retry other 400s, and retries at most once', async () => {
        const other = () => ({ ok: false, status: 400, text: async () => 'context length exceeded' });
        const f1 = recordingFetch([other, ok200]);
        await fetchChatCompletion(f1, 'u', {}, { enable_thinking: true });
        expect(f1.calls).to.have.length(1);

        const f2 = recordingFetch([unsupported400, unsupported400, ok200]);
        const { response } = await fetchChatCompletion(f2, 'u', {}, { enable_thinking: true });
        expect(response.ok).to.equal(false);
        expect(f2.calls).to.have.length(2);
    });
});

describe('RX3: upstream error is short and key-free', () => {
    it('code + provider message', () => {
        expect(describeUpstreamError(400, JSON.stringify({ error: { message: 'Unsupported parameter(s): enable_thinking' } })))
            .to.equal('AI API error 400: Unsupported parameter(s): enable_thinking');
        expect(describeUpstreamError(422, JSON.stringify({ detail: 'bad model' }))).to.equal('AI API error 422: bad model');
        expect(describeUpstreamError(500, '')).to.equal('AI API error: 500');
    });

    it('masks key-looking strings and truncates', () => {
        const msg = describeUpstreamError(401, 'invalid key nvapi-AbCdEf1234567890xyz, Bearer sk-secret123456789');
        expect(msg).to.not.include('nvapi-AbCdEf');
        expect(msg).to.not.include('sk-secret');
        expect(describeUpstreamError(400, 'x'.repeat(1000)).length).to.be.below(240);
    });
});

describe('RX4: chat routes use the retry + surface upstream errors', () => {
    function mount(safeFetch, model = 'qwen/qwen3-32b', baseUrl = QWEN_HOST) {
        const handlers = {};
        const app = {
            get: () => {}, patch: () => {}, delete: () => {},
            post: (p, ...h) => { handlers[p] = h[h.length - 1]; },
        };
        const chatEngine = createChatEngine({}, {
            validateBundleObject: () => ({ valid: true, errors: [] }),
            aiProfile: null,
        });
        createAssistantRoutes(app, null, {
            chatEngine,
            assistantPorts: {
                loadBook: () => null, persistBook: () => ({}),
                validateBundle: () => ({ valid: true, errors: [] }),
                validateBundleFile: () => ({ valid: true, errors: [] }),
                resolveChatAI: async () => ({ apiKey: 'k-test', baseUrl, model, source: 'workspace' }),
                sessionRepo: {
                    listSessionsForBook: async () => [],
                    getSession: async () => ({ id: 's1', book_id: 'b1', mode: 'chat', messages: [] }),
                    getMessages: async () => [], createSession: async () => {},
                    setMessages: async () => {}, renameSession: async () => null,
                    deleteSession: async () => null, getBookIdForSession: async () => 'b1',
                    purgeSessionsForBook: async () => {},
                },
                purgeForBook: async () => {},
                chatTransport: {
                    safeFetch, runSharedInference: async () => ({ ok: true }),
                    describeSharedError: (c) => String(c), chatAiSourceToken: () => 'cloud',
                },
                log: () => {},
            },
            utils: { log: () => {} },
        });
        return handlers;
    }

    function fakeRes() {
        const res = {
            statusCode: 200, body: null, chunks: [], headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return this; },
            setHeader() { this.headersSent = true; },
            flushHeaders() {}, write(c) { this.chunks.push(c); return true; },
            end() { this.ended = true; }, on() {}, once() {}, removeListener() {},
        };
        return res;
    }
    const req = () => ({ body: { session_id: 's1', message: 'hi' }, on() {}, once() {}, removeListener() {} });
    const sseEvents = (res) => res.chunks.join('')
        .split('\n\n').filter((b) => b.startsWith('event:'))
        .map((b) => ({ event: b.match(/^event: (\S+)/)[1], data: JSON.parse(b.split('\ndata: ')[1]) }));

    it('POST /api/v1/ai/chat: 400 unsupported → retry without enable_thinking → reply', async () => {
        const f = recordingFetch([unsupported400, () => ok200('hello')]);
        const h = mount(f);
        const res = fakeRes();
        await h['/api/v1/ai/chat'](req(), res);
        expect(f.calls).to.have.length(2);
        expect(f.calls[0].body).to.have.property('enable_thinking');
        expect(f.calls[1].body).to.not.have.property('enable_thinking');
        expect(res.statusCode).to.equal(200);
        expect(res.body.reply).to.equal('hello');
    });

    it('POST /api/v1/ai/chat/stream: same retry path → done', async () => {
        const f = recordingFetch([unsupported400, () => ok200('hello')]);
        const h = mount(f);
        const res = fakeRes();
        await h['/api/v1/ai/chat/stream'](req(), res);
        expect(f.calls).to.have.length(2);
        expect(f.calls[1].body).to.not.have.property('enable_thinking');
        const ev = sseEvents(res);
        expect(ev.map((e) => e.event)).to.include('done');
        expect(ev.find((e) => e.event === 'done').data.reply).to.equal('hello');
    });

    it('NVIDIA nemotron: no enable_thinking in the first request', async () => {
        const f = recordingFetch([() => ok200('hi')]);
        const h = mount(f, 'nvidia/llama-3.3-nemotron-super-49b-v1', NVIDIA);
        await h['/api/v1/ai/chat'](req(), fakeRes());
        expect(f.calls).to.have.length(1);
        expect(f.calls[0].body).to.not.have.property('enable_thinking');
    });

    it('upstream error → code + provider message, no key (both routes)', async () => {
        const bad = () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { message: 'Model not available' } }) });
        const h = mount(recordingFetch([bad]));
        const res = fakeRes();
        await h['/api/v1/ai/chat'](req(), res);
        expect(res.statusCode).to.equal(502);
        expect(res.body).to.deep.equal({ error: 'AI API error 400: Model not available', code: 'upstream_error' });

        const sres = fakeRes();
        await h['/api/v1/ai/chat/stream'](req(), sres);
        const err = sseEvents(sres).find((e) => e.event === 'error');
        expect(err.data).to.deep.equal({ error: 'AI API error 400: Model not available', code: 'upstream_error' });
        expect(JSON.stringify(sres.chunks)).to.not.include('k-test');
    });
});
