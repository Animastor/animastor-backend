// ======================================================
// VBook 4 step 2b — the character step sees the registry of the book
// ======================================================
// VBOOK_FORMAT_V4 §12б. The model gets id / name / aliases of the known
// heroes (never looks or passports), within a character budget, heroes named
// in the window first, and is told to return a known hero under its id.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { formatKnownHeroes, charactersTask, KNOWN_HEROES_MAX_CHARS } = require('@animastor/ai-analysis/tasks/character-analyzer');

const REGISTRY = [
    {
        id: 'mikhail_berlioz', name: 'Михаил Александрович Берлиоз', aliases: ['редактор'],
        appearance: 'small plump bald man', passport: { appearance: 'small plump bald man', clothes: 'grey suit', video_tokens: ['bald head'] },
        voice: { timbre: 'A tenor.', manner: '' },
    },
    { id: 'voland', name: 'Иностранец', aliases: ['немец', 'англичанин'] },
];
const ports = { prompt: () => 'SYSTEM', fillLang: (t) => t };

describe('VBook 4 step 2b — known heroes in the character extraction prompt', () => {
    it('window 1 (empty registry): the user message is the plain extraction request', () => {
        const { messages } = charactersTask.buildMessages({ windowText: 'Текст окна.', knownHeroes: [] }, ports);
        expect(messages[1].content).to.equal('Extract all characters from this text:\n\n```\nТекст окна.\n```');
        const legacy = charactersTask.buildMessages({ windowText: 'Текст окна.' }, ports);
        expect(legacy.messages[1].content).to.equal(messages[1].content);
    });

    it('window 2: id, name and aliases of every known hero precede the text — no passport, no looks, no voice', () => {
        const { messages } = charactersTask.buildMessages({ windowText: 'Иностранец сел.', knownHeroes: REGISTRY }, ports);
        const content = messages[1].content;
        expect(content.startsWith('Known characters of this book (one JSON object per line):\n')).to.equal(true);
        expect(content).to.include('{"id":"voland","name":"Иностранец","aliases":["немец","англичанин"]}');
        expect(content).to.include('{"id":"mikhail_berlioz","name":"Михаил Александрович Берлиоз","aliases":["редактор"]}');
        for (const word of ['bald', 'grey suit', 'passport', 'appearance', 'timbre', 'video_tokens']) expect(content).to.not.include(word);
        expect(content.endsWith('Extract all characters from this text:\n\n```\nИностранец сел.\n```')).to.equal(true);
    });

    it('heroes named in the window come first; the narrator is never listed', () => {
        const out = formatKnownHeroes([{ id: 'narrator', name: 'Narrator' }, ...REGISTRY], 'Тут иностранец.');
        expect(out.included).to.deep.equal(['voland', 'mikhail_berlioz']);
    });

    it('a large book: the list stays within the budget and says how many heroes are not shown', () => {
        const big = Array.from({ length: 500 }, (_, i) => ({ id: `hero_${i}`, name: `Герой ${i}`, aliases: Array.from({ length: 20 }, (__, k) => `алиас ${i}-${k}`) }));
        const out = formatKnownHeroes(big, 'Пришёл Герой 499.');
        const list = out.text.split('\n').slice(1).filter((l) => l.startsWith('{'));
        expect(list.join('\n').length).to.be.at.most(KNOWN_HEROES_MAX_CHARS);
        expect(out.omitted).to.equal(500 - out.included.length).and.to.be.above(0);
        expect(out.text).to.match(new RegExp(`\\(${out.omitted} more known characters are not shown\\)$`));
        expect(out.included[0]).to.equal('hero_499');
        // at most 8 aliases per hero
        expect(JSON.parse(list[0]).aliases).to.have.length(8);
    });

    it('garbage in the registry is skipped', () => {
        const out = formatKnownHeroes([null, {}, { id: '' }, { id: 'a', name: '  ', aliases: [1, '', 'x'] }], '');
        expect(out.text.split('\n')[1]).to.equal('{"id":"a","aliases":["x"]}');
    });

    it('the rules tell the model to return the id of a known hero', () => {
        const rules = fs.readFileSync(path.join(__dirname, '..', 'ai', 'rules', 'characters.md'), 'utf8');
        expect(rules).to.include('## Known characters of this book');
        expect(rules).to.include('EXACTLY the known `id`');
    });
});
