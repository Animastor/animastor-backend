#!/usr/bin/env node
// Audit video.action / image.prompt for continuity violations in a generated book.
// Usage: node scripts/audit-video-actions.js <bookId>
//
// Word-boundary matching: pronouns and group nouns are matched as WHOLE WORDS
// ("\bhe\b"), so "the alley" never triggers "he" and "heat" never triggers "she".
//
// Checks:
//   1. FAIL — invented snake_case ids that are NOT in the book's character list
//      (context poisoning: agent copied an id from rules/examples, e.g.
//      "zhenshchina_v_budochke").
//   2. WARN — generic group nouns ("the two men", "both characters", "the men")
//      in video.action when the scene has participants but no character_id is used.
//   3. WARN — display-name possessive forms ("Mikhail's glasses") instead of the id.
//   4. INFO — standalone pronouns (he/she/his/her/they/them) with participants in
//      the scene but no character_id in the action (may be legit for extras).
//   5. WARN — cross-prompt (HARD, asymmetric): video.action names participants
//      by id but image.prompt replaces them with a generic term ("two citizens")
//      — video IDs ⊆ image IDs is a hard rule.
//      INFO — cross-prompt (SOFT): image.prompt shows participants that
//      video.action doesn't name — normal when only a subset moves.
//
//   6. VBook 4 (step 3): the cast is characters/<id>.json — FAIL for a broken
//      hero file (it is not part of the cast), WARN for an alias two heroes
//      claim (it names nobody: buildAliasIndex). The 3.1 files characters.json /
//      mentions.json are not read.
//
// Exit code 0 when no FAIL/WARN; 1 otherwise.

const path = require('path');
const fs = require('fs');
const { findCanonicalId, snakeTokensInText, KNOWN_NON_CHARACTER_SNAKE, hasMixedScript, GROUP_NOUNS, PRONOUNS, findCrossPromptGaps } = require('../src/utils/snake-guard');
const { listCharacters } = require('@animastor/vbook-runtime/character-store.cjs');
const { buildAliasIndex } = require('@animastor/vbook-runtime/heroes.cjs');

const BOOKS_DIR = process.env.BOOKS_DIR || '/data/books';
const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

