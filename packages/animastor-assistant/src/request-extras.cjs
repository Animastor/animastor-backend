// ======================================================
// @animastor/assistant — CHAT REQUEST EXTRAS (provider compatibility)
// ======================================================
// The non-message part of a /chat/completions body (token budget +
// thinking switch) and the one-shot compatibility retry around it.
//
// `enable_thinking` is a Qwen-specific (DashScope / vLLM-qwen) extension,
// NOT part of the OpenAI chat/completions schema. Strict OpenAI-compatible
// gateways reject it — NVIDIA (integrate.api.nvidia.com) answers
// 400 "Unsupported parameter(s): enable_thinking". It is therefore sent
// ONLY where it is known to work (supportsEnableThinking), and a 400
// "Unsupported parameter" on a body that carried it is retried once
// without the non-standard fields (fetchChatCompletion).
//
// The host's provider connection test builds its body through the SAME
// buildChatRequestExtras, so a test that passes means the chat body passes.

// Tool-carrying requests use a HIGH max_tokens: reasoning models
// (deepseek-v4-flash, qwen3) count reasoning tokens against max_tokens,
// so a 4096 cap can be fully consumed by reasoning before any
// content/tool_call is produced (observed: finish_reason=length,
// reasoning_tokens=4096, empty content → "Tool executed" ghost reply).
// Tool-less conversation gets a small budget and no thinking — faster,
// cheaper replies.
const MAX_TOKENS_WITH_TOOLS = 16384;
const MAX_TOKENS_PLAIN = 4096;

// Body fields outside the OpenAI chat/completions schema. Dropped on the
// compatibility retry.
const NON_STANDARD_FIELDS = ['enable_thinking'];

// Gateways that host qwen models but reject `enable_thinking`.
const NO_ENABLE_THINKING_HOSTS = [/(^|\.)nvidia\.com$/i];

function hostOf(baseUrl) {
    try { return new URL(String(baseUrl)).hostname; } catch (_) { return ''; }
}

/**
 * Does this provider/model accept the `enable_thinking` body field?
 * Currently: qwen* models (incl. vendor-prefixed "qwen/qwen3-32b"), except
 * on endpoints known to reject the field.
 * @param {{model?:string, baseUrl?:string}} target
 */
function supportsEnableThinking({ model, baseUrl } = {}) {
    const m = String(model || '').toLowerCase();
    const name = m.slice(m.lastIndexOf('/') + 1);
    if (!name.startsWith('qwen')) return false;
    const host = hostOf(baseUrl);
    return !NO_ENABLE_THINKING_HOSTS.some((re) => re.test(host));
}

/**
 * Token budget + (where supported) thinking switch for a chat body.
 * @param {{model?:string, baseUrl?:string, tools?:Array}} input
 */
function buildChatRequestExtras({ model, baseUrl, tools } = {}) {
    const hasTools = Array.isArray(tools) && tools.length > 0;
    const extras = { max_tokens: hasTools ? MAX_TOKENS_WITH_TOOLS : MAX_TOKENS_PLAIN };
    if (supportsEnableThinking({ model, baseUrl })) {
        extras.enable_thinking = hasTools; // reasoning only for tool/edit work
    }
    return extras;
}

function isUnsupportedParamError(status, text) {
    return status === 400 && /unsupported parameter/i.test(String(text || ''));
}

/**
 * Short, key-free description of an upstream error body: the provider's
 * own message (OpenAI `{error:{message}}`, `{message}`, `{detail}`) or a
 * plain-text excerpt. Bearer tokens / key-looking strings are masked.
 */
function describeUpstreamError(status, text) {
    let msg = '';
    const raw = String(text || '');
    try {
        const j = JSON.parse(raw);
        const e = j && j.error;
        msg = (e && typeof e === 'object' ? e.message : e) || j.message || j.detail || '';
        if (typeof msg !== 'string') msg = JSON.stringify(msg);
    } catch (_) {
        msg = raw;
    }
    msg = msg
        .replace(/Bearer\s+\S+/gi, 'Bearer ***')
        .replace(/\b(sk|nvapi|key)[-_][A-Za-z0-9_-]{8,}/gi, '***')
        .replace(/\s+/g, ' ')
        .trim();
    if (msg.length > 200) msg = `${msg.slice(0, 200)}…`;
    return msg ? `AI API error ${status}: ${msg}` : `AI API error: ${status}`;
}

/**
 * POST a chat/completions body; on 400 "Unsupported parameter" for a body
 * that carried non-standard fields, retry ONCE without them.
 * @returns {Promise<{response, errText?:string}>} errText is set (body
 *   already consumed) when the final response is not ok.
 */
async function fetchChatCompletion(safeFetch, url, init, body) {
    let response = await safeFetch(url, { ...init, body: JSON.stringify(body) });
    if (response.ok) return { response };
    let errText = await response.text().catch(() => '');
    const carried = NON_STANDARD_FIELDS.filter((f) => f in body);
    if (carried.length > 0 && isUnsupportedParamError(response.status, errText)) {
        console.warn(`[AI] upstream rejected ${carried.join(',')} (400) — retrying without non-standard fields`);
        const stripped = { ...body };
        for (const f of carried) delete stripped[f];
        response = await safeFetch(url, { ...init, body: JSON.stringify(stripped) });
        if (response.ok) return { response };
        errText = await response.text().catch(() => '');
    }
    return { response, errText };
}

module.exports = {
    MAX_TOKENS_WITH_TOOLS,
    MAX_TOKENS_PLAIN,
    NON_STANDARD_FIELDS,
    supportsEnableThinking,
    buildChatRequestExtras,
    isUnsupportedParamError,
    describeUpstreamError,
    fetchChatCompletion,
};
