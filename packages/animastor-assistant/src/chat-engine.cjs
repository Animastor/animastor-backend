// ======================================================
// @animastor/assistant — CHAT ENGINE
// ======================================================
// AI chat engine — system prompts, book context building,
// mode-specific tool definitions, AI response parsing,
// and JSON patch application.
//
// Physically extracted from backend/src/services/chat-engine.cjs
// (docs/architecture/ai-assistant-extraction.md). The bundle-contract
// validator arrives ONLY through injection (deps.validateBundleObject) —
// the host ../book/bundle-validator.cjs require is gone with the move;
// the composition root binds the shared validator instance. The AI
// assistant profile (persona) is host-owned CONTENT: the composition root
// READS the host markdown file and injects the resulting string via
// deps.aiProfile — the package never knows the path, the file name or the
// filesystem. The chat fallback base URL (an operator env knob) is passed
// as deps.aiApiBaseUrl.
// The package holds no host imports, no fs and no ambient env reads —
// pure Assistant logic only.

const requestExtras = require('./request-extras.cjs');

module.exports = function(config, deps = {}) {
    const { validateBundleObject } = deps;
    if (typeof validateBundleObject !== 'function') {
        throw new Error('chatEngine: deps.validateBundleObject is required (composition-root bound)');
    }
    // AI assistant profile CONTENT — injected by the composition root (the
    // host owns the persona file and reads it). Absent/empty → built-in
    // fallback profile, the same behavior as the historical missing file.
    const AI_PROFILE = typeof deps.aiProfile === 'string' ? deps.aiProfile.trim() : '';
    // Chat fallback base URL — injected by the composition root (operator
    // env knob). The literal default is the last-resort contract value.
    const AI_API_BASE_URL = deps.aiApiBaseUrl || 'https://integrate.api.nvidia.com/v1';
    // Provider reasoning settings (disable_thinking / reasoning_effort) — the
    // host's ONE helper (ai-reasoning.withReasoning), injected by the
    // composition root so the chat body is built exactly like the analysis
    // body and the provider connection test. Not injected → extras unchanged.
    const withReasoning = typeof deps.withReasoning === 'function' ? deps.withReasoning : (extras) => ({ ...(extras || {}) });

    /** Token budget + thinking switch of the model, with the provider's reasoning settings on top. */
    function chatRequestExtras(input, ai) {
        return withReasoning(requestExtras.buildChatRequestExtras(input), ai || null);
    }

    // ── Mode-specific system prompts ──────────────────
    const MODE_PROMPTS = {
        conversation: 'You are a creative assistant in Conversational mode. Answer questions, discuss ideas, explain concepts, and brainstorm. Do NOT make any changes to the book — this is a read-only discussion.',
        import: 'You are an Import specialist. Convert arbitrary text into Animastor book structure. Analyze the text and automatically determine chapters, scenes, and units. If a book is already open, decide whether the text is a new chapter, continuation of current chapter, or extension of current scene. If no book is open, create a new book with manifest, metadata, chapters, scenes, and units. The user must NOT manually mark chapters/scenes/units — determine the structure from content. Always produce a valid Animastor book JSON.',
        edit: [
            'You are an Editor. You can modify scenes, heroes, locations, behaviour, and book structure.',
            'The ONLY way to change the book is a call of the `edit_book` tool with JSON Patch operations.',
            'When the user asks for a change, call `edit_book` in this same turn. Ask a question instead only when the request is genuinely ambiguous.',
            'Text or JSON written in your reply changes NOTHING: never paste a modified book, chapter, scene or unit as JSON instead of calling the tool.',
            'Never say that a change is done ("Done", "I have added…", "Готово", "Добавил…") unless you called `edit_book` in this turn — the server reports the real result to the user.',
            '',
            '## Chapters, scenes and units',
            '`chapters` is an array addressed by index: `/chapters/<chapter_index>/scenes/<scene_index>/units/<unit_index>/<field>` (indexes start at 0).',
            'A new scene: `add /chapters/<chapter_index>/scenes/-` with the whole scene object, for example',
            '`{"scene_id": "sc-1a2b3c4d", "scene_title": "Title", "type": "narration", "participants": [], "units": [{"id": "iu-5e6f7a8b", "type": "narration", "text": "Unit text."}]}`.',
            'Ids: `sc-` / `iu-` followed by 8 lowercase hex characters, unique in the book (the server assigns them when they are missing).',
            'Unit fields: `text`, `audio` {speaker, text}, `image` {shot, prompt, negative}, `video` {action}.',
            'Use `add` to set a field that may not exist yet (`add /chapters/0/scenes/1/units/0/video/action` creates `video`); `replace` works only on an existing field.',
            'Several changes — several operations in ONE `edit_book` call.',
            '',
            '## Heroes (VBook 4)',
            'Every character of the book — including the narrator — is a hero: one object in `heroes` (one file `characters/<id>.json`).',
            'A hero is addressed by its id, NEVER by an array index: `/heroes/<hero_id>/<field>`.',
            'Hero fields: `name`, `role`, `aliases` (how the author names the hero in the text), `notes` (for people only),',
            '`passport` {appearance, clothes, video_tokens: 1-4 short visible features}, `looks` (named passport overrides),',
            '`voice` {timbre, manner, reference}, `behaviour` {profile: {baseline, quirks, reactions}, rules: [...]}.',
            'Never write `voice.reference` (a pinned audio file — only the hero card pins it), `id`, `schema`, `rev` or `hero_issues`.',
            'A new hero: `add /heroes/<new_id>` with the whole hero object (`schema: "animastor.character/1"`, `id` equal to <new_id>).',
            'The narrator (`/heroes/narrator`) cannot be removed.',
            'The paths `/characters`, `/voices`, `/behaviors`, `/mentions` do not exist any more — they are refused.',
            '',
            '## Scene Participants',
            '`scene.participants` is ALWAYS a JSON array of hero ids (character_id) taken from `heroes` — never display names, never a bare string, never an object like {"item": ...}.',
            'Example: `["yura", "svetlana"]` — NOT `["Юра", "yura"]` and NOT `{"item": ["yura", "svetlana"]}`.',
            'When the user asks to fix participants across the whole book, apply the change to EVERY scene in EVERY chapter — do not stop after one scene. List one patch per affected scene.',
            '',
            '## Hero Behaviour',
            'The character of a hero lives in `/heroes/<hero_id>/behaviour/profile`:',
            '```json',
            '{',
            '  "baseline": "How the hero normally behaves — characteristic manner of movement, expressions, gestures, posture, speech patterns.",',
            '  "quirks": ["Repeated characteristic habit or mannerism."],',
            '  "reactions": [',
            '    { "trigger": "A situation or emotional state.", "reaction": "The observable behavioral response." }',
            '  ]',
            '}',
            '```',
            'Field meanings:',
            '- **baseline**: how the hero behaves NORMALLY — characteristic manner of movement, expressions, gestures, posture, speech rhythm.',
            '- **quirks**: recurring habits or mannerisms specific to this hero (one string per entry).',
            '- **reactions**: trigger→reaction patterns. `trigger` = situation or state; `reaction` = observable behavioral response.',
            'Do not touch `behaviour.rules` unless the user explicitly asks about behaviour rules.',
            '',
            'When the user asks to create or modify the behaviour of a hero:',
            '1. Find the hero by id (or by `name` / `aliases`) in `heroes`.',
            '2. Study the passport (appearance, clothes) and notes to understand the personality.',
            '3. Create behaviour that matches the personality — distinct, specific, believable.',
            '4. Use `edit_book` with `add /heroes/<hero_id>/behaviour/profile` and the full profile object (add creates or replaces).',
            '5. Do NOT create a new hero. Do NOT modify passport or voice unless asked.',
            '',
            'Example user request: "Придумай поведение для Юры и Светланы."',
            'Agent action: find heroes yura and svetlana, analyze passports, write individualized baseline/quirks/reactions via edit_book.',
        ].join('\n'),
        director: 'You are a Film Director. Advise on camera angles, composition, lighting, mood, and atmosphere for scenes. You can write into storyboard_elements for the current scene. Think visually and cinematically.',
        extraction: 'You are an Extraction specialist. Extract structured entities from the text such as characters, objects, locations, and key terms.',
        validation: 'You are a Validation specialist. Check book JSON for correctness, completeness, and integrity. Verify required fields, cross-references, scene links, and data consistency. Return a list of violations with severity levels.',
    };

    // ── Topic-specific system prompts ─────────────────
    const TOPIC_PROMPTS = {
        book: 'You are a creative assistant helping with a visual book project. Answer questions about the book, its plot, characters, and structure.',
        scene: 'You are a scene editor assistant. Help refine the current scene: visuals, audio, pacing, and dialogue. Use the current position context (chapter/scene/unit) when relevant.',
        characters: 'You are a character development assistant. Help design, refine, and track the heroes of the visual book (book.heroes — one object per hero, the narrator included).',
        script: 'You are a scriptwriting assistant. Help with plot structure, narrative flow, scene transitions, and story arc.',
    };

    /**
     * Build a system prompt from structured fields (mode, topic, language, position).
     * Replaces the client-side system prompt assembly in AiAssistantFragment.
     */
    function buildChatSystemPrompt({ mode, topic, lang, bookData, chapterId, sceneId, unitIndex, modelName }) {
        const appName = 'Animastor';
        const modeKey = mode || 'conversation';
        const topicKey = topic || 'book';
        const modePrompt = MODE_PROMPTS[modeKey] || MODE_PROMPTS.conversation;
        const topicPrompt = TOPIC_PROMPTS[topicKey] || TOPIC_PROMPTS.book;

        // Resolve position context from book data
        let positionContext = '';
        if (bookData) {
            try {
                const chapters = bookData.chapters || [];
                // If chapterId is not provided, find the chapter that contains sceneId
                // Modern lazy-book chapters carry `chapter_id`; legacy parse.js
                // chapters carry `chapter`. Normalize so position context resolves
                // for both formats.
                const chIdOf = c => c.chapter_id ?? c.chapter;
                const resolvedChapterId = chapterId || (sceneId
                    ? chIdOf(chapters.find(c => c.scenes?.some(s => s.scene_id === sceneId)))
                    : null);
                if (!resolvedChapterId) { positionContext = ''; }
                else {
                const ch = chapters.find(c => chIdOf(c) === resolvedChapterId);
                const isSpecial = ch?.type === 'cover' || ch?.type === 'prologue';
                const chTitle = ch?.chapter_title || '';
                let chName = chapterId;
                if (isSpecial) {
                    chName = chTitle || ch?.type || chapterId;
                } else if (chTitle) {
                    chName = chTitle;
                } else if (ch?.display_number != null) {
                    chName = `Chapter ${ch.display_number}`;
                }

                let scName = '';
                let unitDesc = '';
                if (sceneId) {
                    const scenes = ch?.scenes || [];
                    const sc = scenes.find(s => s.scene_id === sceneId);
                    const scIdx = scenes.indexOf(sc) + 1;
                    if (scIdx > 0) {
                        const titleSuffix = sc?.scene_title ? ` — ${sc.scene_title}` : '';
                        scName = `Scene ${scIdx}${titleSuffix}`;
                    }
                    if (unitIndex != null && unitIndex >= 0) {
                        const units = sc?.units || [];
                        const unit = units[unitIndex];
                        if (unit) {
                            const typeLabel = unit.type ? unit.type.charAt(0).toUpperCase() + unit.type.slice(1) : 'Unit';
                            const textSnippet = unit.text ? unit.text.slice(0, 60).replace(/[\n\r]/g, ' ') : '';
                            unitDesc = textSnippet ? `${typeLabel} — "${textSnippet}"` : `${typeLabel} ${unitIndex + 1}`;
                        } else {
                            unitDesc = `Unit ${unitIndex + 1}`;
                        }
                    }
                }

                const parts = [`Current position: ${chName}`];
                if (scName) parts.push(scName);
                if (unitDesc) parts.push(unitDesc);
                positionContext = parts.join(' / ');
                }
            } catch (_) {
                // Silent fallback — position context is optional
            }
        }

        // Language instruction
        let langInstruction = '';
        switch (lang) {
            case 'ru':
                langInstruction = '\n\nIMPORTANT: Always reply in Russian. Use Russian for all responses regardless of the user\'s language.';
                break;
            case 'en':
                langInstruction = '';
                break;
            case 'auto':
            default:
                langInstruction = '\n\nIMPORTANT: Always reply in the user\'s language. If they write in Russian, reply in Russian. If they write in English, reply in English.';
                break;
        }

        const parts = [
            '## Identity',
            `You are **${appName}** — an intelligent assistant for creating visual books on the Animastor platform.`,
            `Always introduce yourself as ${appName}. When greeting users, say you are ${appName}, their visual book assistant — NOT any other AI assistant or service.`,
            `Your AI model identifier is: ${modelName || 'AI model'}. If asked about your model, architecture, or origin, respond ONLY with this exact identifier. Never use any other model name.`,
            '',
            '## Mission',
            'Help users create, edit, and publish multimedia visual books. Assist with plot development, character design, scene structuring, and all aspects of the Animastor platform.',
            '',
            `Mode: ${modeKey.charAt(0).toUpperCase() + modeKey.slice(1)}`,
            modePrompt,
            '',
            `Topic: ${topicKey.charAt(0).toUpperCase() + topicKey.slice(1)}`,
            topicPrompt,
        ];
        if (positionContext) {
            parts.push('');
            parts.push(`Current context: ${positionContext}`);
        }
        if (langInstruction) {
            parts.push('');
            parts.push(langInstruction.trim());
        }

        return parts.join('\n');
    }

    // ── System prompt (fallback for legacy clients) ────
    // The persona CONTENT is host-owned and injected as a ready string
    // (deps.aiProfile) — the package has no fs, no path and no knowledge of
    // the host persona file. No injected content → the built-in profile
    // fallback, same as a missing file historically.
    function loadSystemPrompt() {
        if (AI_PROFILE) return AI_PROFILE;
        return `# AI Assistant Profile: Анимастор

## Identity
Ты — **Анимастор**, умный помощник для создания интерактивных историй и книг на платформе Animastor.

## Mission
Ты помогаешь пользователям создавать, редактировать и публиковать мультимедийные книги.

## Capabilities
- Помогаешь придумывать сюжеты, персонажей, диалоги и сценарии
- Разбиваешь текст на сцены, главы, описываешь визуальные и аудио-элементы
- Объясняешь формат .vbook и процесс генерации
- Отвечаешь на вопросы по платформе
- Предлагаешь креативные идеи

## Rules
- Всегда представляешься как Анимастор
- Не выдаёшь себя за человека
- Отвечаешь на том же языке, на котором к тебе обратились
- Если вопрос вне твоей компетенции — честно говоришь об этом`;
    }

    // ── Book context builder ──────────────────────────
    // The book JSON is a READ-ONLY snapshot for the model. Until 0.3.1 the
    // header said "modify it as needed, and return the full changed version
    // in your response" — models did exactly that (a ```json block with the
    // changed scene + "Done") instead of calling edit_book, and nothing was
    // saved (reports/2026-11-22/assistant-edit-bug.md).
    // opts.canEdit — edit_book is offered in this turn (edit mode, unlocked).
    function bookContextHeader(canEdit) {
        return canEdit
            ? 'Below is the current book JSON — a READ-ONLY snapshot. To change the book call the `edit_book` tool; a JSON or text in your reply changes nothing.'
            : 'Below is the current book JSON for reference. In this mode you cannot change the book — if the user asks for a change, tell them to switch to the Edit mode.';
    }

    function buildBookContext(bookData, opts = {}) {
        if (!bookData) return '';
        const isLocked = bookData.manifest?.locked === true;
        const lines = [];
        lines.push(`Locked: ${isLocked}`);
        lines.push('');
        lines.push(bookContextHeader(opts.canEdit === true));
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(bookData, null, 2));
        lines.push('```');
        return lines.join('\n');
    }

    /**
     * Compact structural summary of the book — bounded well below the Local AI
     * Connector per-message cap (32 KB, lib/chat.cjs maxMessageChars). Used
     * when the full book JSON cannot ride the system message (connector
     * transport): structure, ids and titles survive; unit texts are omitted.
     * @param {object|null} bookData
     * @returns {string} '' when no book data
     */
    function buildCompactBookContext(bookData, opts = {}) {
        if (!bookData) return '';
        const MAX_CHAPTERS = 40;
        const MAX_SCENES_PER_CHAPTER = 40;
        const lines = [];
        lines.push('Full book JSON is too large for this transport — use this structural summary instead.');
        lines.push(bookContextHeader(opts.canEdit === true));
        lines.push(`Book: ${bookData.book?.title || bookData.manifest?.title || 'Untitled'}`);
        lines.push(`Locked: ${bookData.manifest?.locked === true}`);
        const heroes = Array.isArray(bookData.heroes) ? bookData.heroes : [];
        if (heroes.length > 0) {
            const names = heroes.slice(0, 30).map((h) => `${(h && h.id) || '?'}${h && h.name ? ` (${h.name})` : ''}`).join(', ');
            lines.push(`Heroes: ${names}`);
        }
        const chapters = Array.isArray(bookData.chapters) ? bookData.chapters : [];
        lines.push(`Chapters: ${chapters.length}`);
        chapters.slice(0, MAX_CHAPTERS).forEach((ch, i) => {
            const scenes = Array.isArray(ch.scenes) ? ch.scenes : [];
            lines.push(`- Chapter ${i + 1}${ch.chapter_id ? ` [${ch.chapter_id}]` : ''}${ch.title ? ` "${ch.title}"` : ''}: ${scenes.length} scene(s)`);
            scenes.slice(0, MAX_SCENES_PER_CHAPTER).forEach((sc, j) => {
                lines.push(`  - Scene ${j + 1} [${sc.scene_id || '?'}]${sc.scene_title ? ` "${sc.scene_title}"` : ''} (${sc.type || 'default'})`);
            });
        });
        return lines.join('\n');
    }

    // ── Tool definitions ──────────────────────────────
    const EDIT_BOOK_TOOL = {
        type: 'function',
        function: {
            name: 'edit_book',
            description: 'Apply changes to the current book. Call this when the user asks to edit the book content (title, author, heroes, scenes, text, behaviour, etc.). Heroes are addressed by id: /heroes/{hero_id}/... (for example /heroes/yura/behaviour/profile). Do NOT call if the book is locked.',
            parameters: {
                type: 'object',
                properties: {
                    patches: {
                        type: 'array',
                        description: 'List of JSON Patch operations',
                        items: {
                            type: 'object',
                            properties: {
                                op: { type: 'string', enum: ['replace', 'add', 'remove'], description: 'Operation type' },
                                path: { type: 'string', description: 'JSON path like /book/title, /chapters/0/scenes/1/units/0/text, /heroes/yura/passport/clothes, /heroes/yura/behaviour/profile' },
                                value: { description: 'New value (for replace/add)' },
                            },
                            required: ['op', 'path'],
                        },
                    },
                },
                required: ['patches'],
            },
        },
    };

    // ── Mode-specific tool selection ──────────────────
    // Only 'edit' carries a tool (EDIT_BOOK_TOOL — the one with a real
    // backend handler). Every other mode is text-only: the remaining tool
    // definitions (storyboard / import_book / extract_entities /
    // validate_book) never had handlers (ai-routes.cjs replies
    // 'Tool executed (no handler)'), so exposing them only taught models to
    // burn tokens on calls that did nothing.
    function getToolsForMode(mode, bookId, isLocked) {
        if (mode === 'edit' && !isLocked) return [EDIT_BOOK_TOOL];
        return [];
    }

    // ── AI response parsing ───────────────────────────
    function parseAIResponse(text) {
        if (!text) return { reply: '', patches: [] };

        // Strip AI chain-of-thought reasoning blocks — not meant for the UI
        text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        const patches = [];
        const regex = /```patches\n([\s\S]*?)```/g;
        let match;
        let cleanText = text;

        while ((match = regex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(match[1].trim());
                if (Array.isArray(parsed)) {
                    patches.push(...parsed);
                } else {
                    patches.push(parsed);
                }
            } catch (e) {
                console.warn('[AI] Failed to parse patches block:', e.message);
            }
            cleanText = cleanText.replace(match[0], '').trim();
        }

        // Also look for inline JSON patches (single { ... } with op/path)
        const inlineRegex = /\{(?:[^{}]|(?:\{[^{}]*\}))*\}/g;
        let inlineMatch;
        while ((inlineMatch = inlineRegex.exec(text)) !== null) {
            try {
                const parsed = JSON.parse(inlineMatch[0]);
                if (parsed.op && parsed.path) {
                    patches.push(parsed);
                }
            } catch (e) { /* not a valid patch object */ }
        }

        return { reply: cleanText.trim(), patches };
    }

    // ── JSON path resolver ────────────────────────────
    function resolvePath(obj, pathStr) {
        const parts = pathStr.split('/').filter(Boolean);
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const key = parts[i];
            if (current[key] === undefined || current[key] === null) {
                try {
                    const num = parseInt(key, 10);
                    if (!isNaN(num) && Array.isArray(current)) {
                        current = current[num];
                    } else {
                        current = current[key];
                    }
                } catch {
                    return { parent: null, key: null, value: undefined };
                }
            } else {
                current = current[key];
            }
        }
        const lastKey = parts[parts.length - 1];
        return { parent: current, key: lastKey, value: current ? current[lastKey] : undefined };
    }

    function ensureObjectParents(obj, pathStr) {
        const parts = String(pathStr || '').split('/').filter(Boolean);
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            if (current === null || typeof current !== 'object') return;
            const key = Array.isArray(current) && /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
            if (current[key] === undefined || current[key] === null) {
                if (Array.isArray(current) || /^\d+$/.test(parts[i + 1]) || parts[i + 1] === '-') return;
                current[key] = {};
            }
            current = current[key];
        }
    }

    // ── JSON Patch application ────────────────────────
    function applyPatches(obj, patches) {
        const result = JSON.parse(JSON.stringify(obj));
        const errors = [];
        const guarded = normalizeHeroPatches(result, patches || []);
        errors.push(...guarded.errors);
        if (guarded.errors.length > 0) return { result, errors };

        for (const patch of guarded.patches) {
            const { op, path: pathStr, value } = patch;
            // `add` creates missing intermediate OBJECTS (never arrays): adding
            // /heroes/<id>/behaviour/profile to a hero without behaviour works
            if (op === 'add') ensureObjectParents(result, pathStr);
            const { parent, key, value: oldValue } = resolvePath(result, pathStr);

            if (!parent && op !== 'add') {
                errors.push(`Cannot resolve path: ${pathStr}`);
                continue;
            }

            try {
                switch (op) {
                    case 'replace':
                        if (key !== null && key in parent) {
                            parent[key] = value;
                        } else {
                            errors.push(`Path not found for replace: ${pathStr}`);
                        }
                        break;

                    case 'add':
                        if (key === '-') {
                            if (Array.isArray(parent)) {
                                parent.push(value);
                            } else {
                                errors.push(`Cannot append to non-array: ${pathStr}`);
                            }
                        } else if (key && key.match(/^\d+$/)) {
                            const idx = parseInt(key, 10);
                            if (Array.isArray(parent)) {
                                parent.splice(idx, 0, value);
                            } else {
                                errors.push(`Cannot insert at index in non-array: ${pathStr}`);
                            }
                        } else if (parent && key) {
                            parent[key] = value;
                        } else {
                            errors.push(`Invalid add path: ${pathStr}`);
                        }
                        break;

                    case 'remove':
                        if (key && key.match(/^\d+$/)) {
                            const idx = parseInt(key, 10);
                            if (Array.isArray(parent)) {
                                parent.splice(idx, 1);
                            } else {
                                errors.push(`Cannot remove index from non-array: ${pathStr}`);
                            }
                        } else if (parent && key && key in parent) {
                            delete parent[key];
                        } else {
                            errors.push(`Path not found for remove: ${pathStr}`);
                        }
                        break;

                    default:
                        errors.push(`Unknown operation: ${op}`);
                }
            } catch (e) {
                errors.push(`Error applying ${op} at ${pathStr}: ${e.message}`);
            }
        }

        return { result, errors };
    }

    // ── Deterministic scene-participants guard ─────────
    // Models frequently produce `scene.participants` in the wrong shape when
    // editing (e.g. {"item": [...]} — a JSON-Schema `items` hallucination, or
    // display names ["Юра","yura"] instead of IDs). Left alone, those values
    // would either corrupt the canonical state ({"item": ...} passed the old
    // contract check) or leave the user's "IDs only" request half-done.
    // This normalizer runs over EVERY scene after patches are applied, so a
    // partial or malformed model patch can never leave the field broken:
    //   - {"item": x}            → unwrapped to x
    //   - bare string            → wrapped into an array
    //   - display name (Юра)     → mapped to its hero id (yura) — the EXACT name
    //                              (case-insensitive) of a hero, nothing fuzzy
    //   - duplicates             → removed, order preserved
    function normalizeBookParticipants(book) {
        if (!book || !Array.isArray(book.chapters)) return book;
        const lookup = new Map();
        if (Array.isArray(book.heroes)) {
            for (const ch of book.heroes) {
                if (!ch || typeof ch !== 'object') continue;
                const id = ch.id;
                if (typeof id === 'string' && id) {
                    lookup.set(id.toLowerCase(), id);
                    if (typeof ch.name === 'string' && ch.name) {
                        lookup.set(ch.name.toLowerCase(), id);
                    }
                }
            }
        }
        const normalizeOne = (value) => {
            if (value === null || value === undefined) return value;
            let arr;
            if (typeof value === 'object' && !Array.isArray(value) && value.item !== undefined) {
                arr = value.item;
            } else {
                arr = value;
            }
            if (typeof arr === 'string') arr = [arr];
            if (!Array.isArray(arr)) return value; // unfixable — left for the validator to reject
            const out = [];
            for (const item of arr) {
                if (typeof item !== 'string') continue;
                const s = item.trim();
                if (!s) continue;
                const resolved = lookup.get(s.toLowerCase()) || s;
                if (!out.includes(resolved)) out.push(resolved);
            }
            return out;
        };
        for (const chapter of book.chapters) {
            if (!chapter || typeof chapter !== 'object' || !Array.isArray(chapter.scenes)) continue;
            for (const scene of chapter.scenes) {
                if (scene && typeof scene === 'object' && 'participants' in scene) {
                    scene.participants = normalizeOne(scene.participants);
                }
            }
        }
        return book;
    }

    // ── Patch application with bundle-contract validation ──
    // Pipeline: AI patch → apply ops → normalize participants → validate
    // contract → only a valid result is returned as candidate canonical
    // state. On violation the result is withheld (null) so no caller can
    // persist broken JSON; errors name the failing file/resource so the
    // assistant (or the user) can issue a corrective patch in the next turn.
    // ── Hero path guard (VBOOK_FORMAT_V4 §8.2) ─────────
    // `heroes` is an array in memory, but the segment after /heroes/ is a HERO
    // ID, never an array index: the guard turns /heroes/<id>/… into
    // /heroes/<index>/… before the patches run. Refused (with a hint):
    //   - the 3.1 maps /characters, /voices, /behaviors, /behavior_rules,
    //     /mentions, /behavior;
    //   - computed fields: /hero_issues, /scene_list, /heroes/<id>/rev;
    //   - replacing or removing the whole /heroes list (a stale list would
    //     wipe the cast) and indexes /heroes/-, /heroes/<n> addressing;
    //   - removing the narrator; changing a hero's id or schema;
    //   - writing voice.reference (only the hero card pins a reference).
    // `add /heroes/<new_id>` appends a new hero (its value.id must be <new_id>).
    const LEGACY_ROOTS = ['characters', 'voices', 'behaviors', 'behavior_rules', 'mentions', 'behavior'];
    const COMPUTED_ROOTS = ['hero_issues', 'scene_list'];
    const LEGACY_HINT = 'VBook 4 keeps every character in `heroes`: use /heroes/<hero_id>/… (for example /heroes/yura/behaviour/profile)';
    function normalizeHeroPatches(book, patches) {
        const errors = [];
        const out = [];
        const heroes = book && Array.isArray(book.heroes) ? book.heroes : null;
        const indexOf = (id) => (heroes ? heroes.findIndex((h) => h && h.id === id) : -1);
        const added = new Set();
        for (const patch of Array.isArray(patches) ? patches : []) {
            if (!patch || typeof patch.path !== 'string') { out.push(patch); continue; }
            const parts = patch.path.split('/');
            const root = parts[1];
            if (LEGACY_ROOTS.includes(root)) {
                errors.push(`Path ${patch.path} is not part of VBook 4. ${LEGACY_HINT}`);
                continue;
            }
            if (COMPUTED_ROOTS.includes(root)) {
                errors.push(`Path ${patch.path} is computed by the server and cannot be written`);
                continue;
            }
            if (root !== 'heroes') { out.push(patch); continue; }
            if (parts.length < 3 || parts[2] === '') {
                errors.push(`Path ${patch.path}: the whole heroes list cannot be ${patch.op === 'remove' ? 'removed' : 'replaced'} — edit one hero: /heroes/<hero_id>/…`);
                continue;
            }
            const heroId = parts[2];
            const rest = parts.slice(3);
            if (heroId === '-') {
                errors.push(`Path ${patch.path}: heroes are addressed by id — add a new hero with add /heroes/<new_id>`);
                continue;
            }
            if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(heroId) || heroId.length > 64) {
                errors.push(`Path ${patch.path}: "${heroId}" is not a hero id (latin snake_case; the segment after /heroes/ is an id, not an index)`);
                continue;
            }
            const field = rest[0];
            if (field === 'id' || field === 'schema' || field === 'rev') {
                errors.push(`Path ${patch.path}: ${field} of a hero cannot be changed`);
                continue;
            }
            if (field === 'voice' && (rest[1] === 'reference' || ((patch.op === 'add' || patch.op === 'replace') && rest.length === 1
                && patch.value && typeof patch.value === 'object' && 'reference' in patch.value))) {
                errors.push(`Path ${patch.path}: voice.reference is pinned only from the hero card`);
                continue;
            }
            const idx = indexOf(heroId);
            if (rest.length === 0) {
                if (patch.op === 'remove') {
                    if (heroId === 'narrator') { errors.push('The narrator cannot be removed'); continue; }
                    if (idx < 0) { errors.push(`Hero ${heroId} not found`); continue; }
                    out.push({ ...patch, path: `/heroes/${idx}` });
                    continue;
                }
                const value = patch.value;
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    errors.push(`Path ${patch.path}: a hero is an object`);
                    continue;
                }
                if (value.id !== undefined && value.id !== heroId) {
                    errors.push(`Path ${patch.path}: value.id "${value.id}" differs from the id in the path`);
                    continue;
                }
                if (value.voice && typeof value.voice === 'object' && 'reference' in value.voice) {
                    const current = idx >= 0 ? heroes[idx] : null;
                    const same = current && current.voice && JSON.stringify(current.voice.reference) === JSON.stringify(value.voice.reference);
                    if (!same) { errors.push(`Path ${patch.path}: voice.reference is pinned only from the hero card`); continue; }
                }
                const hero = { schema: 'animastor.character/1', ...value, id: heroId };
                if (patch.op === 'add' && idx < 0 && !added.has(heroId)) {
                    added.add(heroId);
                    out.push({ op: 'add', path: '/heroes/-', value: hero });
                    continue;
                }
                if (idx < 0) { errors.push(`Hero ${heroId} not found`); continue; }
                out.push({ op: 'replace', path: `/heroes/${idx}`, value: hero });
                continue;
            }
            if (idx < 0) { errors.push(`Hero ${heroId} not found (add it first: add /heroes/${heroId})`); continue; }
            out.push({ ...patch, path: `/heroes/${idx}/${rest.join('/')}` });
        }
        return { patches: out, errors };
    }

    // ── Server-assigned ids for scenes / units added by a patch ──
    // A model adding a scene often omits scene_id / unit ids (or the whole
    // `units`/`participants` arrays). Such a scene passed the contract but
    // was unaddressable afterwards (no scene_id → no chunk, no generation,
    // no editor route). Missing ids get `sc-`/`iu-` + 8 hex, unique in the
    // book; existing ids are never touched.
    function randomHex8() {
        let s = '';
        for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    function assignMissingIds(book) {
        if (!book || !Array.isArray(book.chapters)) return book;
        const used = new Set();
        const scenesOf = (ch) => (ch && Array.isArray(ch.scenes) ? ch.scenes : []);
        for (const ch of book.chapters) {
            for (const sc of scenesOf(ch)) {
                if (!sc || typeof sc !== 'object') continue;
                if (typeof sc.scene_id === 'string' && sc.scene_id) used.add(sc.scene_id);
                for (const u of Array.isArray(sc.units) ? sc.units : []) {
                    if (u && typeof u.id === 'string' && u.id) used.add(u.id);
                }
            }
        }
        const fresh = (prefix) => {
            let id;
            do { id = `${prefix}-${randomHex8()}`; } while (used.has(id));
            used.add(id);
            return id;
        };
        for (const ch of book.chapters) {
            for (const sc of scenesOf(ch)) {
                if (!sc || typeof sc !== 'object' || Array.isArray(sc)) continue;
                if (typeof sc.scene_id !== 'string' || !sc.scene_id) sc.scene_id = fresh('sc');
                if (sc.participants === undefined) sc.participants = [];
                if (!Array.isArray(sc.units)) continue;
                for (const u of sc.units) {
                    if (u && typeof u === 'object' && !Array.isArray(u) && (typeof u.id !== 'string' || !u.id)) {
                        u.id = fresh('iu');
                    }
                }
            }
        }
        return book;
    }

    // ── Honest edit outcome (0.3.1) ────────────────────
    // A turn in which edit_book was offered but NOT called, while the reply
    // claims a finished change ("Done. I've added…", "Готово, добавил…") or
    // pastes a changed book/scene JSON, changed nothing — the user must not
    // be told otherwise. Heuristic on purpose: it only decides whether the
    // route asks the model once more and, failing that, replaces the reply
    // with an honest "the book was NOT changed".
    const CLAIM_VERBS_EN = '(?:added|updated|changed|filled(?:\\s+in)?|created|replaced|removed|deleted|set|written|applied|inserted|renamed|modified|edited|fixed|appended)';
    const CHANGE_CLAIM_PATTERNS = [
        /^\s*(?:\*\*)?(?:done|all set|changes applied)\b/i,
        new RegExp(`\\bI(?:'|’)?ve\\s+(?:now\\s+|also\\s+)?${CLAIM_VERBS_EN}\\b`, 'i'),
        new RegExp(`\\bI\\s+have\\s+(?:now\\s+|also\\s+)?${CLAIM_VERBS_EN}\\b`, 'i'),
        new RegExp(`\\b(?:has|have)\\s+(?:now\\s+)?been\\s+${CLAIM_VERBS_EN}\\b`, 'i'),
        /(?:^|[^\p{L}])(?:готово|сделано|добавил[аи]?|обновил[аи]?|изменил[аи]?|заполнил[аи]?|вн[её]с(?:ла|ли)?|создал[аи]?|заменил[аи]?|удалил[аи]?|применил[аи]?|переименовал[аи]?|исправил[аи]?|дописал[аи]?)(?!\p{L})/iu,
    ];
    // A fenced JSON block that looks like book content (a changed scene /
    // unit / hero / patch list) rather than an illustrative snippet.
    const BOOK_JSON_BLOCK = /```(?:json)?\s*[[{][\s\S]*?"(?:scene_id|scenes|units|chapters|heroes|chapter_id|op)"\s*:[\s\S]*?```/i;

    function looksLikeChangeClaim(text) {
        const t = String(text || '');
        if (!t.trim()) return false;
        if (BOOK_JSON_BLOCK.test(t)) return true;
        // A reply that ends by asking the user ("…чтобы я добавил сцену?",
        // "Shall I add it?") is a question, not a report of a change.
        if (/[?？]\s*$/.test(t.replace(/[\s*_`)]+$/, ''))) return false;
        return CHANGE_CLAIM_PATTERNS.some((re) => re.test(t));
    }

    // The corrective turn the route sends once when the model claimed a
    // change without calling the tool.
    const EDIT_RETRY_PROMPT = 'You have NOT called the `edit_book` tool, so the book is unchanged — nothing you wrote was saved. '
        + 'Call `edit_book` now with the JSON Patch operations that implement the change you described. '
        + 'If you cannot express it as patches, say plainly that the book was not changed.';

    function applyPatchesValidated(obj, patches) {
        const { result, errors } = applyPatches(obj, patches);
        if (errors.length > 0) {
            return { result: null, errors, validation_errors: [] };
        }
        assignMissingIds(result);
        // Deterministic guard: unwrap {"item": x}, map names → character_id,
        // dedupe — across ALL scenes, not just the ones the model patched.
        normalizeBookParticipants(result);
        const validation = validateBundleObject(result);
        if (!validation.valid) {
            return {
                result: null,
                errors: [`Bundle validation failed: ${validation.errors.join('; ')}`],
                validation_errors: validation.errors,
            };
        }
        return { result, errors, validation_errors: [] };
    }

    // `applyPatches` is kept exported for tests/legacy callers; AI mutation
    // routes use `applyPatchesValidated` (see ai-routes.cjs).
    return {
        AI_PROFILE,
        AI_API_BASE_URL,
        loadSystemPrompt,
        buildChatSystemPrompt,
        buildBookContext,
        buildCompactBookContext,
        getToolsForMode,
        parseAIResponse,
        resolvePath,
        applyPatches,
        applyPatchesValidated,
        normalizeHeroPatches,
        normalizeBookParticipants,
        assignMissingIds,
        looksLikeChangeClaim,
        EDIT_RETRY_PROMPT,
        chatRequestExtras,
        validateBundleObject,
        toolDefinitions: {
            EDIT_BOOK_TOOL,
        },
        // Chat body extras + compatibility retry (request-extras.cjs) —
        // handed to the routes through the engine (the route file holds no
        // require() calls).
        requestExtras,
    };
};
