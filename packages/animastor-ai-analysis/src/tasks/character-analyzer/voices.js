// ======================================================
// Character Analyzer — F7 Voice Authoring (semi-final seam)
// ======================================================
// Character-attribute authoring step: analyzes dialogue from the window text
// and writes the voice into characters[i].voice IN PLACE (the F7 write-back
// contract, C18 §4/§6). This is the audio-adjacent half of the Character
// Analyzer: it consumes the MERGED character set and never creates characters.
//
// VBook 4 (VBOOK_FORMAT_V4 §5.1): a voice is TWO fields —
//   timbre — WHO sounds: sex, age, timbre, accent, pronunciation; constant;
//            a neutral reference sample is designed from it;
//   manner — how the character usually speaks: pace, intonation, habits.
// characters[i].voice = { timbre, manner, timbre_source }. There is no
// `instruction`. Plot-bound directions ("on the word …", "when …") belong to
// neither field; the model is told so, and voiceFromAnalysis
// (@animastor/vbook-runtime/voice) drops such sentences by rule as a safety
// net — or refuses the voice when no timbre is left.
//
// Skip rules:
//   - only characters with a real described appearance (hasRealAppearance —
//     the shared @animastor/vbook-runtime/character-identity predicate);
//   - a voice is asked for characters without one; an existing voice is NEVER
//     overwritten (the hero file keeps a person's edits and a locked reference
//     — the write barrier in lazy-book/create.js enforces the same);
//   - a character WITH a timbre and an EMPTY manner is asked for the manner
//     only, unless the voice is protected (timbre_source 'user' or a locked
//     reference — workingCharacterFromHero marks it `protected`). Its timbre is
//     never changed; the write barrier fills only the empty manner
//     (mergeWindowIntoHero). Owner's decision 17.11, VBOOK_FORMAT_V4 §12в.
//
// Fail contract (unchanged): any AI failure → failStep + warn, returns
// { voices: {} }; existing character voices are kept.
//
// Ports: see ./index.js header (buildSkill = audio skill injection from the
// host's prompt-profile loader). No PG/Redis/fs access inside.

const { hasRealAppearance } = require('@animastor/vbook-runtime/character-identity');
const { voiceFromAnalysis, cleanVoiceDescription, isVoiceProtected } = require('@animastor/vbook-runtime/voice');

/** Does this working character already have a voice (timbre)? */
function hasVoice(character) {
    const v = character && character.voice;
    if (v && typeof v === 'object') return typeof v.timbre === 'string' && v.timbre.trim().length > 0;
    return typeof v === 'string' && v.trim().length >= 20 && !/character voice|natural intonation|matching/i.test(v);
}

/** A timbre without a manner, and the analysis may still add to this voice. */
function needsManner(character) {
    const v = character && character.voice;
    if (!v || typeof v !== 'object' || !hasVoice(character)) return false;
    if (typeof v.manner === 'string' && v.manner.trim()) return false;
    return v.protected !== true && !isVoiceProtected(v);
}

/** The manner the model returned for a manner-only character ('' when none). */
function mannerFrom(entry) {
    const raw = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.manner : null;
    if (typeof raw !== 'string' || !raw.trim()) return '';
    return cleanVoiceDescription(raw).timbre.slice(0, 2000).trim();
}

function describeVoice(character) {
    const v = character && character.voice;
    if (v && typeof v === 'object') {
        const parts = [v.timbre && `timbre: ${v.timbre}`, v.manner && `manner: ${v.manner}`].filter(Boolean);
        return parts.length > 0 ? parts.join(' | ') : '(none)';
    }
    return typeof v === 'string' && v ? v : '(none)';
}

