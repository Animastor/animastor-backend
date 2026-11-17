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
// Only the analysis transport (ai-service.callAI) applies them; the chat
// assistant (@animastor/assistant) builds its own body.

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
 * The model spent the whole budget on reasoning and wrote nothing. Repeating
 * the same request gives the same result — the error is not retried.
 */
function reasoningExhaustedError({ maxTokens, reasoningTokens }) {
    const err = new Error(
        `The model exhausted its token limit on reasoning (finish_reason=length, empty content, `
        + `max_tokens=${maxTokens}${reasoningTokens != null ? `, reasoning_tokens=${reasoningTokens}` : ''}). `
        + 'Disable thinking in the AI provider settings (disable_thinking) or lower reasoning_effort.',
    );
    err.code = 'reasoning_budget_exhausted';
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
    reasoningExhaustedError,
};
