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
const { voiceFromAnalysis } = require('../voice');
const { assignHeroIds, mergeAliases } = require('../hero-id.cjs');
const { aliasAdditions, mergeWindowIntoHero } = require('../hero-analysis.cjs');
const characterStore = require('../character-store.cjs');
const { CHARACTER_SCHEMA } = require('../character-validator.cjs');
const { passportHeroes, NARRATOR_ID } = require('../heroes.cjs');
const { LOOK_FIELDS, resolveHeroLook } = require('../looks.cjs');

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

function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
    }
    return a === b;
}

// A look_patch is written only where it CHANGES something: a field equal to
// what the hero already looks like in this scene (base passport ← chapter look
// ← scene look, resolved by resolveHeroLook) is dropped. So a reconciliation
// pass that confirms the current tokens leaves no trace in the chapter file.
function pruneLookPatch(patch, book, chapter, scene) {
    if (!patch) return undefined;
    const out = {};
    for (const [heroId, fields] of Object.entries(patch)) {
        const resolved = resolveHeroLook(book, chapter, { looks: scene && scene.looks }, heroId);
        if (!resolved) continue;
        const kept = {};
        for (const [field, value] of Object.entries(fields)) {
            if (!sameValue(value, resolved[field])) kept[field] = value;
        }
        if (Object.keys(kept).length > 0) out[heroId] = kept;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function remapKeys(map, idMap) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return map;
    const out = {};
    for (const [key, value] of Object.entries(map)) out[idMap.has(key) ? idMap.get(key) : key] = value;
    return out;
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

    {
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
    }
    if (!isFirstWindow) {
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

    // ── Heroes of this window ──────────────────────────────────────────────
    // `cast` — every hero file of the book (the narrator and voice-only heroes
    // too); `mergedCharacters` — the character registry (heroes with a
    // passport) plus the heroes this window adds.
    const cast = Array.isArray(d.heroes) ? d.heroes : [];
    const castIds = cast.map(h => h.id);
    const mergedCharacters = [...existingCharacters];
    const newHeroes = [];
    const skippedHeroes = [];
    // What this window may ADD to heroes that already exist (never replace).
    const additions = new Map(); // hero id → { aliases: [], voice, passport }
    const additionFor = (id) => {
        if (!additions.has(id)) additions.set(id, { aliases: [], voice: null, passport: null });
        return additions.get(id);
    };
    // Every id the model used → the final hero id (participants, speakers,
    // look_patch and mentions of this window are rewritten through it).
    const heroIdMap = new Map();

    const buildPassport = (ch) => {
        // The AGENT (ai/rules/characters.md) is responsible for separating the
        // physical appearance from the clothes. The program ONLY validates the
        // agent's output and fills safe defaults — it never re-splits text with
        // heuristics, so appearance and clothes never overlap or get mangled.
        const appearanceDesc = ch.appearance || ch.description;
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
        // reconciliation step (stage 2), which writes scene.look_patch.
        let videoTokens = appearance.sanitizeVideoTokens(ch.video_tokens);
        if (!videoTokens) {
            const frag = appearance.fragmentAppearanceForVideo(
                clothes ? `${appearanceDesc}, ${clothes}` : appearanceDesc,
                ch.name
            );
            videoTokens = frag ? [frag] : [];
        }
        return {
            appearance: appearanceDesc,
            clothes,
            video_tokens: videoTokens.length > 0
                ? videoTokens
                : [`${String(ch.name || '').toLowerCase()} character, period clothing, distinctive appearance`],
        };
    };
    const hasDescribedAppearance = (ch) => {
        const raw = ch.appearance || ch.description || null;
        return !!raw && !/не опис|no descr|unknown|unclear/i.test(raw);
    };

    // Chimera id (mixed-script / wrong transliteration / typo / noise suffix)
    // that CONFIDENTLY matches a hero of the book → aligned to that id before
    // anything else; never a duplicate key for the same person. Registry-write
    // path: NO fuzzy tier (fuzzy:false) — a wrong fuzzy merge here would DROP a
    // genuinely distinct character.
    const candidates = (analysis.characters || [])
        .filter(ch => ch && typeof ch === 'object' && (ch.id || ch.name))
        .map((ch) => {
            const rawId = typeof ch.id === 'string' ? ch.id : '';
            let id = rawId;
            if (rawId) {
                const mixed = canonicalizeMixedScriptId(rawId);
                const canonical = findCanonicalId(mixed, castIds, { fuzzy: false });
                if (canonical && canonical.toLowerCase() !== mixed.toLowerCase()) {
                    console.warn(`[LAZY-BOOK] Character id "${mixed}" canonicalized to "${canonical}"`);
                }
                id = canonical || mixed;
            }
            return { ...ch, id, rawId };
        });

    // Canonical ids (VBOOK_FORMAT_V4 §12, step 2): transliteration, snake_case,
    // ≤ 64; a hero of the book matched by id / name / alias keeps its id;
    // collisions and reserved ids get _2, _3 … in the order of the window.
    const idPlan = assignHeroIds(candidates, cast);
    for (const s of idPlan.skipped) {
        console.warn(`[LAZY-BOOK] Skipping character without a usable id or name (${JSON.stringify(s.rawId || s.candidate.name || '')})`);
        skippedHeroes.push({ id: s.rawId || null, name: s.candidate.name || null, reason: s.reason });
    }

    for (const plan of idPlan.assignments) {
        const ch = plan.candidate;
        const charId = plan.id;
        const noteId = (finalId) => {
            for (const used of [ch.rawId, ch.id]) {
                if (used && used !== finalId && !heroIdMap.has(used)) heroIdMap.set(used, finalId);
            }
        };
        if (plan.reason === 'new_suffix' || plan.reason === 'new_reserved') {
            console.warn(`[LAZY-BOOK] Hero id for "${ch.name || ch.rawId}" → "${charId}" (${plan.reason === 'new_reserved' ? 'reserved id' : 'id already taken by another hero'})`);
        }
        const voiceResult = voiceFromAnalysis(ch.voice);
        if (!voiceResult.voice && voiceResult.reason && voiceResult.reason !== 'empty') {
            console.warn(`[LAZY-BOOK] Voice of "${charId}" not taken from the analysis: ${voiceResult.reason}`);
        }

        // A hero that already has a file: this window only ADDS what is missing.
        if (plan.existing) {
            noteId(charId);
            const add = additionFor(charId);
            add.aliases.push(ch.name, ...plan.aliases);
            if (voiceResult.voice && !add.voice) add.voice = voiceResult.voice;
            if (!add.passport && hasDescribedAppearance(ch) && hasRealAppearance({ ...ch, id: charId })) add.passport = buildPassport(ch);
            continue;
        }

        // Placeholder ids/names ('unknown', 'unnamed', 'Unidentified', …) are
        // NEVER real characters — absence of information ≠ a fictitious
        // 'unknown' character. Dropped at the write barrier so it can never
        // become a hero file or enter scene.participants.
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
        // Skip here so no id/name/voice/passport is invented for them.
        // (The agent may still extract one — this guard enforces the rule.)
        if (!hasDescribedAppearance(ch)) {
            console.warn(`[LAZY-BOOK] Skipping character without described appearance: ${charId} — not a character`);
            continue;
        }
        // "The same person under another name?" is judged by what the model
        // said about the character. An id this function had to invent (a
        // suffix for a taken or reserved id) says nothing about identity and
        // must not take part: "yura_2" would look like an alias of "yura".
        const identityId = (plan.reason === 'new_suffix' || plan.reason === 'new_reserved') ? undefined : charId;
        const canonical = findCanonicalCharacter({ ...ch, id: identityId }, mergedCharacters);
        if (canonical) {
            // The same person under another name: the spelling becomes an alias.
            console.log(`[LAZY-BOOK] Merged character alias ${charId} -> ${canonical.id}`);
            heroIdMap.set(charId, canonical.id);
            noteId(canonical.id);
            const add = additionFor(canonical.id);
            add.aliases.push(ch.name, ...plan.aliases);
            if (voiceResult.voice && !add.voice) add.voice = voiceResult.voice;
            continue;
        }

        noteId(charId);
        const hero = {
            schema: CHARACTER_SCHEMA,
            id: charId,
            name: ch.name || charId,
            role: ch.role || 'minor',
            ...(plan.aliases.length > 0 ? { aliases: plan.aliases } : {}),
            passport: buildPassport(ch),
            ...(voiceResult.voice ? { voice: voiceResult.voice } : {}),
        };
        mergedCharacters.push(hero);
        newHeroes.push(hero);
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

    // ── Aliases from the mentions of this window (§7) ──
    // mentions.json does not exist in VBook 4: the way the author calls a hero
    // lives in the hero file. Chimera barrier first — the target must be a hero
    // (or confidently canonicalize to one); a mention of a non-hero ("natural
    // designation") is not written anywhere in the book, it stays in PG.
    const heroesAfterWindow = [...cast.filter(h => !newHeroes.some(n => n.id === h.id)), ...newHeroes];
    const heroIdsAfterWindow = new Set(heroesAfterWindow.map(h => h.id));
    const resolvedMentions = {};
    if (analysis.mentions && typeof analysis.mentions === 'object') {
        for (const [alias, rawTarget] of Object.entries(analysis.mentions)) {
            let target = String(rawTarget);
            if (heroIdMap.has(target)) target = heroIdMap.get(target);
            if (!heroIdsAfterWindow.has(target)) {
                const canonical = findCanonicalId(target, heroIdsAfterWindow);
                if (canonical) {
                    console.warn(`[LAZY-BOOK] Mention "${alias}" → ${target} canonicalized to ${canonical}`);
                    target = canonical;
                } else if (isFantasySnakeToken(target, heroIdsAfterWindow)) {
                    console.warn(`[LAZY-BOOK] Dropping mention "${alias}" → ${target} — no such hero in the book`);
                    continue;
                }
            }
            resolvedMentions[alias] = target;
        }
    }
    // The spellings merged above count as aliases already claimed, so a
    // mention never duplicates or contradicts them.
    const pendingView = heroesAfterWindow.map((h) => (additions.has(h.id)
        ? { ...h, aliases: mergeAliases(h.name, h.aliases, additions.get(h.id).aliases) }
        : h));
    const aliasPlan = aliasAdditions(pendingView, resolvedMentions);
    for (const r of aliasPlan.rejected) {
        if (r.reason === 'ambiguous_alias') console.warn(`[LAZY-BOOK] Alias "${r.alias}" → ${r.target} not written: it already names another hero`);
    }
    let aliasesAdded = 0;
    for (const [heroId, list] of aliasPlan.additions) {
        const fresh = newHeroes.find(h => h.id === heroId);
        if (fresh) {
            const merged = mergeAliases(fresh.name, fresh.aliases, list);
            aliasesAdded += merged.length - (fresh.aliases ? fresh.aliases.length : 0);
            if (merged.length > 0) fresh.aliases = merged;
        } else {
            additionFor(heroId).aliases.push(...list);
        }
    }

    // ── Heroes → characters/<id>.json, through the character store ──
    // Only a character with a real appearance OR real clothes becomes a hero
    // with a passport (shared predicate — looks at the whole aggregate, not at
    // the name alone). A dialogue-only participant without a described
    // appearance is NOT a character: it gets no file and no voice; the audio
    // pipeline voices such speakers with the narrator.
    const describedIds = new Set(mergedCharacters.filter(c => hasRealAppearance(c)).map(c => c.id));
    for (const hero of newHeroes) {
        if (!describedIds.has(hero.id)) continue;
        try {
            characterStore.writeCharacter(bookDir, hero);
        } catch (err) {
            // A broken file under this id (§10.3) or an invalid hero: never
            // overwritten, never fatal for the window.
            console.warn(`[LAZY-BOOK] Hero "${hero.id}" not written: ${err.message}`);
            skippedHeroes.push({ id: hero.id, name: hero.name || null, reason: err.code || 'write_failed' });
            describedIds.delete(hero.id);
        }
    }
    // A hero that already exists is never rewritten by a later window: it only
    // gains what it lacked — new aliases, a voice where there was none, a
    // passport for a voice-only hero. A voice a person edited (timbre_source
    // 'user') or one with a locked reference is not touched; looks never are.
    const updatedHeroes = [];
    for (const [heroId, add] of additions) {
        const current = cast.find(h => h.id === heroId);
        if (!current || mergeWindowIntoHero(current, add) === current) continue;
        try {
            const before = characterStore.serializeCharacter(current);
            const next = characterStore.updateCharacter(bookDir, heroId, (onDisk) => mergeWindowIntoHero(onDisk, add));
            if (next && characterStore.serializeCharacter(next) !== before) {
                updatedHeroes.push(heroId);
                aliasesAdded += (next.aliases ? next.aliases.length : 0) - (current.aliases ? current.aliases.length : 0);
                if (next.passport) describedIds.add(heroId);
            }
        } catch (err) {
            console.warn(`[LAZY-BOOK] Hero "${heroId}" not updated: ${err.message}`);
        }
    }
    if (describedIds.size < mergedCharacters.length) {
        console.log(`[LAZY-BOOK] Filtered characters: ${describedIds.size} with passport out of ${mergedCharacters.length} total`);
    }

    // The cast as it is on disk now — what scenes of this window are resolved against.
    const bookAfterWindow = { heroes: characterStore.listCharacters(bookDir).heroes };
    const heroId = (value) => (typeof value === 'string' && heroIdMap.has(value) ? heroIdMap.get(value) : value);

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
                // a speaker written with the model's own id → the hero's final id
                audio: (u.audio && typeof u.audio === 'object' && typeof u.audio.speaker === 'string' && heroIdMap.has(u.audio.speaker))
                    ? { ...u.audio, speaker: heroIdMap.get(u.audio.speaker) }
                    : (u.audio || undefined),
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
        const rawParticipants = aiScene.characters_present || aiScene.participants || [];
        const sceneParticipants = sanitizeParticipants(
            Array.isArray(rawParticipants) ? rawParticipants.map(heroId) : rawParticipants,
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
            // agent. Written only where it differs from the look the hero
            // already has in this scene (resolveHeroLook: passport ← chapter
            // look); `passport` is accepted as the pre-v4 name of the same data.
            // Must be passed through explicitly — the scene constructor does
            // not copy unknown fields.
            look_patch: pruneLookPatch(
                sanitizeLookPatch(remapKeys(aiScene.look_patch || aiScene.passport, heroIdMap), describedIds),
                bookAfterWindow, chapterObj, aiScene,
            ),
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
        newHeroes: newHeroes.filter(h => describedIds.has(h.id)).map(h => h.id),
        updatedHeroes,
        aliasesAdded,
        heroIdMap: Object.fromEntries(heroIdMap),
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