async function generateVoices(input, ports) {
    const _ports = ports || {};
    const REQUIRED_PORTS = [
        'callAI', 'logConversation', 'updateSession', 'createStep',
        'completeStep', 'failStep', 'voiceGenerationMessage', 'prompt', 'fillLang', 'buildSkill',
    ];
    const missing = REQUIRED_PORTS.filter((p) => !_ports[p]);
    if (missing.length) {
        throw new Error(`character-analyzer: missing host port(s): ${missing.join(', ')} — persistence and the LLM seam are host-injected (C20 §5)`);
    }
    const {
        callAI, logConversation, updateSession, createStep,
        completeStep, failStep, voiceGenerationMessage, prompt, fillLang, buildSkill,
    } = _ports;

    const _progress = input.progress || (() => {});
    _progress({ stage: 'voice_generation', message: voiceGenerationMessage });
    await updateSession(input.sessionId, { progress_msg: voiceGenerationMessage });

    const characters = input.characters;
    const promptProfiles = input.promptProfiles;

    // Only REAL characters get voice profiles. A character must have an actual
    // appearance description (the entry criterion in characters.md). A
    // dialogue-only participant without a described appearance is NOT a
    // character — no voice is invented for them; the audio pipeline assigns a
    // default voice automatically. Shared predicate (character-identity) —
    // looks at the WHOLE aggregate (passport/appearance/clothes/description),
    // not at the name alone.
    const viableChars = (characters || []).filter(c => c.id && c.name && hasRealAppearance(c));
    if (viableChars.length === 0) {
        console.log('[AGENT] Step voice_generation: skipped — no characters with described appearance to generate voices for');
        return { voices: {} };
    }

    // Only characters WITHOUT a voice need one. A voice that exists — from an
    // earlier window, from the hero file, edited by a person — is never asked
    // for again and never replaced: no voice drift across windows.
    const charsWithoutVoice = viableChars.filter((c) => !hasVoice(c));
    const charsWithoutManner = viableChars.filter(needsManner);
    if (charsWithoutVoice.length === 0 && charsWithoutManner.length === 0) {
        console.log('[AGENT] Step voice_generation: skipped — every character already has a voice');
        return { voices: {} };
    }

    const step = await createStep(input.sessionId, 'generate_voices', input.stepIndex || 0);

    const charsContext = viableChars.map(c =>
        `- ${c.id}: ${c.name}\n` +
        `  role: ${c.role || 'unknown'}\n` +
        `  description: ${(c.description || '').substring(0, 300)}\n` +
        `  appearance: ${(c.appearance || c.passport?.appearance || '').substring(0, 400)}\n` +
        `  traits: ${(c.traits || []).slice(0, 5).join(', ') || 'none'}\n` +
        `  current_voice: ${describeVoice(c)}`
    ).join('\n');

    // Use full text (up to 8000 chars) for dialogue analysis
    const truncatedText = (input.windowText || '').length > 8000
        ? (input.windowText || '').substring(0, 8000) + '...'
        : (input.windowText || '');

    // Inject the audio/TTS skill when a profile is configured (there is no
    // 'default' skill): the voice-instruction authoring rules for the active
    // TTS model live in skills/audio/{qwen-tts,...}.md.
    let voicePrompt = prompt('voice_generation');
    const audioSkill = buildSkill('audio', promptProfiles?.audioProfile || null);
    if (audioSkill) {
        voicePrompt = `${audioSkill}\n\n${voicePrompt}`;
    }

    const systemPrompt = fillLang(
        voicePrompt
            .replace('%CHARACTERS%', charsContext)
            .replace('%TEXT%', truncatedText),
        input.language
    );

    const mannerOnly = charsWithoutManner.length > 0
        ? `\n\nThese characters already have a timbre — do NOT change it. For them return ONLY "manner" ({"manner": "…"}), an empty string when the text gives no ground: ${charsWithoutManner.map((c) => c.id).join(', ')}.`
        : '';
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Analyze the source text and generate voice descriptions for characters who have DIALOGUE LINES (speech). Skip characters who only appear in narration and never speak. Do NOT generate narrator voice.${mannerOnly}\n\nCharacters:\n${charsContext}\n\nSource text for analysis:\n${truncatedText}` },
    ];

    try {
        const result = await callAI(messages, { maxTokens: 4096 });
        const raw = result && result.voices && typeof result.voices === 'object' && !Array.isArray(result.voices) ? result.voices : {};

        // Write-back ONLY for characters who needed a voice, and only what
        // passes the contract: { timbre, manner } with a non-empty timbre and
        // no plot-bound sentence in either field. A voice for an id that is not
        // in the list (a speaker the model invented) is dropped.
        const voices = {};
        const rejected = {};
        for (const ch of charsWithoutVoice) {
            if (!Object.prototype.hasOwnProperty.call(raw, ch.id)) continue;
            // the book language drives the pronunciation suffix of timbre (rules v3)
            const parsed = voiceFromAnalysis(raw[ch.id], { language: input.language });
            if (!parsed.voice) { rejected[ch.id] = parsed.reason; continue; }
            ch.voice = parsed.voice;
            voices[ch.id] = parsed.voice;
        }
        // Manner-only: the timbre stays as it is, only the empty manner is filled.
        let mannersFilled = 0;
        for (const ch of charsWithoutManner) {
            if (!Object.prototype.hasOwnProperty.call(raw, ch.id)) continue;
            const manner = mannerFrom(raw[ch.id]);
            if (!manner) continue;
            ch.voice = { ...ch.voice, manner };
            voices[ch.id] = ch.voice;
            mannersFilled++;
        }
        if (Object.keys(rejected).length > 0) {
            console.warn(`[AGENT] Step voice_generation: voices not accepted — ${Object.entries(rejected).map(([id, why]) => `${id}: ${why}`).join(', ')}`);
        }

        await logConversation(input.sessionId, step.step_id, messages, JSON.stringify(result));
        await completeStep(step.step_id, { voices: Object.keys(voices).length - mannersFilled, manners: mannersFilled, rejected: Object.keys(rejected).length });
        console.log(`[AGENT] Step voice_generation: ${Object.keys(voices).length - mannersFilled}/${viableChars.length} characters got voice descriptions, ${mannersFilled}/${charsWithoutManner.length} got a missing manner`);
        // { voices } — the frozen F7 result; `rejected` appears only when the
        // model returned something that could not become a voice.
        return Object.keys(rejected).length > 0 ? { voices, rejected } : { voices };
    } catch (err) {
        await failStep(step.step_id, err.message);
        console.warn(`[AGENT] Step voice_generation FAILED: ${err.message} — keeping existing character voices`);
        return { voices: {} };
    }
}

module.exports = { generateVoices, hasVoice, needsManner };
