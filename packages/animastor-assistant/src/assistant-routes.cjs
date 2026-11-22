// ======================================================
// @animastor/assistant — AI CHAT ROUTES
// ======================================================
// All /api/v1/ai/* endpoints.
//
// Physically extracted from backend/src/routes/ai-routes.cjs
// (docs/architecture/ai-assistant-extraction.md). The contour receives
// ONLY the narrow AssistantPorts seam + chat engine. No storage barrel,
// no SQL, no whole Book/VBook services, no host service requires — book
// reads/writes, provider resolution, session persistence AND the
// transport legs (SSRF-guarded fetch, connector shared-inference,
// shared-error description, source-token mapping) all arrive through
// the injected ports (chatTransport), wired host-side at the composition
// root.

module.exports = function(app, redis, deps) {
    const {
        chatEngine,
        assistantPorts,
        utils,
    } = deps;
    const { log } = utils;
    // Token budget, provider-gated enable_thinking (+ the provider's reasoning
    // settings — chatEngine.chatRequestExtras), the one-shot
    // "Unsupported parameter" retry and upstream error text — package
    // logic (request-extras.cjs) carried by the engine.
    const {
        MAX_TOKENS_WITH_TOOLS, MAX_TOKENS_PLAIN,
        describeUpstreamError, fetchChatCompletion,
    } = chatEngine.requestExtras;
    // The ports seam is the single host contract of the Assistant contour.
    const {
        loadBook, persistBook, resolveChatAI,
        sessionRepo,
        chatTransport,
    } = assistantPorts;
    const { safeFetch, runSharedInference, describeSharedError, chatAiSourceToken } = chatTransport;
    const sharedPool = {
        runSharedInference,
        describeSharedError,
    };

    // ── Session ID counter ───────────────────────────
    let sessionIdCounter = 0;

    // ── Workspace AI provider (Experimental Beta) ──────────────────────
    // Phase 3: chat provider resolution lives on the Provider Gateway
    // (host Provider Gateway adapter) — the stable entry point consumers
    // use instead of the resolver internals. resolveChatAI is injected through
    // the AssistantPorts seam (bound to the gateway at the composition root).

    /** 503 guard — no usable AI provider (kill switch OFF / unconfigured). */
    function aiUnavailable(res) {
        return res.status(503).json({
            error: 'AI is currently unavailable. No AI provider is configured or system AI is disabled.',
            code: 'ai_unavailable',
        });
    }

    const AI_FETCH_TIMEOUT_MS = 180_000; // 3 minutes — AI providers need time for large book contexts

    // History entries with empty content (e.g. a UI-side "no result" turn
    // pushed as {assistant, ''}) fail the connector's strict non-empty
    // content validation — and would poison every later turn of the session.
    // Dropped at the seam by both chat routes via this filter.
    const hasNonEmptyContent = (m) => m && typeof m.content === 'string' && m.content.length > 0;

    // Local AI Connector per-message cap is 32 KB (lib/chat.cjs
    // maxMessageChars, mirrored by transport). The base system prompt plus
    // tool instructions must also fit, so the book context budget is kept
    // below it; anything larger rides as the compact structural summary.
    const CONNECTOR_BOOK_CONTEXT_BUDGET = 24 * 1024;

    // ── Hermesian tool call parser ──────────────────────
    // Qwen3-32B (reasoning model) sometimes outputs tool_call as text in content
    // instead of using the structured tool_calls field. This parser extracts those.
    function extractToolCallsFromContent(content) {
        if (!content) return { toolCalls: [], cleanedContent: content || '' };
        const extracted = [];
        let cleaned = content;
        let idx = 0;
        const now = Date.now();

        // Pattern 1: 〖tool_call〗...〖/tool_call〗 (Hermesian bracket format)
        cleaned = cleaned.replace(/[〖【]tool_call[〗】][\s\S]*?[〖【]\/tool_call[〗】]/g, (match) => {
            const inner = match.replace(/[〖【]\/?tool_call[〗】]/g, '').trim();
            const tc = _parseToolCallJson(inner, now, idx);
            if (tc) { extracted.push(tc); idx++; }
            return '';
        });

        // Pattern 2: Fallback — scan remaining content for any JSON object with balanced braces
        cleaned = _extractBalancedJsonToolCalls(cleaned, extracted, now);

        return { toolCalls: extracted, cleanedContent: cleaned.trim() };
    }

    function _extractBalancedJsonToolCalls(text, extracted, now) {
        let result = '';
        let i = 0;
        while (i < text.length) {
            if (text[i] === '{') {
                let depth = 1;
                let j = i + 1;
                while (j < text.length && depth > 0) {
                    if (text[j] === '{') depth++;
                    else if (text[j] === '}') depth--;
                    j++;
                }
                if (depth === 0) {
                    const candidate = text.slice(i, j);
                    try {
                        const parsed = JSON.parse(candidate);
                        const name = parsed.name || parsed.function?.name;
                        if (name) {
                            const args = parsed.arguments || parsed.function?.arguments || {};
                            extracted.push({
                                id: `call_content_${now}_${extracted.length}`,
                                type: 'function',
                                function: {
                                    name,
                                    arguments: typeof args === 'string' ? args : JSON.stringify(args)
                                }
                            });
                            i = j; // skip matched part
                            continue;
                        }
                    } catch (_) {}
                }
            }
            result += text[i];
            i++;
        }
        return result;
    }

    function _parseToolCallJson(text, now, idx) {
        try {
            const p = JSON.parse(text);
            const name = p.name || p.function?.name;
            if (name) {
                const args = p.arguments || p.function?.arguments || {};
                return {
                    id: `call_content_${now}_${idx}`,
                    type: 'function',
                    function: {
                        name,
                        arguments: typeof args === 'string' ? args : JSON.stringify(args)
                    }
                };
            }
        } catch (_) {
            // Try extracting JSON from arbitrary surrounding text
            const m = text.match(/\{[\s\S]*\}/);
            if (m) {
                try {
                    const p = JSON.parse(m[0]);
                    const name = p.name || p.function?.name;
                    if (name) {
                        const args = p.arguments || p.function?.arguments || {};
                        return {
                            id: `call_content_${now}_${idx}`,
                            type: 'function',
                            function: {
                                name,
                                arguments: typeof args === 'string' ? args : JSON.stringify(args)
                            }
                        };
                    }
                } catch (_2) {}
            }
        }
        return null;
    }

    // ======================================================
    // LIST SESSIONS (metadata only — messages live behind /messages)
    // ======================================================
    app.get('/api/v1/ai/sessions', async (req, res) => {
        try {
            const { book_id } = req.query;
            const sessions = await sessionRepo.listSessionsForBook(book_id);
            res.json({ sessions });
        } catch (err) {
            console.error('[AI SESSIONS LIST] Error:', err.message);
            res.json({ sessions: [] });
        }
    });

    // ======================================================
    // GET SESSION
    // ======================================================
    app.get('/api/v1/ai/sessions/:id', async (req, res) => {
        try {
            const session = await sessionRepo.getSession(req.params.id);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            res.json({ session });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // RENAME SESSION (PATCH) — Android parity: BackendApi.kt PATCHes
    // { title } (BackendApi.kt:78). The route never existed → silent 404.
    // ======================================================
    app.patch('/api/v1/ai/sessions/:id', async (req, res) => {
        try {
            const { title } = req.body || {};
            if (typeof title !== 'string' || !title.trim()) {
                return res.status(400).json({ error: 'title required' });
            }
            const renamedId = await sessionRepo.renameSession(
                req.params.id, title.trim().slice(0, 200)
            );
            if (!renamedId) return res.status(404).json({ error: 'Session not found' });
            log('[AI] Session renamed:', req.params.id);
            res.json({ session_id: req.params.id, title: title.trim(), renamed: true });
        } catch (err) {
            console.error('[AI SESSION RENAME] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // DELETE SESSION — Android parity (BackendApi.kt:84) and web parity
    // (AiAssistantPage deleteSession). Both clients called this route when
    // it did not exist → silent 404, chats never deleted server-side.
    // ======================================================
    app.delete('/api/v1/ai/sessions/:id', async (req, res) => {
        try {
            const deletedId = await sessionRepo.deleteSession(req.params.id);
            if (!deletedId) return res.status(404).json({ error: 'Session not found' });
            log('[AI] Session deleted:', req.params.id);
            res.json({ session_id: req.params.id, deleted: true });
        } catch (err) {
            console.error('[AI SESSION DELETE] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // GET SESSION MESSAGES (session.messages JSON via the sessionRepo port)
    // ======================================================
    app.get('/api/v1/ai/sessions/:id/messages', async (req, res) => {
        try {
            const session = await sessionRepo.getSession(req.params.id);
            if (!session) return res.json({ messages: [] });
            const msgs = session.messages || [];
            const formatted = msgs.map((m, i) => ({
                id: i + 1,
                book_id: session.book_id,
                session_id: session.id,
                role: m.role || 'user',
                message: m.content || m.message || '',
                error: !!m.error,
                created_at: m.timestamp || Date.now(),
            }));
            res.json({ messages: formatted });
        } catch (err) {
            console.error('[AI SESSION MESSAGES] Error:', err.message);
            res.json({ messages: [] });
        }
    });

    // ======================================================
    // CREATE SESSION
    // ======================================================
    app.post('/api/v1/ai/sessions', async (req, res) => {
        try {
            const { book_id, title, mode, topic_id } = req.body || {};
            const scopedBookId = req.scopedBookId || book_id || null;
            if (!scopedBookId) return res.status(400).json({ error: 'book_id required' });

            const id = `ai-session-${Date.now()}-${++sessionIdCounter}`;
            const cleanTitle = (typeof title === 'string' && title.trim()) ? title.trim().slice(0, 200) : 'Chat';
            const session = {
                id, book_id: scopedBookId, title: cleanTitle, mode: mode || 'chat',
                topic_id: topic_id || 'book',
                messages: [], created_at: Date.now(), updated_at: Date.now(),
                context: null, locked: false,
            };

            await sessionRepo.createSession(session);

            log('[AI] Created session:', id, 'for book:', book_id, 'mode:', session.mode);
            res.json({ session });
        } catch (err) {
            console.error('[AI CREATE SESSION] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CHAT (non-streaming)
    // ======================================================
    app.post('/api/v1/ai/chat', async (req, res) => {
        // Hoisted so the catch block can persist the failed turn (user
        // message + error explanation) into the session history — without
        // this the 504 explanation never reached the UI after a reload
        // (messages live behind the sessionRepo port — PG is host-side).
        let activeSessionId = null;
        let userContent = '';
        // Consumer-side AI source provenance (Phase 2): 'private-local' |
        // 'shared' | 'cloud' | 'system' — a safe token for the UI badge,
        // never endpoint/owner detail.
        let aiSource = null;
        try {
            const { session_id, message, messages, book_id, system, mode, scene_id, topic_id } = req.body || {};

            // Accept either `messages` array (frontend format) or `message` string (legacy)
            const hasMessagesArray = Array.isArray(messages) && messages.length > 0;
            if (!hasMessagesArray && !message) {
                return res.status(400).json({ error: 'messages or message required' });
            }

            // The AUTHORIZED book — set by aiBookGuard. Never re-derive a
            // different one from the body (cross-tenant provider/data/write).
            const scopedBookId = req.scopedBookId || book_id || null;

            // Auto-create session if session_id not provided
            activeSessionId = session_id;
            if (!activeSessionId) {
                if (!scopedBookId) {
                    return res.status(400).json({ error: 'book_id required when no session_id' });
                }
                const id = `ai-session-${Date.now()}-${++sessionIdCounter}`;
                await sessionRepo.createSession({
                    id, book_id: scopedBookId, mode: mode || 'chat',
                    topic_id: topic_id || 'book',
                    messages: [], created_at: Date.now(), updated_at: Date.now(),
                });
                activeSessionId = id;
                log('[AI] Auto-created session:', id, 'for book:', scopedBookId);
            }

            const session = await sessionRepo.getSession(activeSessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            const storedMessages = session.messages || [];
            const bookId = req.scopedBookId || book_id || session.book_id;

            // Load book data for context (AssistantPorts seam — canonical ||
            // draft fallback lives inside the facade)
            let bookData = null;
            try { bookData = loadBook(bookId); } catch (_) {}

            const isLocked = bookData?.manifest?.locked === true;
            const sessionMode = mode || session.mode || 'chat';
            const tools = chatEngine.getToolsForMode(sessionMode, bookId, isLocked);

            const ai = await resolveChatAI(bookId);
            // Connector snapshots legitimately carry no apiKey (LAC §9) —
            // the connector path is guarded below at the fetch site.
            if (!ai.apiKey && ai.transport !== 'connector') return aiUnavailable(res);
            // A connector binding without a usable model id (no bound model,
            // no discovered models) must fail closed with a clear message.
            if (ai.transport === 'connector' && (!ai.connectorId || !ai.model)) {
                return res.status(503).json({
                    error: 'Local AI is not ready — select a connector and a model in Settings / AI',
                    code: 'local_ai_not_ready',
                });
            }

            // Build system prompt:
            // - If `system` is explicitly provided (legacy clients), use it as base
            // - Otherwise, build from structured fields (mode, topic, lang, position)
            //   via chatEngine.buildChatSystemPrompt() — this replaces the client-side
            //   system prompt assembly in AiAssistantFragment.sendMessage().
            let systemPrompt;
            if (system) {
                // Legacy path: frontend sent fully assembled prompt
                systemPrompt = system;
    
            } else {
                // F6 path: assemble from structured fields on the server.
                systemPrompt = chatEngine.buildChatSystemPrompt({
                    mode: mode || session.mode || 'conversation',
                    topic: topic_id || session.topic_id || 'book',
                    lang: req.body?.lang || 'auto',
                    bookData,
                    sceneId: req.body?.scene_id || null,
                    unitIndex: req.body?.unit_index ?? null,
                    modelName: ai.model,
                });

            }

            const canEdit = tools.length > 0;
            const bookContext = chatEngine.buildBookContext(bookData, { canEdit });
            if (bookContext) {
                // Connector per-message cap is 32 KB (ai-connector
                // lib/chat.cjs maxMessageChars, mirrored by the transport) —
                // the full book JSON for real books does not fit. Oversized
                // context falls back to the compact structural summary so a
                // private-local request fails closed on nothing else.
                const withinConnectorBudget = bookContext.length <= CONNECTOR_BOOK_CONTEXT_BUDGET;
                systemPrompt += '\n\n' + (ai.transport !== 'connector' || withinConnectorBudget
                    ? bookContext
                    : chatEngine.buildCompactBookContext(bookData, { canEdit }));
            }

            // Build API messages for AI call
            let apiMessages;

            if (hasMessagesArray) {
                // Frontend format: full history in `messages` array, `system` as system prompt
                apiMessages = [
                    { role: 'system', content: systemPrompt },
                    ...messages.filter(hasNonEmptyContent),
                ];
                const lastUser = messages.filter(m => m.role === 'user').pop();
                userContent = lastUser?.content || '';
            } else {
                // Legacy format: single `message` string, reconstruct from DB
                userContent = message;
                apiMessages = [
                    { role: 'system', content: systemPrompt },
                    ...(storedMessages.slice(-20).map(m => ({ role: m.role, content: m.content }))),
                    { role: 'user', content: message },
                ];
            }

            let aiResponse;
            let processed = null;
            let retried = false;
            if (ai.transport === 'connector') {
                // Local AI Connector path (LAC §9): the completion rides the
                // connector's authenticated WS session — no server-side URL,
                // no Authorization header, no SSRF surface (AD-5). The cloud
                // timer is authoritative (§5); runSharedInference maps to the
                // sanitized code surface (§4) and, for SHARED snapshots
                // (Phase 2), owns the per-inference pool slot (reserved
                // before the call; released on success/error/timeout/cancel/
                // disconnect via its finally). Tool payloads are NOT
                // forwarded (Phase-4 contract: only max_tokens/temperature
                // survive) — content-embedded tool calls still go through
                // extractToolCallsFromContent below.
                const tokenBudget = tools.length > 0
                    ? Math.min(MAX_TOKENS_WITH_TOOLS, 8192) // connector LIMITS.maxMaxTokens
                    : MAX_TOKENS_PLAIN;
                // Shared capacity is borrowed: a consumer that walked away
                // must not keep burning the owner's slot — res 'close' before
                // the response completed aborts the request (the private
                // path keeps its existing no-abort semantics unchanged).
                let disconnectSignal = null;
                let onConnClosed = null;
                if (ai.source === 'shared') {
                    const abort = new AbortController();
                    disconnectSignal = abort.signal;
                    onConnClosed = () => { if (!res.writableEnded) abort.abort(); };
                    res.on('close', onConnClosed);
                }
                let cres;
                try {
                    cres = await sharedPool.runSharedInference(ai, {
                        model: ai.model,
                        messages: apiMessages,
                        params: { max_tokens: tokenBudget, temperature: 0.3 },
                    }, { timeoutMs: AI_FETCH_TIMEOUT_MS, signal: disconnectSignal });
                } finally {
                    if (onConnClosed) res.removeListener('close', onConnClosed);
                }
                if (!cres.ok) {
                    const code = cres.code || 'runtime_error';
                    const status = (code === 'connector_offline' || code === 'shared_unavailable' || code === 'busy')
                        ? 503 : (code === 'timeout' || code === 'cancelled' ? 504 : 502);
                    console.error(`[AI] connector chat error: ${code}`);
                    return res.status(status).json({
                        error: sharedPool.describeSharedError(code),
                        code,
                    });
                }
                aiResponse = {
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: cres.content },
                        finish_reason: cres.finishReason || 'stop',
                    }],
                    usage: cres.usage || undefined,
                };
                // Consumer-side source provenance (Phase 2, minimal):
                // 'private-local' | 'shared' — safe token only, no endpoint
                // or owner detail rides the API response.
                aiSource = ai.source === 'shared' ? 'shared' : 'private-local';
            } else {
                // Cloud provider: the edit turn (with the one corrective
                // retry when the model claimed a change without calling
                // edit_book) — shared with the stream route.
                const turn = await runCloudTurn(ai, apiMessages, tools, bookData, bookId, {
                    canEdit, logTag: '[AI]', timeoutMs: AI_FETCH_TIMEOUT_MS,
                });
                if (turn.error) {
                    const upstreamError = describeUpstreamError(turn.error.status, turn.error.errText); // key-masked
                    console.error('[AI]', upstreamError);
                    return res.status(502).json({ error: upstreamError, code: 'upstream_error' });
                }
                processed = turn.processed;
                retried = turn.retried;
                aiResponse = turn.aiResponse;
            }
            if (!processed) {
                // Connector reply: no structured tool_calls (Phase-4 contract) —
                // content-embedded tool calls are extracted by processChatReply.
                const aiMessage = aiResponse.choices?.[0]?.message;
                processed = processChatReply(aiMessage?.content || '', aiMessage?.tool_calls || [], bookData, bookId, {
                    canEdit, logTag: '[AI]', finishReason: aiResponse.choices?.[0]?.finish_reason || null,
                });
            }
            logTurn('[AI]', {
                sessionId: activeSessionId, mode: sessionMode, ai, processed, retried,
                finishReason: aiResponse?.choices?.[0]?.finish_reason || null,
            });
            const { replyText, toolCalls, toolResults, patches, validationErrors, editOutcome } = processed;

            // Update session messages: merge with stored history
            const updatedMessages = [
                ...storedMessages,
                { role: 'user', content: userContent, timestamp: Date.now() },
                { role: 'assistant', content: replyText, tool_calls: toolCalls, timestamp: Date.now() },
            ];

            await sessionRepo.setMessages(activeSessionId, updatedMessages);

            // Structured validation info for the assistant/API: names the exact
            // file/resource that failed the bundle contract, so a corrective
            // patch ("почини voices.json") lands in the very next turn —
            // the error reply is stored in session history for that purpose.
            res.json({
                reply: replyText,
                tool_calls: toolCalls,
                tool_results: toolResults,
                patches_applied: patches.length,
                validation_errors: validationErrors,
                edit_outcome: editOutcome,
                session_id: activeSessionId,
                ai_source: aiSource || (ai.source === 'workspace' ? 'cloud' : (ai.source === 'system' ? 'system' : ai.source)),
            });
        } catch (err) {
            console.error('[AI CHAT] Error:', err.message);
            if (err.code === 'ENDPOINT_NOT_PUBLIC') {
                return res.status(502).json({ error: err.message });
            }
            if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
                // Persist the failed turn (user message + explanation) so the
                // explanation survives a reload and is visible in session
                // history. Best-effort: a PG hiccup must not mask the 504.
                try {
                    if (activeSessionId) {
                        const msgs = await sessionRepo.getMessages(activeSessionId);
                        msgs.push({ role: 'user', content: userContent, timestamp: Date.now() });
                        msgs.push({
                            role: 'assistant',
                            content: '⚠️ AI не ответил за отведённое время. Попробуйте отправить более короткий запрос или повторить позже.',
                            error: true, timestamp: Date.now(),
                        });
                        await sessionRepo.setMessages(activeSessionId, msgs);
                    }
                } catch (persistErr) {
                    console.error('[AI CHAT] Failed to persist timeout turn:', persistErr.message);
                }
                return res.status(504).json({ error: 'AI не ответил за отведённое время. Попробуйте отправить более короткий запрос или повторить позже.', code: 'ai_timeout' });
            }
            res.status(500).json({ error: err.message });
        }
    });

    // ======================================================
    // CHAT STREAM (production SSE — Phase 3 LLM sharing)
    // ======================================================
    // The production streaming path:
    //
    //   Browser → THIS route → resolver (resolveChatAI — the SAME seam as
    //   the non-streaming chat route) → private connector OR shared pool
    //   endpoint → connector WS → local runtime SSE → connector chat.delta
    //   → here → HTTP SSE to the browser.
    //
    // ONE transport, ONE protocol: connector inference rides the existing
    // runSharedInference streaming branch (params.stream:true over the
    // connector WS — Phase 5 chat.delta machinery unchanged); shared slots
    // keep the exact Phase 2 lifecycle (reserved before the call, released
    // on success/error/timeout/cancel/disconnect via its finally). Cloud
    // providers keep their existing non-streaming upstream call (re-emitted
    // as ONE delta + terminal — no second upstream protocol is invented).
    //
    // SSE contract (one JSON object per `data:` frame):
    //   meta  { session_id, ai_source, model }   — once, after resolution
    //   delta { delta: "text" }                  — N× (connector streams;
    //                                              cloud = one full-text delta)
    //   done  { reply, tool_calls, tool_results, patches_applied,
    //           validation_errors, session_id, ai_source, usage,
    //           finish_reason }                  — terminal, exactly once
    //   error { error, code, partial? }          — terminal, exactly once
    //                                           (sanitized code + fixed
    //                                           message only)
    // Exactly ONE terminal event (done XOR error) is ever written. Raw
    // runtime errors, URLs, credentials and connector secrets never cross —
    // every failure degrades to the sanitized code surface (Phase 2 §5).
    //
    // Cancellation path (critical): HTTP client disconnect → res 'close' →
    // AbortSignal → connector transport chat.cancel → local runtime abort
    // → slot released by runSharedInference's finally. No pending request
    // and no shared slot survives any failure path.
    // ======================================================
    // <think>…</think> reasoning blocks are internal — they must not appear
    // in the user-visible stream (the non-streaming route strips them from
    // the final text). The stream filter suppresses them incrementally,
    // holding back a possible partial tag so a tag split across two deltas
    // is still caught. The terminal done event carries the SAME fully
    // stripped/processed reply as the non-streaming route, so the client
    // always converges to the canonical text.
    function makeThinkFilter() {
        let inside = false;
        let tail = '';
        const partialTagLen = (text, tag) => {
            const max = Math.min(tag.length - 1, text.length);
            for (let k = max; k > 0; k--) {
                if (text.endsWith(tag.slice(0, k))) return k;
            }
            return 0;
        };
        return (delta) => {
            let text = tail + delta;
            tail = '';
            let out = '';
            while (text) {
                if (!inside) {
                    const i = text.indexOf('<think>');
                    if (i === -1) {
                        const hold = partialTagLen(text, '<think>');
                        out += text.slice(0, text.length - hold);
                        tail = text.slice(text.length - hold);
                        break;
                    }
                    out += text.slice(0, i);
                    text = text.slice(i + 7);
                    inside = true;
                } else {
                    const j = text.indexOf('</think>');
                    if (j === -1) {
                        const hold = partialTagLen(text, '</think>');
                        tail = text.slice(text.length - hold);
                        break;
                    }
                    text = text.slice(j + 8);
                    inside = false;
                }
            }
            return out;
        };
    }

    // The bounded per-request inference window for the stream route: the
    // client may tighten it (its own request), the cloud timer stays
    // authoritative (transport clamps to the same 180 s ceiling).
    const STREAM_MIN_TIMEOUT_MS = 1_000;

    function clampStreamTimeoutMs(raw) {
        const n = Number(raw);
        if (!Number.isFinite(n)) return AI_FETCH_TIMEOUT_MS;
        return Math.max(STREAM_MIN_TIMEOUT_MS, Math.min(Math.floor(n), AI_FETCH_TIMEOUT_MS));
    }

    // Map a resolved chat provider to the SAFE consumer-facing source token
    // (Phase 2 §6 discipline: 'private-local' | 'shared' | 'cloud' | 'system'
    // — never endpoint/owner detail). The token mapping lives on the host
    // Provider Gateway; the contour reaches it through the injected
    // chatTransport port (composition-root bound).

    app.post('/api/v1/ai/chat/stream', async (req, res) => {
        // Hoisted for the failure-persistence helpers (same rationale as the
        // non-streaming route: a failed turn must survive a reload).
        let activeSessionId = null;
        let userContent = '';
        let storedMessages = [];
        const aiSource = { value: null };
        // Terminal-event contract: exactly one terminal frame, ever.
        let terminalSent = false;
        let heartbeat = null;

        // Best-effort persistence of a FAILED turn (user message + sanitized
        // explanation / partial answer) — mirrors the non-streaming route's
        // catch-block discipline. Never masks the terminal event.
        const persistFailedTurn = async (assistantText) => {
            try {
                if (!activeSessionId) return;
                const msgs = await sessionRepo.getMessages(activeSessionId);
                if (userContent) msgs.push({ role: 'user', content: userContent, timestamp: Date.now() });
                if (assistantText) {
                    msgs.push({ role: 'assistant', content: assistantText, error: true, timestamp: Date.now() });
                }
                await sessionRepo.setMessages(activeSessionId, msgs);
            } catch (persistErr) {
                console.error('[AI STREAM] Failed to persist failed turn:', persistErr.message);
            }
        };

        try {
            const { session_id, message, messages, book_id, system, mode, scene_id, topic_id } = req.body || {};

            // Same input contract as the non-streaming route.
            const hasMessagesArray = Array.isArray(messages) && messages.length > 0;
            if (!hasMessagesArray && !message) {
                return res.status(400).json({ error: 'messages or message required' });
            }

            const scopedBookId = req.scopedBookId || book_id || null;

            activeSessionId = session_id;
            if (!activeSessionId) {
                if (!scopedBookId) {
                    return res.status(400).json({ error: 'book_id required when no session_id' });
                }
                const id = `ai-session-${Date.now()}-${++sessionIdCounter}`;
                await sessionRepo.createSession({
                    id, book_id: scopedBookId, mode: mode || 'chat',
                    topic_id: topic_id || 'book',
                    messages: [], created_at: Date.now(), updated_at: Date.now(),
                });
                activeSessionId = id;
                log('[AI STREAM] Auto-created session:', id, 'for book:', scopedBookId);
            }

            const session = await sessionRepo.getSession(activeSessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });

            storedMessages = session.messages || [];
            const bookId = req.scopedBookId || book_id || session.book_id;

            let bookData = null;
            // AssistantPorts seam — canonical || draft fallback lives inside
            // the Book Model facade
            try { bookData = loadBook(bookId); } catch (_) {}

            const isLocked = bookData?.manifest?.locked === true;
            const sessionMode = mode || session.mode || 'chat';
            const tools = chatEngine.getToolsForMode(sessionMode, bookId, isLocked);

            // The SAME resolver seam as the non-streaming route — shared AI,
            // private Local AI and cloud providers all flow through here.
            const ai = await resolveChatAI(bookId);
            if (!ai.apiKey && ai.transport !== 'connector') return aiUnavailable(res);
            if (ai.transport === 'connector' && (!ai.connectorId || !ai.model)) {
                return res.status(503).json({
                    error: 'Local AI is not ready — select a connector and a model in Settings / AI',
                    code: 'local_ai_not_ready',
                });
            }
            aiSource.value = chatAiSourceToken(ai);

            let systemPrompt;
            if (system) {
                systemPrompt = system;
            } else {
                systemPrompt = chatEngine.buildChatSystemPrompt({
                    mode: mode || session.mode || 'conversation',
                    topic: topic_id || session.topic_id || 'book',
                    lang: req.body?.lang || 'auto',
                    bookData,
                    sceneId: req.body?.scene_id || null,
                    unitIndex: req.body?.unit_index ?? null,
                    modelName: ai.model,
                });
            }

            const canEdit = tools.length > 0;
            const bookContext = chatEngine.buildBookContext(bookData, { canEdit });
            if (bookContext) {
                // Same connector per-message cap as the non-streaming route —
                // oversized book JSON falls back to the compact summary.
                const withinConnectorBudget = bookContext.length <= CONNECTOR_BOOK_CONTEXT_BUDGET;
                systemPrompt += '\n\n' + (ai.transport !== 'connector' || withinConnectorBudget
                    ? bookContext
                    : chatEngine.buildCompactBookContext(bookData, { canEdit }));
            }

            let apiMessages;
            if (hasMessagesArray) {
                // Same empty-content guard as the non-streaming route — one
                // empty turn must not poison the rest of the session.
                apiMessages = [
                    { role: 'system', content: systemPrompt },
                    ...messages.filter(hasNonEmptyContent),
                ];
                const lastUser = messages.filter(m => m.role === 'user').pop();
                userContent = lastUser?.content || '';
            } else {
                userContent = message;
                apiMessages = [
                    { role: 'system', content: systemPrompt },
                    ...(storedMessages.slice(-20).map(m => ({ role: m.role, content: m.content }))),
                    { role: 'user', content: message },
                ];
            }

            // ── Stream phase: headers go out; every failure from here on is
            // a terminal SSE error event (never a raw runtime detail). ──
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
            res.flushHeaders?.();

            const writeEvent = (event, data) => {
                try {
                    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                    return true;
                } catch (_) { return false; }
            };
            const sendTerminal = (event, data) => {
                if (terminalSent) return;
                terminalSent = true;
                writeEvent(event, data);
                try { res.end(); } catch (_) {}
            };

            // Heartbeat comment keeps proxies/clients alive during long
            // model cold-loads (30–60 s with no delta); SSE comments are
            // ignored by parsers.
            heartbeat = setInterval(() => {
                try { res.write(': ping\n\n'); } catch (_) {}
            }, 15_000);
            if (heartbeat.unref) heartbeat.unref();

            // Cancel path: HTTP disconnect → AbortSignal → connector
            // transport chat.cancel → runtime abort → slot freed. Applies to
            // EVERY source on this route (the client is gone — the inference
            // must stop; the non-streaming route keeps its own semantics).
            const abort = new AbortController();
            let clientGone = false;
            const onConnClosed = () => {
                clientGone = true;
                abort.abort();
            };
            res.on('close', onConnClosed);

            writeEvent('meta', {
                session_id: activeSessionId,
                ai_source: aiSource.value,
                model: ai.model || undefined,
            });

            let finalReply = '';
            let terminalPayload = null;
            try {
                if (ai.transport === 'connector') {
                    const tokenBudget = tools.length > 0
                        ? Math.min(MAX_TOKENS_WITH_TOOLS, 8192)
                        : MAX_TOKENS_PLAIN;
                    const filter = makeThinkFilter();
                    let streamedLen = 0;
                    const cres = await sharedPool.runSharedInference(ai, {
                        model: ai.model,
                        messages: apiMessages,
                        params: { max_tokens: tokenBudget, temperature: 0.3 },
                    }, {
                        timeoutMs: clampStreamTimeoutMs(req.body?.timeout_ms),
                        signal: abort.signal,
                        onDelta: (delta) => {
                            const visible = filter(delta);
                            if (!visible) return;
                            streamedLen += visible.length;
                            if (!writeEvent('delta', { delta: visible })) {
                                // The client is gone mid-stream — stop the
                                // inference the same way a disconnect does.
                                abort.abort();
                            }
                        },
                    });
                    if (!cres.ok) {
                        console.error(`[AI STREAM] connector stream error: ${cres.code}`);
                        // Partial output is never lost: the client already
                        // holds the deltas; the error frame re-states the
                        // visible partial for reconciliation.
                        const partial = (clientGone ? null : (cres.partial || (streamedLen > 0 ? null : null)));
                        const errorData = {
                            error: sharedPool.describeSharedError(cres.code),
                            code: cres.code || 'runtime_error',
                        };
                        if (cres.partial) errorData.partial = cres.partial;
                        else if (partial) errorData.partial = partial;
                        if (!clientGone) sendTerminal('error', errorData);
                        await persistFailedTurn(
                            cres.partial || (streamedLen > 0 ? null : `⚠️ ${errorData.error}`)
                        );
                        return;
                    }
                    // Terminal success → the SAME post-processing pipeline as
                    // the non-streaming route (strip, tool extraction, patch
                    // application, persistence) on the FULL content. The
                    // canonical text replaces any streamed approximation
                    // client-side (converge-on-terminal semantics — the same
                    // contract as OpenAI SSE clients).
                    const processed = processChatReply(cres.content || '', [], bookData, bookId, {
                        canEdit, logTag: '[AI STREAM]', finishReason: cres.finishReason || null,
                    });
                    logTurn('[AI STREAM]', {
                        sessionId: activeSessionId, mode: sessionMode, ai, processed, retried: false,
                        finishReason: cres.finishReason || null,
                    });
                    finalReply = processed.replyText;
                    terminalPayload = {
                        reply: finalReply,
                        tool_calls: processed.toolCalls,
                        tool_results: processed.toolResults,
                        patches_applied: processed.patches.length,
                        validation_errors: processed.validationErrors,
                        edit_outcome: processed.editOutcome,
                        session_id: activeSessionId,
                        ai_source: aiSource.value,
                        finish_reason: cres.finishReason || 'stop',
                        ...(cres.usage ? { usage: cres.usage } : {}),
                    };
                    await persistSuccessTurn(storedMessages, userContent, finalReply, processed.toolCalls);
                } else {
                    // Cloud provider branch: the existing non-streaming
                    // upstream call, re-emitted as ONE delta + terminal. No
                    // second upstream protocol; cloud behavior unchanged —
                    // except the one corrective retry of an edit turn whose
                    // reply claimed a change without calling edit_book.
                    const turn = await runCloudTurn(ai, apiMessages, tools, bookData, bookId, {
                        canEdit, logTag: '[AI STREAM]',
                        timeoutMs: clampStreamTimeoutMs(req.body?.timeout_ms),
                        signal: abort.signal,
                    });
                    if (turn.error) {
                        const errorData = { error: describeUpstreamError(turn.error.status, turn.error.errText), code: 'upstream_error' }; // key-masked
                        console.error('[AI STREAM]', errorData.error);
                        if (!clientGone) sendTerminal('error', errorData);
                        await persistFailedTurn(`⚠️ ${errorData.error}`);
                        return;
                    }
                    const aiResponse = turn.aiResponse;
                    const processed = turn.processed;
                    logTurn('[AI STREAM]', {
                        sessionId: activeSessionId, mode: sessionMode, ai, processed, retried: turn.retried,
                        finishReason: aiResponse.choices?.[0]?.finish_reason || null,
                    });
                    finalReply = processed.replyText;
                    if (finalReply && !clientGone) writeEvent('delta', { delta: finalReply });
                    terminalPayload = {
                        reply: finalReply,
                        tool_calls: processed.toolCalls,
                        tool_results: processed.toolResults,
                        patches_applied: processed.patches.length,
                        validation_errors: processed.validationErrors,
                        edit_outcome: processed.editOutcome,
                        session_id: activeSessionId,
                        ai_source: aiSource.value,
                        finish_reason: aiResponse.choices?.[0]?.finish_reason || 'stop',
                        ...(aiResponse.usage ? { usage: aiResponse.usage } : {}),
                    };
                    await persistSuccessTurn(storedMessages, userContent, finalReply, processed.toolCalls);
                }

                if (!clientGone) sendTerminal('done', terminalPayload);
                else persistFailedTurn(finalReply || '⚠️ Generation cancelled.').catch?.(() => {});
            } catch (err) {
                // Mid-stream failure → ONE safe terminal error. Client aborts
                // and dead sockets are not "errors" for the client (it is
                // gone) — the inference is already cancelled via the signal.
                const isAbort = err.name === 'AbortError' || err.code === 'ABORT_ERR';
                if (err.code === 'ENDPOINT_NOT_PUBLIC') {
                    const errorData = { error: err.message, code: 'endpoint_not_allowed' };
                    if (!clientGone) sendTerminal('error', errorData);
                    await persistFailedTurn(`⚠️ ${errorData.error}`);
                } else if (isAbort && !clientGone) {
                    const errorData = { error: 'AI не ответил за отведённое время. Попробуйте отправить более короткий запрос или повторить позже.', code: 'timeout' };
                    sendTerminal('error', errorData);
                    await persistFailedTurn(`⚠️ ${errorData.error}`);
                } else if (!clientGone) {
                    const errorData = { error: 'AI streaming request failed.', code: 'stream_error' };
                    sendTerminal('error', errorData);
                    await persistFailedTurn(`⚠️ ${errorData.error}`);
                } else if (isAbort) {
                    await persistFailedTurn(finalReply || '⚠️ Generation cancelled.');
                }
            } finally {
                if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
                res.removeListener('close', onConnClosed);
                streamFinished = true;
            }
            return;
        } catch (err) {
            // Pre-flight failure AFTER the SSE headers went out must still
            // honor the terminal contract; before that, plain JSON errors
            // apply (handled by the returns above).
            console.error('[AI STREAM] Error:', err.message);
            if (terminalSent || res.headersSent) {
                sendTerminal('error', { error: 'AI streaming request failed.', code: 'stream_error' });
                return;
            }
            if (err.code === 'ENDPOINT_NOT_PUBLIC') {
                return res.status(502).json({ error: err.message });
            }
            res.status(500).json({ error: err.message });
        }

        // ── local helpers (per-request) ──
        // Persist a successful turn: identical merge semantics to the
        // non-streaming route (full stored history + user + assistant).
        async function persistSuccessTurn(prevMessages, userText, replyText, toolCalls) {
            try {
                const updatedMessages = [
                    ...prevMessages,
                    ...(userText ? [{ role: 'user', content: userText, timestamp: Date.now() }] : []),
                    { role: 'assistant', content: replyText, tool_calls: toolCalls || [], timestamp: Date.now() },
                ];
                await sessionRepo.setMessages(activeSessionId, updatedMessages);
            } catch (persistErr) {
                console.error('[AI STREAM] Failed to persist turn:', persistErr.message);
            }
        }
    });

    // Reply post-processing shared by BOTH chat routes (non-streaming and
    // stream, every transport): think blocks, tool_call remnants,
    // content-embedded tool calls, edit_book application with validation,
    // ONE save through persistBook, and the honest reply.
    //
    // Honest edit outcome (0.3.1, reports/2026-11-22/assistant-edit-bug.md):
    // the user-visible reply never says a change happened unless it was
    // saved. editOutcome:
    //   'applied'             — patches validated AND persisted;
    //   'rejected'            — edit_book was called, nothing was saved
    //                           (path guard, contract validation, save error);
    //                           the model's own text (often "Done") is
    //                           replaced by the error;
    //   'claimed_not_applied' — edit_book was offered, NOT called, and the
    //                           reply claims a change / pastes a changed JSON;
    //                           the reply is replaced by "NOT changed";
    //   'none'                — no edit involved.
    // edit_book outside an edit-capable turn (other mode, locked book) is
    // refused — before 0.3.1 a content-embedded call was applied in any mode.
    function processChatReply(rawContent, structuredToolCalls, bookData, bookId, opts = {}) {
        const canEdit = opts.canEdit === true;
        const logTag = opts.logTag || '[AI]';
        const finishReason = opts.finishReason || null;
        let replyText = rawContent || '';
        replyText = replyText.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        replyText = replyText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
        replyText = replyText.replace(/<\/?tool_call[^>]*>/gi, '').trim();
        replyText = replyText.replace(/tool_call[^>]*>/gi, '').trim();
        replyText = replyText.replace(/\/?tool_call\b/gi, '').trim();
        replyText = replyText.replace(/[a-z]*_call[^>]*>/gi, '').trim();

        // Only extract tool calls from content if the model didn't return
        // structured tool_calls (Qwen3 sometimes puts them in both places).
        let contentToolCalls = [];
        if ((structuredToolCalls || []).length === 0) {
            const result = extractToolCallsFromContent(replyText);
            contentToolCalls = result.toolCalls;
            replyText = result.cleanedContent;
        }
        // Garbage remnants ('ool_call>' …) count as an empty reply.
        if (replyText && replyText.length < 30 && (!/[\wЀ-ӿ]{3,}/.test(replyText) || /_call/i.test(replyText))) {
            replyText = '';
        }
        const toolCalls = [...contentToolCalls, ...(structuredToolCalls || [])];

        const toolResults = [];
        const editErrors = [];
        const appliedPatches = [];
        let editCalled = false;
        // Every edit_book call of the turn applies on top of the previous
        // one (cumulative), validated each time; the book is saved ONCE.
        let workingBook = bookData;

        for (const tc of toolCalls) {
            const name = tc && tc.function && tc.function.name;
            if (name !== 'edit_book') {
                toolResults.push({ tool: name, result: 'Tool executed (no handler)' });
                continue;
            }
            editCalled = true;
            let err = null;
            let validationErrors = [];
            if (!canEdit) {
                err = 'the book cannot be changed in this mode (switch to the Edit mode; a locked book cannot be edited)';
            } else if (!bookData) {
                err = 'the book could not be loaded';
            } else {
                try {
                    const list = chatEngine.editBookPatches(tc.function.arguments);
                    if (list.length === 0) {
                        err = 'edit_book was called without patches';
                    } else {
                        const patchResult = chatEngine.applyPatchesValidated(workingBook, list);
                        if (patchResult.errors.length > 0 || !patchResult.result) {
                            err = patchResult.errors.join('; ') || 'the patches were rejected';
                            validationErrors = patchResult.validation_errors || [];
                        } else {
                            workingBook = patchResult.result;
                            appliedPatches.push(...list);
                            toolResults.push({ tool: 'edit_book', applied: list.length, book_id: bookId });
                        }
                    }
                } catch (parseErr) {
                    err = `invalid edit_book arguments: ${parseErr.message}`;
                }
            }
            if (err) {
                editErrors.push(err);
                toolResults.push({ tool: 'edit_book', error: err, validation_errors: validationErrors });
            }
        }

        // ONE save through the AssistantPorts seam (full bundle save when the
        // chapters are intact, targeted file save on a corrupted load).
        let patches = [];
        if (appliedPatches.length > 0) {
            try {
                persistBook(bookId, workingBook);
                patches = appliedPatches;
                log(`${logTag} Book updated (via persistBook):`, patches.length, 'patches applied to', bookId);
            } catch (saveErr) {
                console.error(`${logTag} Failed to save updated book:`, saveErr.message);
                const err = `the book could not be saved: ${saveErr.message}`;
                editErrors.push(err);
                toolResults.push({ tool: 'edit_book', error: err, rejected: true });
            }
        }

        let editOutcome = 'none';
        if (patches.length > 0) editOutcome = 'applied';
        else if (editCalled) editOutcome = 'rejected';
        else if (canEdit && chatEngine.looksLikeChangeClaim(replyText)) editOutcome = 'claimed_not_applied';

        if (editOutcome === 'applied') {
            if (!replyText) replyText = `✅ Changes applied: ${patches.length} change(s) to the book.`;
            if (editErrors.length > 0) replyText += `\n\n⚠️ Some changes were NOT applied: ${editErrors.join('; ')}`;
        } else if (editOutcome === 'rejected') {
            replyText = `⚠️ The book was NOT changed: ${editErrors.join('; ')}`;
        } else if (editOutcome === 'claimed_not_applied') {
            replyText = '⚠️ The book was NOT changed: the assistant described the edit but did not apply it. Please repeat the request.';
        } else if (!replyText && toolCalls.length > 0) {
            replyText = `🤖 Processed ${toolCalls.length} tool call(s).`;
        } else if (!replyText) {
            // No content AND no tool calls. finish_reason=length: a reasoning
            // model spent the whole budget before answering.
            replyText = finishReason === 'length'
                ? '⚠️ The assistant ran out of its answer budget before replying — nothing was changed. Please try again or shorten the request.'
                : '⚠️ The assistant returned no result. Please try again.';
        }

        const validationErrors = toolResults.flatMap(tr => tr.validation_errors || []);
        return { replyText, toolCalls, toolResults, patches, validationErrors, editOutcome, editErrors };
    }

    // One cloud /chat/completions call (SSRF-guarded fetch, the provider's
    // body extras, the one-shot "Unsupported parameter" retry). Returns
    // { ok:true, aiResponse } or { ok:false, status, errText }; aborts
    // (timeout / outer signal) throw AbortError as before.
    async function cloudChatCompletion(ai, messages, tools, { timeoutMs, signal } = {}) {
        const controller = new AbortController();
        const onOuterAbort = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', onOuterAbort, { once: true });
        }
        const timeout = setTimeout(() => controller.abort(), timeoutMs || AI_FETCH_TIMEOUT_MS);
        try {
            const { response, errText } = await fetchChatCompletion(safeFetch, `${ai.baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ai.apiKey}` },
                signal: controller.signal,
                validatePublic: ai.validatePublic,
            }, {
                model: ai.model,
                messages,
                tools: tools.length > 0 ? tools : undefined,
                tool_choice: tools.length > 0 ? 'auto' : undefined,
                ...chatEngine.chatRequestExtras({ model: ai.model, baseUrl: ai.baseUrl, tools }, ai),
            });
            if (!response.ok) return { ok: false, status: response.status, errText };
            return { ok: true, aiResponse: await response.json() };
        } finally {
            clearTimeout(timeout);
            if (signal) signal.removeEventListener('abort', onOuterAbort);
        }
    }

    // Minimum time left in the request window for the corrective retry.
    const EDIT_RETRY_MIN_MS = 5_000;

    // A cloud chat turn: the call, the post-processing and — when edit_book
    // was offered, NOT called, and the reply claims a change — ONE corrective
    // call ("you did not call edit_book…") inside the same time window. If
    // the retry still applies nothing, the honest "NOT changed" reply of the
    // first pass stays.
    async function runCloudTurn(ai, apiMessages, tools, bookData, bookId, { canEdit, logTag, timeoutMs, signal }) {
        const deadline = Date.now() + timeoutMs;
        const first = await cloudChatCompletion(ai, apiMessages, tools, { timeoutMs, signal });
        if (!first.ok) return { error: first };
        const msg1 = first.aiResponse.choices?.[0]?.message;
        const processed = processChatReply(msg1?.content || '', msg1?.tool_calls || [], bookData, bookId, {
            canEdit, logTag, finishReason: first.aiResponse.choices?.[0]?.finish_reason || null,
        });
        if (processed.editOutcome !== 'claimed_not_applied') {
            return { processed, aiResponse: first.aiResponse, retried: false };
        }
        const left = deadline - Date.now();
        if (left < EDIT_RETRY_MIN_MS) {
            log(`${logTag} edit retry skipped for ${bookId}: ${left} ms left in the request window`);
            return { processed, aiResponse: first.aiResponse, retried: false };
        }
        const retryMessages = [
            ...apiMessages,
            { role: 'assistant', content: msg1?.content || '' },
            { role: 'user', content: chatEngine.EDIT_RETRY_PROMPT },
        ];
        const second = await cloudChatCompletion(ai, retryMessages, tools, { timeoutMs: left, signal });
        if (!second.ok) {
            console.error(`${logTag} edit retry failed upstream: ${second.status}`);
            return { processed, aiResponse: first.aiResponse, retried: true };
        }
        const msg2 = second.aiResponse.choices?.[0]?.message;
        const again = processChatReply(msg2?.content || '', msg2?.tool_calls || [], bookData, bookId, {
            canEdit, logTag, finishReason: second.aiResponse.choices?.[0]?.finish_reason || null,
        });
        if (again.editOutcome === 'applied' || again.editOutcome === 'rejected') {
            return { processed: again, aiResponse: second.aiResponse, retried: true };
        }
        return { processed, aiResponse: first.aiResponse, retried: true };
    }

    // One diagnostic line per chat turn — no prompt or reply text, only the
    // shape of the answer (the 19.11 investigation had nothing to go on).
    function logTurn(logTag, { sessionId, mode, ai, processed, retried, finishReason }) {
        try {
            log(`${logTag} turn session=${sessionId} mode=${mode} source=${chatAiSourceToken(ai)} model=${ai.model || '-'}`
                + ` finish=${finishReason || '-'} reply_chars=${(processed.replyText || '').length}`
                + ` tool_calls=${processed.toolCalls.length} edit=${processed.editOutcome}`
                + ` patches=${processed.patches.length}${retried ? ' retry=1' : ''}`);
            if (processed.editErrors && processed.editErrors.length > 0) {
                log(`${logTag} edit_book not applied (session=${sessionId}): ${processed.editErrors.join('; ').slice(0, 500)}`);
            }
        } catch (_) { /* diagnostics never break a turn */ }
    }

    log('[ROUTES] AI routes loaded');
};
