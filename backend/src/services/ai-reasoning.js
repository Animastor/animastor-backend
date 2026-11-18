// ======================================================
// AI reasoning settings of a provider (VBOOK_FORMAT_V4 §12б, step 2b)
// ======================================================
// Reasoning ("thinking") models spend max_tokens on reasoning before they
// write the answer; with the analysis budgets (2–8k) a model can exhaust the
// whole budget and return an empty content (finish_reason=length). A provider
// (system or workspace) therefore carries two optional settings:
//
//   disable_thinking  boolean, default false — send
//                     chat_template_kwargs: { enable_thinking: false }
//                     (vLLM / NIM / SGLang chat templates: Nemotron, Qwen3,
//                     DeepSeek-R1 distills …). A provider that does not know
//                     the field may reject it — the setting is opt-in.
//   reasoning_effort  null (not sent, default) or one of REASONING_EFFORTS —
//                     sent as the OpenAI-style top-level `reasoning_effort`.
//
// Both are stored in the provider row (system_ai_providers /
// workspace_ai_providers) like the other provider fields, exposed in the
// provider meta, accepted by the admin / settings PUT routes. UI: later (GAP).
// Every /chat/completions body of a provider applies them through THIS module
// (VBOOK_FORMAT_V4 §12, step 4): the analysis transport (ai-service.callAI —
// reasoningBodyFields), the chat assistant (@animastor/assistant — withReasoning,
// injected at the composition root) and the provider connection test
// (workspace-ai-provider.testConnection — withReasoning).

'use strict';

const REASONING_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high']);

/**
 * Validate the API fields. undefined = "not given" (keep the stored value).
 * @param {{disable_thinking?: any, reasoning_effort?: any}} body
 * @returns {{ ok: true, value: { disableThinking?: boolean, reasoningEffort?: string|null } } | { ok: false, error: string }}
 */
function parseReasoningInput(body = {}) {
    const value = {};
    if (body.disable_thinking !== undefined) {
        if (typeof body.disable_thinking !== 'boolean') return { ok: false, error: 'disable_thinking must be a boolean' };
        value.disableThinking = body.disable_thinking;
    }
    if (body.reasoning_effort !== undefined) {
        const effort = body.reasoning_effort;
        if (effort === null || effort === '') value.reasoningEffort = null;
        else if (typeof effort === 'string' && REASONING_EFFORTS.includes(effort.trim().toLowerCase())) {
            value.reasoningEffort = effort.trim().toLowerCase();
        } else {
            return { ok: false, error: `reasoning_effort must be null or one of: ${REASONING_EFFORTS.join(', ')}` };
        }
    }
    return { ok: true, value };
}

/** Provider row → snapshot fields. */
function reasoningFromRow(row) {
    const effort = row && typeof row.reasoning_effort === 'string' ? row.reasoning_effort : null;
    return {
        disableThinking: !!(row && row.disable_thinking === true),
        reasoningEffort: effort && REASONING_EFFORTS.includes(effort) ? effort : null,
    };
}

/** Provider row → meta fields (API shape). */
function reasoningMeta(row) {
    const r = reasoningFromRow(row);
    return { disable_thinking: r.disableThinking, reasoning_effort: r.reasoningEffort };
}

/**
 * Next stored values: what the input gives, else what the row has.
 * @returns {{ disable_thinking: boolean, reasoning_effort: string|null }}
 */
function nextReasoningColumns(input = {}, existingRow = null) {
    const current = reasoningFromRow(existingRow);
    return {
        disable_thinking: input.disableThinking !== undefined ? input.disableThinking === true : current.disableThinking,
        reasoning_effort: input.reasoningEffort !== undefined ? (input.reasoningEffort || null) : current.reasoningEffort,
    };
}

/** Body fields of a /chat/completions request for this provider snapshot. */
function reasoningBodyFields(provider) {
    const out = {};
    if (provider && provider.disableThinking === true) out.chat_template_kwargs = { enable_thinking: false };
    if (provider && typeof provider.reasoningEffort === 'string' && REASONING_EFFORTS.includes(provider.reasoningEffort)) {
        out.reasoning_effort = provider.reasoningEffort;
    }
    return out;
}

