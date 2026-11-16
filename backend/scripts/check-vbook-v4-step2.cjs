#!/usr/bin/env node
// ======================================================
// Приёмка 2.6 шага 2 VBook 4 (VBOOK_FORMAT_V4 §12) — проверка готовой книги
// ======================================================
// Скрипт НЕ вызывает LLM и ничего не пишет. Он читает каталог книги, которую
// анализ уже построил (два окна), и сверяет её с эталоном:
//
//   1. книга — VBook 4, файлов 3.1 нет, проблем в файлах героев нет;
//   2. id каждого героя канонический;
//   3. каждый герой эталона найден (по name / aliases / id);
//   4. ложных слияний нет: два героя эталона не оказались одним героем книги,
//      и ни один алиас не объявлен двумя героями;
//   5. у говорящих героев эталона и у диктора заполнены timbre и manner
//      (manner может быть пустым только с флагом --allow-empty-manner),
//      поля instruction нет ни у кого.
//
// Запуск:
//   node backend/scripts/check-vbook-v4-step2.cjs <каталог книги> [эталон.json] [--allow-empty-manner] [--json]
// Код выхода: 0 — приёмка пройдена, 1 — нет, 2 — книгу не удалось прочитать.

'use strict';

const fs = require('fs');
const path = require('path');

const book = require('@animastor/vbook-runtime');
const { configureBooksRoot } = require('@animastor/vbook-runtime/books-root');
const { normalizeForMatch } = require('@animastor/vbook-runtime/character-identity');
const { isValidHeroId, buildAliasIndex, passportHeroes } = require('@animastor/vbook-runtime/heroes.cjs');

const DEFAULT_BASELINE = path.join(__dirname, '..', 'tests', 'fixtures', 'vbook-v4', 'mim-baseline.json');
const LEGACY_FILES = ['characters.json', 'voices.json', 'behavior.json', 'mentions.json'];

const text = (v) => (typeof v === 'string' ? v.trim() : '');

function heroTexts(hero) {
    return [hero.id, hero.name, ...(Array.isArray(hero.aliases) ? hero.aliases : [])]
        .filter((v) => typeof v === 'string' && v)
        .map((v) => normalizeForMatch(v));
}

function matchesBaseline(hero, entry) {
    const texts = heroTexts(hero);
    return (entry.keys || []).some((key) => {
        const k = normalizeForMatch(key);
        return k && texts.some((t) => t.split(' ').includes(k) || t === k);
    });
}

/**
 * @param {object} loaded   книга v4 в памяти (book.loadBook)
 * @param {object} baseline { characters: [{ id, name, keys: [], speaks }] }
 * @param {{ allowEmptyManner?: boolean, legacyFiles?: string[] }} [options]
 * @returns {{ ok: boolean, checks: {name: string, ok: boolean, details: string[]}[], mapping: object }}
 */
