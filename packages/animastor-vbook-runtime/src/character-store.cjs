// ======================================================
// character-store — characters/ on disk (VBOOK_FORMAT_V4 §3, §4)
// ======================================================
// One file per hero: <bookDir>/characters/<id>.json. The directory is the
// source of truth for the cast; book.json's characters_order is only a display
// hint. Writes go through a temp file in the same directory and an atomic
// rename, so a crash between write and rename leaves the previous file intact
// and concurrent single-hero writes touch different files.
//
// A broken hero file never hides the rest of the book: listing returns the
// good heroes plus `issues` (§10.3), and the caller decides whether to open
// the book, refuse a write or skip the file.

'use strict';

const fs = require('fs');
const path = require('path');
const { isCanonicalHeroId, NARRATOR_ID, RESERVED_HERO_IDS } = require('./heroes.cjs');

const CHARACTER_DIR = 'characters';
const TMP_SUFFIX = '.tmp';

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function charactersDir(bookDir) {
    return path.join(bookDir, CHARACTER_DIR);
}

function characterFile(bookDir, heroId) {
    if (!isCanonicalHeroId(heroId)) {
        throw new Error(`vbook: invalid hero id ${JSON.stringify(heroId)}`);
    }
    return path.join(charactersDir(bookDir), `${heroId}.json`);
}

function atomicWriteJson(file, value, io = fs) {
    const dir = path.dirname(file);
    io.mkdirSync(dir, { recursive: true });
    const tmp = path.join(
        dir,
        `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}${TMP_SUFFIX}`,
    );
    try {
        io.writeFileSync(tmp, JSON.stringify(value, null, 2));
        io.renameSync(tmp, file);
    } catch (err) {
        try { io.unlinkSync(tmp); } catch (_) { /* already renamed or never written */ }
        throw err;
    }
}

function checkHeroFile(file, hero) {
    const expectedId = path.basename(file, '.json');
    if (!isPlainObject(hero)) {
        return { file, code: 'invalid_character', message: 'character file must contain a JSON object' };
    }
    if (hero.id !== expectedId) {
        return {
            file,
            id: typeof hero.id === 'string' ? hero.id : null,
            code: 'id_mismatch',
            message: `file name says "${expectedId}", inner id is ${JSON.stringify(hero.id)}`,
        };
    }
    return null;
}

function loadHeroFile(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const hero = JSON.parse(raw);
    const issue = checkHeroFile(file, hero);
    return { hero, issue };
}

function listCharacters(bookDir, options = {}) {
    const dir = charactersDir(bookDir);
    const heroes = [];
    const issues = [];
    if (!fs.existsSync(dir)) return { heroes, issues };

    const names = fs.readdirSync(dir)
        .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
        .sort();

    for (const name of names) {
        const file = path.join(dir, name);
        try {
            const { hero, issue } = loadHeroFile(file);
            if (issue) issues.push(issue);
            else heroes.push(hero);
        } catch (err) {
            issues.push({ file, code: 'invalid_json', message: err.message });
        }
    }

    const order = Array.isArray(options.charactersOrder) ? options.charactersOrder : [];
    const rank = new Map(order.map((id, i) => [id, i]));
    heroes.sort((a, b) => {
        if (a.id === NARRATOR_ID) return -1;
        if (b.id === NARRATOR_ID) return 1;
        const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
        const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
        if (ra !== rb) return ra - rb;
        return a.id.localeCompare(b.id);
    });

    return { heroes, issues };
}

function readCharacter(bookDir, heroId) {
    const file = characterFile(bookDir, heroId);
    if (!fs.existsSync(file)) return null;
    try {
        return loadHeroFile(file).hero;
    } catch (_) {
        return null;
    }
}

function writeCharacter(bookDir, hero, io = fs) {
    if (!isPlainObject(hero)) throw new Error('vbook: character must be a JSON object');
    if (!isCanonicalHeroId(hero.id)) {
        throw new Error(`vbook: invalid hero id ${JSON.stringify(hero.id)}`);
    }
    if (RESERVED_HERO_IDS.includes(hero.id)) {
        throw new Error(`vbook: hero id "${hero.id}" is reserved`);
    }
    const file = characterFile(bookDir, hero.id);
    atomicWriteJson(file, hero, io);
    return hero;
}

// Read → mutate → atomic write. The mutator receives the current hero and may
// return a replacement; the id cannot change.
function updateCharacter(bookDir, heroId, mutate) {
    const current = readCharacter(bookDir, heroId);
    if (!current) return null;
    const next = mutate ? mutate(current) : current;
    if (!isPlainObject(next)) throw new Error('vbook: updateCharacter mutator must return an object');
    if (next.id !== heroId) throw new Error('vbook: updateCharacter cannot change the hero id');
    writeCharacter(bookDir, next);
    return next;
}

function removeCharacter(bookDir, heroId) {
    const file = characterFile(bookDir, heroId);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
}

module.exports = {
    CHARACTER_DIR,
    charactersDir,
    characterFile,
    atomicWriteJson,
    listCharacters,
    readCharacter,
    writeCharacter,
    updateCharacter,
    removeCharacter,
};
