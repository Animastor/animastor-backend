// ======================================================
// Lazy Book — Scene & Chapter Creation
// ======================================================

const fs = require('fs');
const path = require('path');
const { BookState, SceneStatus } = require('./constants');
const { getBookDir, getChapterDir, getBookMetaPath, getBiblePath, getLocationsPath, chapterId, sceneId, unitId } = require('./paths');
const { detectLanguage } = require('@animastor/parser');
const { findCanonicalCharacter, isGenericCharacter, isPlaceholderCharacter, hasRealAppearance } = require('../character-identity');
const { sanitizeParticipants, findCanonicalId, canonicalizeMixedScriptId, isFantasySnakeToken, sanitizeEnvironment } = require('../snake-guard');
const draft = require('./draft');
const metadata = require('./metadata');
const chapterUtils = require('./chapter-utils');
const appearance = require('./appearance');
const { voiceFromDescription } = require('../voice');
const characterStore = require('../character-store.cjs');
const { CHARACTER_SCHEMA } = require('../character-validator.cjs');
const { passportHeroes, isValidHeroId, NARRATOR_ID } = require('../heroes.cjs');
const { LOOK_FIELDS } = require('../looks.cjs');

// The analysis hands over a voice either as one description string (3.1-era
// step, cleaned by rules) or — once the analysis step is moved to v4 — as
// { timbre, manner }. There is no `instruction` in VBook 4.
function voiceFromAnalysis(raw) {
    if (typeof raw === 'string' && raw.trim()) return voiceFromDescription(raw);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const timbre = typeof raw.timbre === 'string' ? raw.timbre.trim() : '';
        const manner = typeof raw.manner === 'string' ? raw.manner.trim() : '';
        if (timbre || manner) return { timbre, manner, timbre_source: 'analysis' };
    }
    return null;
}