function checkBook(loaded, baseline, options = {}) {
    const checks = [];
    const add = (name, details) => checks.push({ name, ok: details.length === 0, details });
    const heroes = Array.isArray(loaded.heroes) ? loaded.heroes : [];

    add('книга в формате VBook 4, файлов 3.1 нет', [
        ...(loaded.manifest && loaded.manifest.vbook_version === 4 ? [] : [`manifest.vbook_version = ${JSON.stringify(loaded.manifest && loaded.manifest.vbook_version)}`]),
        ...(options.legacyFiles || []).map((f) => `в каталоге книги лежит файл 3.1: ${f}`),
    ]);
    add('файлы героев читаются (нет блокирующих проблем)',
        (loaded.hero_issues || []).filter((i) => i.blocking).map((i) => `${i.file || '—'}: ${i.code} — ${i.message}`));
    add('id героев канонические', heroes.filter((h) => !isValidHeroId(h.id)).map((h) => `неканонический id: ${JSON.stringify(h.id)}`));

    const withPassport = passportHeroes(loaded);
    const mapping = {};
    const missing = [];
    for (const entry of baseline.characters || []) {
        const found = withPassport.filter((h) => matchesBaseline(h, entry));
        mapping[entry.id] = found.map((h) => h.id);
        if (found.length === 0) missing.push(`герой эталона не найден среди героев с паспортом: ${entry.name} (${entry.id})`);
    }
    add('набор героев с паспортом не хуже эталона', missing);

    const merges = [];
    const owners = new Map(); // id героя книги → герои эталона, которые на него легли
    for (const [baseId, ids] of Object.entries(mapping)) {
        for (const id of ids) owners.set(id, [...(owners.get(id) || []), baseId]);
    }
    for (const [id, baseIds] of owners) {
        if (baseIds.length > 1) merges.push(`герой ${id} соответствует сразу нескольким героям эталона: ${baseIds.join(', ')} — ложное слияние`);
    }
    for (const alias of buildAliasIndex(heroes).ambiguous) merges.push(`алиас «${alias}» объявлен двумя героями`);
    for (const [baseId, ids] of Object.entries(mapping)) {
        if (ids.length > 1) merges.push(`герой эталона ${baseId} разложен на несколько героев книги: ${ids.join(', ')} — проверьте, не дубликат ли`);
    }
    add('ложных слияний и дубликатов нет', merges);

    const voices = [];
    const needVoice = [{ label: 'диктор', ids: ['narrator'] },
        ...(baseline.characters || []).filter((e) => e.speaks).map((e) => ({ label: e.name, ids: mapping[e.id] || [] }))];
    for (const { label, ids } of needVoice) {
        for (const id of ids) {
            const hero = heroes.find((h) => h.id === id);
            if (!hero) { voices.push(`${label}: героя ${id} нет в книге`); continue; }
            const v = hero.voice && typeof hero.voice === 'object' ? hero.voice : null;
            if (!v || !text(v.timbre)) voices.push(`${label} (${id}): timbre не заполнен`);
            else if (!text(v.manner) && !options.allowEmptyManner) voices.push(`${label} (${id}): manner не заполнен`);
        }
    }
    for (const hero of heroes) {
        if (hero.voice && Object.prototype.hasOwnProperty.call(hero.voice, 'instruction')) voices.push(`${hero.id}: в голосе осталось поле instruction`);
    }
    add('у диктора и говорящих героев заполнены timbre и manner', voices);

    return { ok: checks.every((c) => c.ok), checks, mapping };
}

function main(argv) {
    const args = argv.filter((a) => !a.startsWith('--'));
    const flags = new Set(argv.filter((a) => a.startsWith('--')));
    if (args.length < 1) {
        console.error('Использование: check-vbook-v4-step2.cjs <каталог книги> [эталон.json] [--allow-empty-manner] [--json]');
        return 2;
    }
    const bookDir = path.resolve(args[0]);
    const baselinePath = path.resolve(args[1] || DEFAULT_BASELINE);
    let loaded, baseline;
    try {
        baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
        configureBooksRoot(path.dirname(bookDir));
        loaded = book.loadBook(path.basename(bookDir));
        if (!loaded) throw new Error(`книга не найдена: ${bookDir}`);
    } catch (err) {
        console.error(`Не удалось прочитать книгу или эталон: ${err.message}`);
        return 2;
    }
    const legacyFiles = LEGACY_FILES.filter((f) => fs.existsSync(path.join(bookDir, f)));
    const report = checkBook(loaded, baseline, { allowEmptyManner: flags.has('--allow-empty-manner'), legacyFiles });
    if (flags.has('--json')) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(`Книга: ${bookDir}`);
        console.log(`Эталон: ${baselinePath}`);
        console.log(`Героев: ${loaded.heroes.length} (с паспортом ${passportHeroes(loaded).length}); соответствие эталону: ${JSON.stringify(report.mapping)}`);
        for (const c of report.checks) {
            console.log(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}`);
            for (const d of c.details) console.log(`        - ${d}`);
        }
        console.log(report.ok ? 'ИТОГ: приёмка 2.6 пройдена' : 'ИТОГ: приёмка 2.6 НЕ пройдена');
    }
    return report.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { checkBook, matchesBaseline, main };
