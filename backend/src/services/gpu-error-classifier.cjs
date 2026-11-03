// ======================================================
// GPU worker error classifier — pure function, rule table
// ======================================================
// Owner decision 2026-11-02 (reports/2026-11-02/gpu-retry-policy.md,
// animastor-docs architecture/COMMAND_ONLY_GENERATION.md §«Повтор после
// ошибки воркера»). Turns a worker/hub failure signal into ONE class:
//
//   deterministic — ComfyUI rejected the prompt (HTTP 400, node_errors,
//                   «No prompt_id», missing node class, invalid workflow,
//                   model not found). Repeating can never succeed.
//   transient     — execution timeout, network / HTTP 5xx between the worker
//                   and the hub / ComfyUI, worker gone (heartbeat expired,
//                   hub «worker_timeout»).
//   oom           — CUDA out of memory.
//   unknown       — anything else (fail-closed: treated as no retry).
//
// Input works for ANY worker version (2.2.0+): the free-text `reason` is
// always there; workers 2.2.3+ add the optional structured fields
// `error_class` (one of the classes above) and `comfy_status` (HTTP status of
// ComfyUI POST /prompt). Structured fields win; text rules are the fallback.
//
// No I/O, no clock, no requires — deterministic for tests.

'use strict';

const ErrorClass = Object.freeze({
    DETERMINISTIC: 'deterministic',
    TRANSIENT: 'transient',
    OOM: 'oom',
    UNKNOWN: 'unknown',
});

const KNOWN_CLASSES = new Set(Object.values(ErrorClass));

// Order matters: the first matching rule wins. OOM before deterministic
// (an OOM text may also mention a node), deterministic before transient
// («No prompt_id: … timeout» from ComfyUI's validator is still a reject).
const TEXT_RULES = [
    // ── CUDA OOM ──────────────────────────────────────
    { cls: ErrorClass.OOM, code: 'cuda_oom', re: /cuda out of memory|outofmemoryerror|cuda error: out of memory|torch\.cuda\.outofmemory|allocation on device|cudaerrormemoryallocation/i },

    // ── ComfyUI rejected the prompt (deterministic) ───
    { cls: ErrorClass.DETERMINISTIC, code: 'comfy_missing_node', re: /node .*does not exist|does not exist.*node|missing node|cannot find node class|unknown node( type| class)?|node class .*not found|not found in nodes|class_type .*(not found|invalid)/i },
    { cls: ErrorClass.DETERMINISTIC, code: 'comfy_model_missing', re: /value not in list|(model|checkpoint|ckpt|lora|vae|unet|clip)[^\n]{0,40}not found|no such file[^\n]{0,80}models?\//i },
    { cls: ErrorClass.DETERMINISTIC, code: 'comfy_invalid_workflow', re: /invalid[ _-]?workflow|prompt_outputs_failed_validation|prompt has no outputs|invalid_prompt|node_errors|prompt_no_outputs|incompatible_task_protocol/i },
    { cls: ErrorClass.DETERMINISTIC, code: 'comfy_rejected', re: /^\s*no prompt_id\b/i },

    // ── transient ─────────────────────────────────────
    { cls: ErrorClass.TRANSIENT, code: 'worker_lost', re: /\bworker[_ ]timeout\b|worker (gone|lost|offline)|heartbeat (expired|lost|stale)/i },
    { cls: ErrorClass.TRANSIENT, code: 'execution_timeout', re: /timeout waiting result|timed? ?out|\btimeout\b|\betimedout\b/i },
    { cls: ErrorClass.TRANSIENT, code: 'network', re: /econnreset|econnrefused|ehostunreach|enetunreach|eai_again|socket hang up|fetch failed|network error|\baborted\b|invalid json from comfyui|\bhttp 5\d\d\b|\bstatus 5\d\d\b|\b50[234] (bad gateway|service unavailable|gateway timeout)/i },
];

const MESSAGE_MAX = 200;

/**
 * Short, single-line, stack-free message for APIs/fronts.
 * @param {*} reason
 * @returns {string}
 */
function shortMessage(reason) {
    if (reason == null) return '';
    let s = typeof reason === 'string' ? reason : (reason.message || String(reason));
    // First line only (drop stack traces / multi-line ComfyUI dumps).
    s = s.split(/\r?\n/)[0];
    // A Node stack frame glued to the line («… at Foo (/x.js:1:2)»).
    s = s.replace(/\s+at\s+\S+\s+\([^)]*\)[\s\S]*$/, '');
    s = s.replace(/\s+/g, ' ').trim();
    if (s.length > MESSAGE_MAX) s = `${s.slice(0, MESSAGE_MAX - 1)}…`;
    return s;
}

function classFromComfyStatus(status) {
    const n = Number(status);
    if (!Number.isInteger(n) || n <= 0) return null;
    if (n === 400) return { cls: ErrorClass.DETERMINISTIC, code: 'comfy_rejected' };
    if (n >= 500 && n <= 599) return { cls: ErrorClass.TRANSIENT, code: 'network' };
    return null;
}

/**
 * Classify one worker/hub failure signal.
 *
 * @param {object|string} input  `{ reason, error_class?, comfy_status? }` or the bare reason text.
 * @returns {{ error_class: string, error_code: string, error_message: string, source: string }}
 *   `source` — which rule decided: 'worker' (structured error_class),
 *   'comfy_status', 'text', 'default'.
 */
function classifyGpuError(input) {
    const o = (input && typeof input === 'object' && !(input instanceof Error))
        ? input
        : { reason: input };
    const reasonText = o.reason instanceof Error ? o.reason.message : (o.reason == null ? '' : String(o.reason));
    const error_message = shortMessage(reasonText) || 'unknown';

    // Text rules give the finer error_code even when the class is structured.
    let textHit = null;
    for (const rule of TEXT_RULES) {
        if (rule.re.test(reasonText)) { textHit = rule; break; }
    }

    // 1. Structured class from the worker (2.2.3+).
    const declared = typeof o.error_class === 'string' ? o.error_class.trim().toLowerCase() : '';
    if (declared && KNOWN_CLASSES.has(declared) && declared !== ErrorClass.UNKNOWN) {
        const code = textHit && textHit.cls === declared
            ? textHit.code
            : (o.error_code && typeof o.error_code === 'string' ? o.error_code : declared);
        return { error_class: declared, error_code: code, error_message, source: 'worker' };
    }

    // 2. ComfyUI HTTP status of POST /prompt.
    const byStatus = classFromComfyStatus(o.comfy_status);
    if (byStatus) {
        const code = textHit && textHit.cls === byStatus.cls ? textHit.code : byStatus.code;
        return { error_class: byStatus.cls, error_code: code, error_message, source: 'comfy_status' };
    }

    // 3. Text rules.
    if (textHit) {
        return { error_class: textHit.cls, error_code: textHit.code, error_message, source: 'text' };
    }

    // 4. Fail-closed.
    return { error_class: ErrorClass.UNKNOWN, error_code: 'unknown', error_message, source: 'default' };
}

module.exports = {
    ErrorClass,
    TEXT_RULES,
    MESSAGE_MAX,
    classifyGpuError,
    shortMessage,
};