// scene.look_patch[hero_id] (VBOOK_FORMAT_V4 §4a.4): only the three look
// fields, only non-empty values, only for heroes of the book. Anything else
// the analysis put there is dropped at this write barrier.
function sanitizeLookPatch(raw, knownHeroIds) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const out = {};
    for (const [heroId, patch] of Object.entries(raw)) {
        if (!knownHeroIds.has(heroId) || !patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
        const clean = {};
        for (const field of LOOK_FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
            if (field === 'video_tokens') {
                const tokens = appearance.sanitizeVideoTokens(patch[field]);
                if (tokens && tokens.length > 0) clean[field] = tokens;
            } else if (typeof patch[field] === 'string' && patch[field].trim()) {
                clean[field] = patch[field].trim();
            }
        }
        if (Object.keys(clean).length > 0) out[heroId] = clean;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function createFromAnalysis(bookId, analysis, options = {}) {
    const { maxScenes, chapterTitle } = options;
    const structure = options.structure || analysis.structure || null;
    return createOrAppendScenes(bookId, analysis, {
        maxScenes: maxScenes ?? analysis.maxScenes ?? 6,
        chapterTitle: chapterTitle ?? analysis.chapterTitle ?? null,
        chapterIndex: 0,
        isFirstWindow: true,
        structure: structure,
    });
}

function appendToBook(bookId, analysis, options = {}) {
    const { chapterTitle, chapterIndex } = options;
    const structure = options.structure || analysis.structure || null;
    return createOrAppendScenes(bookId, analysis, {
        maxScenes: options.maxScenes ?? analysis.maxScenes ?? 6,
        chapterTitle: chapterTitle ?? analysis.chapterTitle ?? null,
        chapterIndex: chapterIndex ?? analysis.chapterIndex ?? 0,
        isFirstWindow: false,
        structure: structure,
    });
}

function createOrAppendScenes(bookId, analysis, windowConfig) {
    const d = draft.loadDraftBook(bookId);
    if (!d) throw new Error(`Book ${bookId} not found`);
    if (!d.sourceText) throw new Error(`Book ${bookId} has no source text`);

    let bookMeta = d.book;
    const sourceText = d.sourceText;
    const language = bookMeta.language || detectLanguage(sourceText);
    if (!bookMeta.language) bookMeta.language = language;

    const { maxScenes, chapterTitle, chapterIndex, isFirstWindow, structure } = windowConfig;
    const bookDir = getBookDir(bookId);

    if (structure && isFirstWindow) {
        metadata.updateBookMetadata(bookDir, {
            author: structure.author,
            title: structure.title,
            structure: {
                has_prologue: structure.has_prologue,
                has_epilogue: structure.has_epilogue,
                parts: structure.parts,
                chapters: structure.chapters,
            },
        });
        // updateBookMetadata's guards skip already-set title/author — but the
        // draft title is the FILENAME ("test.txt"), which must be overridden
        // by the real detected title (same behavior as bootstrap.js).
        const freshMeta = JSON.parse(fs.readFileSync(getBookMetaPath(bookDir), 'utf8'));
        if (structure.title) freshMeta.title = structure.title;
        if (structure.author) freshMeta.author = structure.author;
        fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(freshMeta, null, 2));
        // Re-read: the final chapters_order write below must not clobber the
        // metadata update above with the stale in-memory copy.
        bookMeta = JSON.parse(fs.readFileSync(getBookMetaPath(bookDir), 'utf8'));
    }

    let existingCharacters = [];
    let existingLocations = {};

    if (!isFirstWindow) {
        // The registry of characters = heroes with a passport (§4). Hero files
        // are read through the character store; a broken file is simply not
        // part of the registry (it is reported in hero_issues and left alone).
        //
        // Load-time placeholder filter (same rule as runPipeline): a legacy
        // 'unknown'/'unnamed' has no real information and must not re-enter
        // the registry or scene.participants. A character with a REAL
        // appearance keeps its id even when it looks like a placeholder word
        // ('neizvestnyy' — the mysterious stranger is a real literary character).
        existingCharacters = passportHeroes(d);
        const filtered = existingCharacters.filter(c => !isPlaceholderCharacter(c));
        if (filtered.length !== existingCharacters.length) {
            console.warn(`[LAZY-BOOK] Filtered ${existingCharacters.length - filtered.length} placeholder character(s) from existing registry`);
            existingCharacters = filtered;
        }
        try {
            // Load existing locations from separate file
            const locPath = getLocationsPath(bookDir);
            if (fs.existsSync(locPath)) {
                const raw = JSON.parse(fs.readFileSync(locPath, 'utf8'));
                // Migrate mixed-script keys (pre-chimera-guard data) to their
                // canonical latin form so new windows link locations correctly.
                existingLocations = {};
                for (const [id, entry] of Object.entries(raw)) {
                    existingLocations[canonicalizeMixedScriptId(id)] = entry;
                }
            }
        } catch (e) {
            console.warn(`[LAZY-BOOK] Failed to load existing locations: ${e.message}`);
        }
    }

    const existingIds = new Set(existingCharacters.map(c => c.id));
    const mergedCharacters = [...existingCharacters];
    // New heroes of this window (not yet on disk) and the voices the analysis
    // proposed, keyed by the FINAL hero id.
    const newHeroes = [];
    const proposedVoices = new Map();
    const skippedHeroes = [];

    for (const ch of (analysis.characters || [])) {
        // Chimera id (mixed-script / wrong transliteration / typo / noise suffix)
        // that CONFIDENTLY matches an existing character → align to the canonical
        // registry id; never create a duplicate key for the same person.
        const charId = (() => {
            const rawId = ch.id || ch.name.toLowerCase().replace(/[^a-zа-яё0-9]+/g, '_').replace(/^_|_$/g, '');
            const mixed = canonicalizeMixedScriptId(rawId);
            // Registry-write path: NO fuzzy tier (fuzzy:false) — a wrong fuzzy
            // merge here would DROP a genuinely distinct character. Only
            // normalized-equality (mixed-script/translit) and suffix variants
            // are aligned; typo-level variants go to the prompt repair step.
            const canonical = findCanonicalId(mixed, mergedCharacters.map(c => c.id), { fuzzy: false });
            if (canonical && canonical.toLowerCase() !== mixed.toLowerCase()) {
                console.warn(`[LAZY-BOOK] Character id "${mixed}" canonicalized to "${canonical}"`);
            }
            return canonical || mixed;
        })();
        const proposedVoice = voiceFromAnalysis(ch.voice);
        if (proposedVoice && !proposedVoices.has(charId)) proposedVoices.set(charId, proposedVoice);
        if (existingIds.has(charId)) continue;
        // Placeholder ids/names ('unknown', 'unnamed', 'Unidentified', …) are
        // NEVER real characters — absence of information ≠ a fictitious
        // 'unknown' character. Dropped at the write barrier so it can never
        // enter characters.json or scene.participants.
        if (isPlaceholderCharacter({ ...ch, id: charId })) {
            console.warn(`[LAZY-BOOK] Skipping placeholder character "${charId}" — no information ≠ 'unknown'`);
            continue;
        }
        if (isGenericCharacter({ ...ch, id: charId })) {
            console.warn(`[LAZY-BOOK] Skipping generic character without stable context: ${charId}`);
            continue;
        }
        // Dialogue participation is NOT a character criterion: without a
        // described appearance a person is not a character (characters.md).
        // Skip here so no id/name/default-voice/passport is invented for them.
        // (The agent may still extract one — this guard enforces the rule.)
        const rawAppearanceCheck = ch.appearance || ch.description || null;
        if (!rawAppearanceCheck || /не опис|no descr|unknown|unclear/i.test(rawAppearanceCheck)) {
            console.warn(`[LAZY-BOOK] Skipping character without described appearance: ${charId} — not a character`);
            continue;
        }
        const canonical = findCanonicalCharacter({ ...ch, id: charId }, mergedCharacters);
        if (canonical) {
            console.log(`[LAZY-BOOK] Merged character alias ${charId} -> ${canonical.id}`);
            continue;
        }

        // The AGENT (ai/rules/characters.md) is responsible for separating the
        // physical appearance from the clothes. The program ONLY validates the
        // agent's output and fills safe defaults — it never re-splits text with
        // heuristics, so appearance and clothes never overlap or get mangled.
        const rawAppearance = ch.appearance || ch.description || null;

        let appearanceDesc;
        if (!rawAppearance || /не опис|no descr|unknown|unclear/i.test(rawAppearance)) {
            appearanceDesc = `${ch.name}: a character from the story, seen in period-appropriate clothing, with distinctive features as described in the narrative context`;
        } else {
            appearanceDesc = rawAppearance;
        }

        // clothes comes from the agent as its own field. An empty string is fine —
        // the prompt builder appends clothing only when it is non-empty.
        const clothes = (typeof ch.clothes === 'string' && ch.clothes.trim())
            ? ch.clothes.trim()
            : '';

        // video_tokens — stage 1 of the two-stage scheme: the AGENT
        // (ai/rules/characters.md) picks 1-4 short, highly visible visual
        // features per character (e.g. "tie", "round glasses", "bald head").
        // The program only sanitizes that list (trim, cap at 4) and falls back
        // to the deterministic fragment when the agent gave nothing. Uniqueness
        // against other scene participants is handled LATER by the passport
        // reconciliation step (stage 2), which writes scene.passport overrides.
        let videoTokens = appearance.sanitizeVideoTokens(ch.video_tokens);
        if (!videoTokens) {
            const frag = appearance.fragmentAppearanceForVideo(
                clothes ? `${appearanceDesc}, ${clothes}` : appearanceDesc,
                ch.name
            );
            videoTokens = frag ? [frag] : [];
        }

        // A hero id is the file name characters/<id>.json: canonical snake_case
        // and not reserved (§4). Until the analysis normalises its ids (step 2 of
        // VBOOK_FORMAT_V4 §12) a hero with any other id is NOT written — it is
        // reported, and its scenes keep the participant as a natural designation.
        if (!isValidHeroId(charId)) {
            console.warn(`[LAZY-BOOK] Skipping hero with a non-canonical or reserved id ${JSON.stringify(charId)} — cannot be a characters/<id>.json file`);
            skippedHeroes.push({ id: charId, name: ch.name || null, reason: 'invalid_hero_id' });
            continue;
        }

        const hero = {
            schema: CHARACTER_SCHEMA,
            id: charId,
            name: ch.name,
            role: ch.role || 'minor',
            passport: {
                appearance: appearanceDesc,
                clothes,
                video_tokens: videoTokens.length > 0
                    ? videoTokens
                    : [`${ch.name.toLowerCase()} character, period clothing, distinctive appearance`],
            },
        };
        mergedCharacters.push(hero);
        newHeroes.push(hero);
        existingIds.add(charId);
    }

    let locations = { ...existingLocations };
    for (const loc of (analysis.locations || [])) {
        const rawLocId = loc.id || loc.name.toLowerCase().replace(/[^a-zа-яё0-9]+/g, '_').replace(/^_|_$/g, '');
        // Mixed-script location ids ("patriarshie_pруды") are chimeras — normalize
        // to a pure latin snake id. Scene.location.id references are canonicalized
        // through the same function below, so ids stay consistent across the book.
        const locId = canonicalizeMixedScriptId(rawLocId);
        if (!locations[locId]) {
            const entry = {
                name: loc.name,
                description: loc.description || `${loc.name} — location from the source text`,
            };
            // Global environment template — scene environments override it per-field.
            // Write barrier: drop placeholder values ("not applicable", "n/a", …) so
            // they can never reach the stored locations.json or the image prompt.
            if (loc.environment && typeof loc.environment === 'object' && Object.keys(loc.environment).length > 0) {
                const env = sanitizeEnvironment(loc.environment);
                if (Object.keys(env).length > 0) entry.environment = env;
            }
            locations[locId] = entry;
        } else if (loc.name && !locations[locId].name) {
            // Backfill missing name on existing location (first window wins)
            locations[locId].name = loc.name;
        }
    }

    const bible = {
        version: '3.0',
        locations,
        country: structure?.country || null,
        epoch: structure?.epoch || null,
        render_rules: {
            style: 'cinematic_realism',
            lighting_default: 'natural',
            character_consistency: true,
            spatial_consistency: true,
        },
    };

    // ── Heroes → characters/<id>.json, through the character store ──
    // mentions.json does not exist in VBook 4 (§7): aliases live in the hero
    // file and are written from mentions by the analysis step (step 2); until
    // then mentions stay in PG only and nothing of them is written here.
    //
    // Only a character with a real appearance OR real clothes becomes a hero
    // with a passport (shared predicate — looks at the whole aggregate, not at
    // the name alone). A dialogue-only participant without a described
    // appearance is NOT a character: it gets no file and no voice; the audio
    // pipeline voices such speakers with the narrator.
    const describedIds = new Set(mergedCharacters.filter(c => hasRealAppearance(c)).map(c => c.id));
    for (const hero of newHeroes) {
        if (!describedIds.has(hero.id)) continue;
        const voice = proposedVoices.get(hero.id);
        const file = voice ? { ...hero, voice } : hero;
        try {
            characterStore.writeCharacter(bookDir, file);
        } catch (err) {
            // A broken file under this id (§10.3) or an invalid hero: never
            // overwritten, never fatal for the window.
            console.warn(`[LAZY-BOOK] Hero "${hero.id}" not written: ${err.message}`);
            skippedHeroes.push({ id: hero.id, name: hero.name || null, reason: err.code || 'write_failed' });
            describedIds.delete(hero.id);
        }
    }
    // A hero that already exists keeps its voice: a later window never
    // replaces a description the user may have edited, nor a locked
    // reference. A voice is added only where there was none.
    for (const hero of existingCharacters) {
        const voice = proposedVoices.get(hero.id);
        if (!voice || hero.voice) continue;
        try {
            characterStore.updateCharacter(bookDir, hero.id, (current) => (current.voice ? current : { ...current, voice }));
        } catch (err) {
            console.warn(`[LAZY-BOOK] Voice of "${hero.id}" not written: ${err.message}`);
        }
    }
    if (describedIds.size < mergedCharacters.length) {
        console.log(`[LAZY-BOOK] Filtered characters: ${describedIds.size} with passport out of ${mergedCharacters.length} total`);
    }

    // The narrator and behaviour.json are created with the book; heal a book
    // that lost them (a broken narrator.json is left alone).
    try { draft.ensureNarrator(bookDir, language); } catch (e) { console.warn(`[LAZY-BOOK] Narrator not created: ${e.message}`); }
    draft.ensureBehaviourGlobals(bookDir);

    // Save locations to separate file
    fs.writeFileSync(getLocationsPath(bookDir), JSON.stringify(locations, null, 2));

    // Save bible.json without locations and narrator
    const { locations: _bibleLocs, narrator: _bibleNarrator, ...bibleWithoutExtra } = bible;
    fs.writeFileSync(getBiblePath(bookDir), JSON.stringify(bibleWithoutExtra, null, 2));

    const chDir = getChapterDir(bookDir);
    if (!fs.existsSync(chDir)) fs.mkdirSync(chDir, { recursive: true });

    let chapterObj = null;
    let chFile = null;

    if (!isFirstWindow) {
        const existingChapters = fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort();
        for (const cf of existingChapters) {
            try {
                const ch = JSON.parse(fs.readFileSync(path.join(chDir, cf), 'utf8'));
                if (ch.chapter_index === chapterIndex) {
                    chapterObj = ch;
                    chFile = cf;
                    break;
                }
            } catch (e) { /* skip */ }
        }
    }

    if (!chapterObj) {
        const chId = chapterId();
        chFile = `${chId}.json`;
        chapterObj = {
            chapter_id: chId,
            chapter_title: chapterTitle || null,
            type: 'chapter',
            chapter_index: chapterIndex,
            status: SceneStatus.PARSED,
            scenes: [],
        };
    }

    const hasCoverChapter = fs.readdirSync(chDir).filter(f => f.endsWith('.json'))
        .some(f => {
            try {
                const ch = JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8'));
                return ch.type === 'cover';
            } catch (_) { return false; }
        });

    if (isFirstWindow && !hasCoverChapter) {
        // Cover ONLY when a REAL title was detected by the structure analysis
        // (v2: "find what exists"). Never the filename-derived bookMeta.title —
        // a book without a title simply has no cover chapter.
        const coverTitle = structure?.title || null;
        const coverAuthor = structure?.author || null;
        if (coverTitle) {
            const coverChapter = chapterUtils.createCoverChapter(coverTitle, coverAuthor, language);
            chapterUtils.saveCoverChapter(bookId, coverChapter);
            console.log(`[LAZY-BOOK] Cover chapter saved for ${bookId}`);

            const bookMetaPath = getBookMetaPath(bookDir);
            if (fs.existsSync(bookMetaPath)) {
                try {
                    const bm = JSON.parse(fs.readFileSync(bookMetaPath, 'utf8'));
                    if (bm.structure?.chapters_order) {
                        bm.structure.chapters_order.unshift(`${coverChapter.chapter_id}.json`);
                        fs.writeFileSync(bookMetaPath, JSON.stringify(bm, null, 2));
                    }
                } catch (_) {}
            }
        } else {
            console.log(`[LAZY-BOOK] No cover chapter — no title detected for ${bookId}`);
        }
    }

    // ── Migration: move old chapter_intro scene → chapter.intro ──
    const oldIntroIdx = chapterObj.scenes.findIndex(s => s.type === 'chapter_intro');
    if (oldIntroIdx >= 0 && !chapterObj.intro) {
        const oldIntro = chapterObj.scenes[oldIntroIdx];
        chapterObj.intro = {
            text: oldIntro.audio?.full_text || oldIntro.units?.[0]?.text || '',
            scene_title: oldIntro.scene_title || '',
            style: oldIntro.style || 'soviet_book_page',
        };
        chapterObj.scenes.splice(oldIntroIdx, 1);
    }

    // ── Segment info from the v2 chapter map ──
    // structure.chapters is aligned by index with the segments and carries
    // { type, number, title, label, header_line }. It drives the chapter
    // type, the title, and the typography intro scene.
    const segInfo = (structure && structure.chapters && windowConfig.chapterIndex < structure.chapters.length)
        ? structure.chapters[windowConfig.chapterIndex]
        : null;

    const segType = (segInfo?.type && segInfo.type !== 'body') ? segInfo.type : 'chapter';
    chapterObj.type = segType;

    // Chapter title: prologue/epilogue → label («Пролог») always wins,
    // chapter → clean title («Земля»), plain body → null (no forced structure).
    if (segInfo?.label && segType !== 'chapter') {
        chapterObj.chapter_title = segInfo.label;
    } else if (chapterObj && !chapterObj.chapter_title) {
        if (segInfo?.title) {
            chapterObj.chapter_title = segInfo.title;
        } else if (chapterTitle) {
            chapterObj.chapter_title = chapterTitle;
        }
    }

    // ── Typography intro metadata from the segment ──
    // buildSegmentIntro returns null for body/poem — unstructured text gets
    // NO "Глава 1" title card (find what exists, don't force a structure).
    if (!chapterObj.intro) {
        const introData = chapterUtils.buildSegmentIntro(
            segInfo || (chapterTitle ? { type: 'chapter', title: chapterTitle } : null),
            language
        );
        if (introData) {
            chapterObj.intro = introData;
        }
    }

    // ── Create programmatic chapter_intro scene ──
    const introMeta = chapterObj.intro;
    if (introMeta && introMeta.text) {
        const existingIntro = chapterObj.scenes.find(s => s.type === 'chapter_intro');
        if (!existingIntro) {
            // Typography page: image.prompt must carry the page text verbatim (the
            // generator has to know WHAT text to typeset, not just the style), and
            // the static title card copies it into video.action — a typography page
            // still plays in the video sequence, so an empty action is never written.
            // Instructions are English-only; the page content itself lives in the
            // delimited "text on the page" block.
            const introPrompt = chapterUtils.buildTypographyPagePrompt(
                introMeta.text,
                `title page typography, ${chapterUtils.typographyStyleDescriptor(introMeta.style || 'soviet_book_page')}, ${chapterUtils.TYPOGRAPHY_LAYOUT}`
            );
            const introScene = {
                scene_id: sceneId(),
                scene_title: introMeta.scene_title || `Глава ${(chapterIndex || 0) + 1}`,
                type: 'chapter_intro',
                style: introMeta.style || 'soviet_book_page',
                audio: {
                    voice: 'narrator',
                    full_text: introMeta.text,
                },
                units: [{
                    id: unitId(),
                    type: 'typography',
                    text: introMeta.text,
                    image: {
                        shot: 'wide',
                        prompt: introPrompt,
                    },
                    video: {
                        action: introPrompt,
                    },
                }],
            };
            chapterObj.scenes.unshift(introScene);
        }
    }

    // ── AI narrative scenes ──
    const aiScenes = (analysis.scenes || []).slice(0, maxScenes);
    const validScenes = aiScenes.filter(s => s.text && s.text.trim().length > 0 && s.units && s.units.some(u => (u.text || '').trim()));
    if (validScenes.length === 0 && !chapterObj.intro) {
        throw new Error('AI returned no valid scenes — book cannot be created');
    }

    for (const aiScene of validScenes) {
        const scId = sceneId();
        const sceneText = aiScene.text.trim();

        const sceneUnits = aiScene.units
            .filter(u => (u.text || '').trim())
            .map(u => ({
                // The pipeline pre-assigns ids when it applies behaviour rules
                // (the matcher seed depends on the unit id) — keep them.
                id: (typeof u.id === 'string' && u.id) ? u.id : unitId(),
                type: u.type || 'perception',
                text: u.text.trim(),
                audio: u.audio || undefined,
                image: u.image || undefined,
                video: u.video || undefined,
                // Behaviour (architecture/VBOOK_BEHAVIOUR.md): per-IU emotions
                // (matcher input), applied-rule copies, author lock.
                state: u.state || undefined,
                behaviour: u.behaviour || undefined,
                behaviour_locked: u.behaviour_locked || undefined,
                source_start: u.source_start ?? undefined,
                source_end: u.source_end ?? undefined,
            }));

        const cleanUnits = sceneUnits.length > 0 ? sceneUnits : [{
            id: unitId(),
            type: 'perception',
            text: sceneText,
        }];

        const isDialogue = cleanUnits.some(u => u.type === 'dialogue' || u.type === 'dialectic');

        const allParticipants = [];
        // Write barrier (hybrid safety net): a participant whose value is a
        // snake_case id NOT in characters.json is a hallucination (e.g.
        // "zhenshchina_v_budochke" instead of «женщина в будочке»). It must
        // never enter the book: known ids and natural designations are kept,
        // fantasy ids are dropped. The pipeline repair step already reassembles
        // the visual prompts — this filter guarantees the STRUCTURED field
        // stays clean even if a fantasy id survives the LLM passes.
        const knownParticipantIds = new Set(mergedCharacters.map(c => c.id).filter(Boolean));
        const sceneParticipants = sanitizeParticipants(
            aiScene.characters_present || aiScene.participants || [],
            knownParticipantIds,
            {            onDrop: (p) => console.warn(`[LAZY-BOOK] Dropped fantasy participant "${p}" in scene "${(aiScene.title || '').slice(0, 40)}" — not a hero of the book`),
            onReplace: (from, to) => console.warn(`[LAZY-BOOK] Participant "${from}" → canonical id "${to}" in scene "${(aiScene.title || '').slice(0, 40)}"`),
        }
        );
        for (const p of sceneParticipants) {
            if (!allParticipants.includes(p)) allParticipants.push(p);
        }

        // Supplement participants from unit visual prompts (they contain character_ids)
        // Always run this — the AI may return partial characters_present, and visual
        // prompts often reference characters the scene-step AI forgot to list.
        if (mergedCharacters.length > 0) {
            const visualPrompts = (aiScene.units || [])
                .map(u => u.image?.prompt || '')
                .filter(Boolean)
                .join(' ')
                .toLowerCase();

            if (visualPrompts.length > 0) {
                const before = allParticipants.length;
                for (const ch of mergedCharacters) {
                    const chId = (ch.id || '').toLowerCase();
                    if (!chId || chId.length < 3) continue;
                    // Token-based matching: split character ID by underscores,
                    // check if ALL meaningful tokens appear in the visual prompts.
                    // This handles cases where visual prompts use longer IDs
                    // (e.g. "mikhail_alexandrovich_berlioz") while characters.json
                    // has a shorter ID (e.g. "mikhail_berlioz").
                    // This is safe because character IDs are unique identifiers,
                    // not common words — false positives are extremely unlikely.
                    const tokens = chId.split('_').filter(t => t.length >= 3);
                    if (tokens.length === 0) continue;
                    const allTokensFound = tokens.every(t => visualPrompts.includes(t));
                    if (allTokensFound) {
                        if (!allParticipants.includes(ch.id)) allParticipants.push(ch.id);
                    }
                }
                if (allParticipants.length > before) {
                    console.log(`[LAZY-BOOK] Visual prompts added ${allParticipants.length - before} more participants for scene "${(aiScene.title || '').slice(0, 40)}"`);
                }
            }
        }

        // unit.participants removed — participants come from scene-level only

        const sceneStyle = aiScene.type === 'chapter_intro' || cleanUnits.some(u => u.type === 'typography')
            ? 'soviet_book_page'
            : undefined;

        // Build audio config based on scene type.
        // For dialogue scenes: voice='dialogue', full_text=original literary text (with —).
        // The TTS script (speaker:text) is built at generation time by buildSegments()
        // from units that have type='dialogue' and speaker field.
        // For narration scenes: voice='narrator', full_text=raw scene text.
        const hasDialogueWithSpeaker = isDialogue && cleanUnits.some(u => u.type === 'dialogue' && u.audio?.speaker);
        if (hasDialogueWithSpeaker) {
            audioConfig = {
                voice: 'dialogue',
                full_text: sceneText,
            };
            const dialogueCount = cleanUnits.filter(u => u.type === 'dialogue').length;
            const withSpeakerCount = cleanUnits.filter(u => u.type === 'dialogue' && u.audio?.speaker).length;
            if (withSpeakerCount < dialogueCount) {
                console.warn(`[LAZY-BOOK] Scene "${aiScene.title}": ${dialogueCount - withSpeakerCount}/${dialogueCount} dialogue units missing speaker`);
            }
        } else if (isDialogue) {
            console.warn(`[LAZY-BOOK] Scene "${aiScene.title}" marked as dialogue but has no units with speaker — falling back to narrator voice`);
            audioConfig = {
                voice: 'narrator',
                full_text: sceneText,
            };
        } else {
            audioConfig = {
                voice: 'narrator',
                full_text: sceneText,
            };
        }

        chapterObj.scenes.push({
            scene_id: scId,
            scene_title: aiScene.title || chapterUtils.extractSceneTitle(aiScene.text || '', chapterObj.scenes.length),
            type: isDialogue ? 'dialogue' : 'narration',
            style: sceneStyle,
            participants: allParticipants,
            location: (() => {
                if (!aiScene.location) return undefined;
                if (!aiScene.location.id) return aiScene.location;
                return { ...aiScene.location, id: canonicalizeMixedScriptId(aiScene.location.id) };
            })(),
            // scene.look_patch[hero_id] — one-scene replacement of look fields
            // (§4a.4), e.g. video_tokens chosen by the passport-reconciliation
            // agent. scene.passport does not exist in VBook 4: until that agent
            // writes look_patch itself (step 2) its `passport` output is read as
            // one. Must be passed through explicitly — the scene constructor
            // does not copy unknown fields.
            look_patch: sanitizeLookPatch(aiScene.look_patch || aiScene.passport, describedIds),
            source_start: aiScene.source_start ?? null,
            source_end: aiScene.source_end ?? null,
            audio: audioConfig,
            units: cleanUnits,
        });
    }

    if (chapterObj.scenes.length === 0) {
        throw new Error('No valid scenes created from AI analysis');
    }

    fs.writeFileSync(path.join(chDir, chFile), JSON.stringify(chapterObj, null, 2));

    // chapters_order must reflect the READING order (cover, prologue index 0,
    // chapters 1..N), NOT the filename order — hex chapter IDs are random.
    // Sort by chapter_index: cover first (no index), then by index ascending.
    const chapterSortKey = (f) => {
        try {
            const ch = JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8'));
            if (ch.type === 'cover') return -1;
            return ch.chapter_index ?? Number.MAX_SAFE_INTEGER;
        } catch (_) { return Number.MAX_SAFE_INTEGER; }
    };
    const existingFiles = fs.readdirSync(chDir).filter(f => f.endsWith('.json'))
        .sort((a, b) => chapterSortKey(a) - chapterSortKey(b));
    bookMeta.structure.chapters_order = existingFiles;
    // Display-order hint (§3): the cast as it is on disk now, in registry order.
    const castOnDisk = characterStore.listCharacters(bookDir, {
        charactersOrder: [NARRATOR_ID, ...mergedCharacters.map(c => c.id)],
    });
    bookMeta.structure.characters_order = castOnDisk.heroes.map(h => h.id);
    fs.writeFileSync(getBookMetaPath(bookDir), JSON.stringify(bookMeta, null, 2));

    const bookState = isFirstWindow ? BookState.BOOTSTRAPPED : BookState.BOOTSTRAPPED;
    draft.updateBookState(bookId, bookState);

    console.log(`[LAZY-BOOK] ${isFirstWindow ? 'Created' : 'Appended'} ${bookId}: ${mergedCharacters.length} chars, ${Object.keys(locations).length} locs, ${chapterObj.scenes.length} scenes (window, chIndex=${chapterIndex})`);

    return {
        bookId,
        state: bookState,
        title: bookMeta.title,
        author: bookMeta.author,
        language,
        characters: mergedCharacters.length,
        heroes: castOnDisk.heroes.length,
        skippedHeroes,
        locations: Object.keys(locations).length,
        chapter: chapterObj,
        scenes: chapterObj.scenes.length,
    };
}

module.exports = {
    createFromAnalysis,
    appendToBook,
    createOrAppendScenes,
};