function wordRegex(word) {
    return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

// ── Word-boundary matching only ──────────────────────────────────────
// Group nouns / pronouns now come from src/utils/snake-guard.js — the SAME
// source of truth used by the pipeline cross-prompt consistency check
// (stepPolishStoryboard / stepPolishVideoActions). Keep the lists there.
// (anchorGroupRefs in src/workflows/video/video-workflows.js still holds its own
// smaller deterministic-repair list for build-time action anchoring.)

function hasWord(text, word) {
    return wordRegex(word).test(text);
}

function hasAnyWord(text, words) {
    return words.some(w => hasWord(text, w));
}

// Snake_case token detection lives in src/utils/snake-guard.js — the SAME source
// of truth used by the pipeline repair step (stepRepairFantasyIds) and the
// lazy-book write barrier. Keeps audit and pipeline in lockstep.

function loadBook(bookId, booksDir = BOOKS_DIR) {
    const dir = path.join(booksDir, bookId);
    if (!fs.existsSync(dir)) {
        throw Object.assign(new Error(`Book ${bookId} not found at ${dir}`), { code: 'not_found' });
    }
    // VBook 4: one file per hero (characters/<id>.json); broken files are issues
    const cast = listCharacters(dir);
    const heroes = cast.heroes;
    const heroIssues = cast.issues.filter((i) => i.blocking);
    const locations = fs.existsSync(path.join(dir, 'locations.json'))
        ? JSON.parse(fs.readFileSync(path.join(dir, 'locations.json'), 'utf8'))
        : {};
    const charIds = new Set(heroes.map(c => c.id).filter(Boolean));
    const locIds = new Set(Object.keys(locations || {}));
    // Display-name words ("Mikhail", "Berlioz") for possessive detection
    const nameWords = new Set();
    for (const c of heroes) {
        const name = (c.name || c.id || '').replace(/\(.*?\)/g, ' ').split(/[\s,.;!?]+/);
        for (const w of name) {
            const norm = w.toLowerCase();
            if (norm.length >= 3 && !charIds.has(norm)) nameWords.add(norm);
        }
    }

    const chapters = [];
    const chDir = path.join(dir, 'chapters');
    if (fs.existsSync(chDir)) {
        for (const f of fs.readdirSync(chDir).filter(f => f.endsWith('.json')).sort()) {
            chapters.push(JSON.parse(fs.readFileSync(path.join(chDir, f), 'utf8')));
        }
    }
    return { bookId, dir, heroes, heroIssues, charIds, locIds, nameWords, chapters };
}

function auditUnit(unit, scene, ctx) {
    const findings = [];
    const action = (unit.video && unit.video.action) || '';
    const prompt = (unit.image && unit.image.prompt) || '';
    const participants = scene.participants || [];
    const where = `${scene.scene_id} ${unit.id}`;
    const hasCharId = ctx.charIds.size > 0 && [...ctx.charIds].some(id =>
        wordRegex(id).test(action) || wordRegex(id).test(prompt));

    // 1. Invented / chimera snake_case ids — shared snake-guard (one source of
    // truth with the pipeline repair step and the write barrier).
    //    INVENTED — no confident relation to the registry (context poisoning).
    //    CHIMERA  — confidently matches a known id but differs by script/typo/
    //               transliteration ("mikhail_berлиоз" → "mikhail_berlioz").
    const knownIds = [...ctx.charIds, ...ctx.locIds];
    for (const field of [['video.action', action], ['image.prompt', prompt]]) {
        const [label, text] = field;
        if (!text) continue;
        for (const token of snakeTokensInText(text)) {
            const low = token.toLowerCase();
            if (ctx.charIds.has(low) || ctx.locIds.has(low)) continue;        // exact valid id
            if (KNOWN_NON_CHARACTER_SNAKE.has(low)) continue;                 // technical/object word
            const canonical = findCanonicalId(token, knownIds);
            if (canonical && canonical.toLowerCase() !== low) {
                findings.push({ level: 'FAIL', where, msg: `CHIMERA id "${token}" in ${label} -> should be "${canonical}" (script/transliteration variant)` });
            } else if (!canonical) {
                findings.push({ level: 'FAIL', where, msg: `INVENTED id "${token}" in ${label} (not in character list)` });
            }
        }
    }

    // 2. Generic group nouns when participants exist but no id used
    if (participants.length > 0 && !hasCharId) {
        const hit = GROUP_NOUNS.find(w => hasWord(action, w));
        if (hit) {
            findings.push({ level: 'WARN', where, msg: `generic group noun "${hit}" in video.action, participants=${participants.join(',')}, no character_id` });
        }
    }

    // 3. Display-name possessive forms without an id
    if (ctx.nameWords.size > 0 && !hasCharId) {
        for (const w of ctx.nameWords) {
            if (hasWord(action, `${w}'s`)) {
                findings.push({ level: 'WARN', where, msg: `display-name possessive "${w}'s" in video.action (should be character_id's)` });
                break;
            }
        }
    }

    // 4. Standalone pronouns (info — may be legit for extras)
    if (participants.length > 0 && !hasCharId) {
        const hit = PRONOUNS.find(w => hasWord(action, w));
        if (hit) {
            findings.push({ level: 'INFO', where, msg: `pronoun "${hit}" in video.action, participants=${participants.join(',')}, no character_id` });
        }
    }

    // 5. Cross-prompt consistency — ASYMMETRIC (same detector as the polish
    //    steps). HARD: video.action names mikhail_berlioz + ivan_ponyrev but
    //    image.prompt says "two citizens" → WARN (image.prompt must be fixed).
    //    SOFT: image.prompt shows ids that video.action doesn't animate → INFO
    //    only — a video may animate a subset of the frame.
    for (const gap of findCrossPromptGaps(unit, participants, ctx.charIds)) {
        if (gap.severity === 'hard') {
            const genericPart = gap.generic_terms.length > 0
                ? `generic "${gap.generic_terms.join(', ')}" instead of ids`
                : 'omits ids';
            findings.push({
                level: 'WARN',
                where,
                msg: `CROSS-PROMPT image.prompt: ${genericPart} [${gap.missing_ids.join(', ')}] (named in video.action)`,
            });
        } else {
            findings.push({
                level: 'INFO',
                where,
                msg: `CROSS-PROMPT (soft, not an error) video.action: doesn't name ids [${gap.missing_ids.join(', ')}] that image.prompt shows — ok if only a subset moves`,
            });
        }
    }

    return findings;
}

/** Every finding of a book: { unitsSeen, findings: [{level, where, msg}] }. */
function auditBook(ctx) {
    const all = [];
    let unitsSeen = 0;
    for (const ch of ctx.chapters) {
        for (const sc of ch.scenes || []) {
            for (const u of sc.units || []) {
                unitsSeen++;
                all.push(...auditUnit(u, sc, ctx));
            }
        }
    }

    // Mixed-script registry ids ("patriarshie_pруды") — the chimera class in the
    // registries themselves. The write barrier normalizes them on creation, so
    // a surviving one means the fix did not run.
    for (const id of ctx.charIds) {
        if (hasMixedScript(id)) all.push({ level: 'FAIL', where: `characters/${id}.json`, msg: `mixed-script (latin+cyrillic) id "${id}" — should be normalized` });
    }
    for (const id of ctx.locIds) {
        if (hasMixedScript(id)) all.push({ level: 'FAIL', where: 'locations.json', msg: `mixed-script (latin+cyrillic) id "${id}" — should be normalized` });
    }

    // VBook 4: a broken hero file is not part of the cast; an alias two heroes
    // claim names nobody (VBOOK_FORMAT_V4 §7, buildAliasIndex).
    for (const issue of ctx.heroIssues || []) {
        all.push({ level: 'FAIL', where: issue.file, msg: `broken hero file (${issue.code}): ${issue.message}` });
    }
    for (const alias of buildAliasIndex(ctx.heroes || []).ambiguous) {
        all.push({ level: 'WARN', where: 'characters/*.json', msg: `ambiguous alias "${alias}" — claimed by more than one hero, names nobody` });
    }

    return { unitsSeen, findings: all };
}

function main() {
    const targetBookId = process.argv[2];
    if (!targetBookId) {
        console.error('Usage: node scripts/audit-video-actions.js <bookId>');
        process.exit(1);
    }

    let ctx;
    try {
        ctx = loadBook(targetBookId);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    console.log(`\n## ${ctx.bookId}`);
    console.log(`Characters: ${[...ctx.charIds].join(', ') || '(none)'}`);

    const { unitsSeen, findings: all } = auditBook(ctx);

    const byLevel = { FAIL: [], WARN: [], INFO: [] };
    for (const f of all) byLevel[f.level].push(f);

    for (const f of byLevel.FAIL) console.log(`${FAIL} ${f.where}: ${f.msg}`);
    for (const f of byLevel.WARN) console.log(`${WARN} ${f.where}: ${f.msg}`);
    for (const f of byLevel.INFO) console.log(`  i ${f.where}: ${f.msg}`);

    console.log(`\n  ${unitsSeen} units checked — FAIL: ${byLevel.FAIL.length}, WARN: ${byLevel.WARN.length}, INFO: ${byLevel.INFO.length}`);
    if (byLevel.FAIL.length === 0 && byLevel.WARN.length === 0) {
        console.log(`${PASS} No violations`);
    }
    process.exit(byLevel.FAIL.length + byLevel.WARN.length > 0 ? 1 : 0);
}

module.exports = { loadBook, auditUnit, auditBook };

if (require.main === module) main();