/**
 * Chat body extras (token budget, the Qwen `enable_thinking` switch …) with the
 * provider's reasoning settings on top. A provider that disables thinking wins
 * over the model-specific switch: `enable_thinking` is dropped, so the body
 * never says "think" and "do not think" at once.
 * @param {object} extras    fields built for the model (may be empty)
 * @param {object} provider  provider snapshot ({disableThinking, reasoningEffort})
 * @returns {object} a new object
 */
function withReasoning(extras, provider) {
    const out = { ...(extras || {}) };
    const fields = reasoningBodyFields(provider);
    if (fields.chat_template_kwargs && fields.chat_template_kwargs.enable_thinking === false) delete out.enable_thinking;
    return { ...out, ...fields };
}

/**
 * Reasoning settings of a provider under test: the body of the test request
 * wins (validated like the PUT routes), else the stored provider.
 * @returns {{ ok: true, value: {disableThinking: boolean, reasoningEffort: string|null} } | { ok: false, error: string }}
 */
function reasoningForTest(body = {}, stored = null) {
    const parsed = parseReasoningInput(body || {});
    if (!parsed.ok) return parsed;
    const base = stored ? { disableThinking: stored.disableThinking === true, reasoningEffort: stored.reasoningEffort || null } : { disableThinking: false, reasoningEffort: null };
    return {
        ok: true,
        value: {
            disableThinking: parsed.value.disableThinking !== undefined ? parsed.value.disableThinking : base.disableThinking,
            reasoningEffort: parsed.value.reasoningEffort !== undefined ? parsed.value.reasoningEffort : base.reasoningEffort,
        },
    };
}

/**
 * Who can change the settings of the provider that answered (owner, step 6):
 *   'system'   — the system provider (admin panel) or the operator env
 *                fallback ('global'): the user asks the administrator;
 *   'personal' — the provider of the user's own workspace (settings/ai,
 *                a shared endpoint or a Local AI connector in it).
 * @returns {'system'|'personal'|null}
 */
function reasoningProviderSource(provider) {
    const source = provider && provider.source;
    if (source === 'system' || source === 'global') return 'system';
    if (source === 'workspace') return 'personal';
    return null;
}

/**
 * The model spent the whole budget on reasoning and wrote nothing. Repeating
 * the same request gives the same result — the error is not retried.
 * The text names the provider in a fixed form («Provider: system.» /
 * «Provider: personal.») — the progress text is the one channel every front
 * reads; err.providerSource carries the same value for structured channels.
 */
function reasoningExhaustedError({ maxTokens, reasoningTokens, provider = null }) {
    const providerSource = reasoningProviderSource(provider);
    const advice = providerSource === 'system'
        ? 'Provider: system. Ask the administrator to disable thinking (disable_thinking) or lower reasoning_effort of the system AI provider.'
        : providerSource === 'personal'
            ? 'Provider: personal. Disable thinking in your AI provider settings (disable_thinking) or lower reasoning_effort.'
            : 'Disable thinking in the AI provider settings (disable_thinking) or lower reasoning_effort.';
    const err = new Error(
        `The model exhausted its token limit on reasoning (finish_reason=length, empty content, `
        + `max_tokens=${maxTokens}${reasoningTokens != null ? `, reasoning_tokens=${reasoningTokens}` : ''}). `
        + advice,
    );
    err.code = 'reasoning_budget_exhausted';
    err.providerSource = providerSource;
    err.nonRetryable = true;
    return err;
}

module.exports = {
    REASONING_EFFORTS,
    parseReasoningInput,
    reasoningFromRow,
    reasoningMeta,
    nextReasoningColumns,
    reasoningBodyFields,
    withReasoning,
    reasoningForTest,
    reasoningProviderSource,
    reasoningExhaustedError,
};
