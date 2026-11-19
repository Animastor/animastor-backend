// ======================================================
// Character Analyzer — C20 functional module boundary
// ======================================================
// AI analysis of characters / entities: extraction of stable characters
// (with visual appearance) + role/title alias → character_id mentions.
//
// Frozen contract (C18 §6 F2):
//   extractCharacters(input, ports) → { characters, mentions }
//
// Uses the generic Agent Core execute() lifecycle:
//   validate ports → progress → step → buildMessages → callAI → complete → normalize
//
// Fail: → throw (after failStep). The RUNNER owns the degradation rule.

const { execute } = require('@animastor/ai-agent');
const { generateVoices, needsManner } = require('./voices');

// ── Known heroes of the book (VBOOK_FORMAT_V4 §12б) ──────────────────────
// The registry the model sees so that it returns a known hero under its id
// instead of inventing a new one. Only id / name / aliases — never looks or
// visual descriptions. Large books: heroes named in the window text first, then the
// rest in registry order, until the character budget is spent; the omitted
// count is stated so the model knows the list is partial.
const KNOWN_HEROES_MAX_CHARS = 6000;
const KNOWN_HEROES_MAX_ALIASES = 8;

function heroLine(hero) {
    const aliases = (Array.isArray(hero.aliases) ? hero.aliases : [])
        .filter((a) => typeof a === 'string' && a.trim())
        .slice(0, KNOWN_HEROES_MAX_ALIASES);
    const entry = { id: hero.id };
    if (typeof hero.name === 'string' && hero.name.trim()) entry.name = hero.name.trim();
    if (aliases.length > 0) entry.aliases = aliases;
    return JSON.stringify(entry);
}

/**
 * @param {object[]} registry   heroes of the book ({ id, name?, aliases? })
 * @param {string} windowText
 * @param {number} [maxChars]
 * @returns {{ text: string, included: string[], omitted: number }}  text '' when nothing to show
 */
function formatKnownHeroes(registry, windowText, maxChars = KNOWN_HEROES_MAX_CHARS) {
    const heroes = (Array.isArray(registry) ? registry : []).filter((h) => h && typeof h.id === 'string'
        && h.id && h.id !== 'narrator');
    if (heroes.length === 0) return { text: '', included: [], omitted: 0 };
    // whole words only («Герой 4» is not named by «Герой 499»): the text and
    // every name become ' word word ' sequences, compared once each
    const words = (v) => ` ${String(v || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ')} `;
    const haystack = words(windowText);
    const named = new Set(heroes.filter((h) => [h.name, ...(Array.isArray(h.aliases) ? h.aliases : [])]
        .some((v) => typeof v === 'string' && v.trim().length >= 3 && words(v).length > 2 && haystack.includes(words(v)))));
    const ordered = [...heroes.filter((h) => named.has(h)), ...heroes.filter((h) => !named.has(h))];
    const lines = [];
    let used = 0;
    for (const hero of ordered) {
        const line = heroLine(hero);
        if (used + line.length + 1 > maxChars) break;
        lines.push(line);
        used += line.length + 1;
    }
    const omitted = ordered.length - lines.length;
    const tail = omitted > 0 ? `\n(${omitted} more known characters are not shown)` : '';
    return {
        text: `Known characters of this book (one JSON object per line):\n${lines.join('\n')}${tail}`,
        included: lines.map((l) => JSON.parse(l).id),
        omitted,
    };
}

const charactersTask = {
    requiredPorts: [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'extractingCharactersMessage', 'prompt', 'fillLang',
    ],
    taskName: 'character-analyzer',
    stage: 'extracting_chars',
    progressMessage: (ports) => ports.extractingCharactersMessage,
    stepType: 'analyze_characters',

    buildMessages(input, ports) {
        return {
            messages: [
                { role: 'system', content: ports.fillLang(ports.prompt('characters'), input.language) },
                { role: 'user', content: userMessage(input) },
            ],
            options: { maxTokens: 4096 },
        };
    },

    normalize(result) {
        const characters = result.characters || [];
        const mentions = result.mentions || {};
        console.log(`[AGENT] Step 1 (characters): ${characters.length} extracted, ${Object.keys(mentions).length} mentions`);
        return { characters, mentions };
    },
};

function userMessage(input) {
    const known = formatKnownHeroes(input.knownHeroes, input.windowText);
    const head = known.text ? `${known.text}\n\n` : '';
    return `${head}Extract all characters from this text:\n\n\`\`\`\n${input.windowText}\n\`\`\``;
}

async function extractCharacters(input, ports) {
    return execute(charactersTask, input, ports);
}

module.exports = {
    extractCharacters,
    generateVoices,
    needsManner,
    charactersTask,
    formatKnownHeroes,
    KNOWN_HEROES_MAX_CHARS,
};
