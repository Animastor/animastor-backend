// ======================================================
// hero-id — canonical ids for heroes that come from the analysis
// (VBOOK_FORMAT_V4 §12, шаг 2, приёмка 2.0)
// ======================================================

'use strict';

const { expect } = require('chai');
const { normalizeHeroId, assignHeroIds, mergeAliases, firstFreeId } = require('../src/hero-id.cjs');
const { isValidHeroId, RESERVED_HERO_IDS } = require('../src/heroes.cjs');

const ids = (plan) => plan.assignments.map((a) => a.id);

describe('hero id normalisation (step 2)', () => {
    describe('normalizeHeroId — Russian names and other text', () => {
        const CASES = [
            ['Юра', 'yura'],
            ['Анна Сергеевна', 'anna_sergeevna'],
            ['Ёж', 'yozh'],
            ['ёж', 'yozh'],
            ['Женщина в будочке', 'zhenshchina_v_budochke'],
            ['Михаил Александрович Берлиоз', 'mikhail_aleksandrovich_berlioz'],
            ['Щукин', 'shchukin'],
            ['Объездчик', 'obezdchik'],
            ['Марья Ивановна-Петрова', 'marya_ivanovna_petrova'],
            ['Д’Артаньян', 'd_artanyan'],
            ['Yura', 'yura'],
            ['  The Shop   Woman  ', 'the_shop_woman'],
            ['anna-sergeevna', 'anna_sergeevna'],
            ['Agent 007', 'agent_007'],
            ['yura', 'yura'],
            ['shop_women', 'shop_women'],
            ['__yura__', 'yura'],
            ['Юра (сосед)', 'yura_sosed'],
            ['../../etc/passwd', 'etc_passwd'],
            ['a/b\\c', 'a_b_c'],
        ];
        for (const [raw, expected] of CASES) {
            it(`${JSON.stringify(raw)} → ${expected}`, () => {
                expect(normalizeHeroId(raw)).to.equal(expected);
                expect(isValidHeroId(expected)).to.equal(true);
                // normalisation is idempotent and deterministic
                expect(normalizeHeroId(expected)).to.equal(expected);
                expect(normalizeHeroId(raw)).to.equal(normalizeHeroId(raw));
            });
        }

        it('text with nothing usable gives an empty id', () => {
            for (const raw of ['', '   ', '!!!', '—', '«»', '。。', null, undefined, 42, {}, []]) {
                expect(normalizeHeroId(raw), JSON.stringify(raw)).to.equal('');
            }
        });

        it('a long name is cut to 64 characters and still is a valid id', () => {
            const long = 'Александр Сергеевич Пушкин-Ганнибал, камер-юнкер двора Его Императорского Величества';
            const id = normalizeHeroId(long);
            expect(id.length).to.be.at.most(64);
            expect(isValidHeroId(id)).to.equal(true);
            expect(id.startsWith('aleksandr_sergeevich_pushkin')).to.equal(true);
            expect(normalizeHeroId('x'.repeat(200))).to.equal('x'.repeat(64));
            // the cut never leaves a trailing separator
            expect(normalizeHeroId(`${'a'.repeat(63)} b`)).to.equal('a'.repeat(63));
        });
    });

    describe('assignHeroIds — new heroes of one window', () => {
        it('Russian names become canonical ids; the name stays, the model\'s spelling becomes an alias', () => {
            const plan = assignHeroIds([
                { id: 'Юра', name: 'Юра', alias: 'Юрий' },
                { name: 'Анна Сергеевна' },
                { id: 'Женщина в будочке', name: 'Продавщица', aliases: ['женщина', 'продавщица'] },
                { id: 'shop_women', name: 'Shop women' },
            ], []);
            expect(ids(plan)).to.deep.equal(['yura', 'anna_sergeevna', 'zhenshchina_v_budochke', 'shop_women']);
            expect(plan.assignments.map((a) => a.name)).to.deep.equal(['Юра', 'Анна Сергеевна', 'Продавщица', 'Shop women']);
            expect(plan.assignments.map((a) => a.aliases)).to.deep.equal([['Юрий'], [], ['Женщина в будочке', 'женщина'], []]);
            expect(plan.assignments.every((a) => a.existing === false)).to.equal(true);
            expect(Object.fromEntries(plan.idMap)).to.deep.equal({
                'Юра': 'yura', 'Женщина в будочке': 'zhenshchina_v_budochke', shop_women: 'shop_women',
            });
            expect(plan.skipped).to.deep.equal([]);
        });

        it('two different people whose ids coincide after transliteration get _2, _3 in the order of the window', () => {
            const window = [
                { id: 'Саша', name: 'Саша Белов' },
                { id: 'sasha', name: 'Александра' },
                { id: 'САША', name: 'Саша-кочегар' },
                { id: 'Юра', name: 'Юра' },
            ];
            const plan = assignHeroIds(window, []);
            expect(ids(plan)).to.deep.equal(['sasha', 'sasha_2', 'sasha_3', 'yura']);
            expect(plan.assignments.map((a) => a.reason)).to.deep.equal(['new', 'new_suffix', 'new_suffix', 'new']);
            // the same input → the same ids
            expect(ids(assignHeroIds(window, []))).to.deep.equal(ids(plan));
            expect(ids(assignHeroIds(JSON.parse(JSON.stringify(window)), []))).to.deep.equal(ids(plan));
        });

        it('an id the book already shares between two heroes (sasha, sasha_2) is ambiguous: an unrecognised candidate is a third hero', () => {
            const book = [{ id: 'sasha', name: 'Саша Белов' }, { id: 'sasha_2', name: 'Александра' }];
            for (const rawId of ['Саша', 'sasha', 'SASHA']) {
                const plan = assignHeroIds([{ id: rawId, name: 'Саша-кочегар' }], book);
                expect(ids(plan), rawId).to.deep.equal(['sasha_3']);
                expect(plan.assignments[0]).to.include({ existing: false, reason: 'new_suffix' });
            }
        });

        it('an alias or a raw id that already names another hero is not handed to a second one', () => {
            const book = [{ id: 'boris', name: 'Борис', aliases: ['дед'] }];
            const plan = assignHeroIds([
                { id: 'БОРИС', name: 'Савелий Кузьмич', aliases: ['Дед', 'Кузьмич'] },
                { id: 'Сосед', name: 'Пётр', alias: 'Кузьмич' },
            ], book);
            // (the first candidate reuses the id of Борис → the same hero by id; its alias "Дед" is his already)
            expect(plan.assignments[0]).to.include({ id: 'boris', existing: true });
            expect(plan.assignments[1]).to.include({ id: 'sosed', existing: false });
            expect(plan.assignments[1].aliases).to.deep.equal(['Сосед', 'Кузьмич']);
            // two new people with one id in one window: the id stays an alias of the first only
            const twoNew = assignHeroIds([{ id: 'Дед', name: 'Савелий' }, { id: 'ДЕД', name: 'Игнат' }], []);
            expect(ids(twoNew)).to.deep.equal(['ded', 'ded_2']);
            expect(twoNew.assignments.map((a) => a.aliases)).to.deep.equal([['Дед'], []]);
        });

        it('reserved ids are never issued', () => {
            for (const reserved of RESERVED_HERO_IDS) {
                const plan = assignHeroIds([{ id: reserved, name: `Герой ${reserved}` }], []);
                expect(ids(plan), reserved).to.deep.equal([`${reserved}_2`]);
                expect(plan.assignments[0].reason).to.equal('new_reserved');
                expect(isValidHeroId(plan.assignments[0].id)).to.equal(true);
            }
            // a name that transliterates into a reserved word
            expect(ids(assignHeroIds([{ name: 'Book' }, { name: 'Index' }, { name: 'Source' }, { name: 'Chapters' }], [])))
                .to.deep.equal(['book_2', 'index_2', 'source_2', 'chapters_2']);
        });

        it('the narrator id is not handed to a character called "Narrator"… it IS the narrator when the book has one', () => {
            const book = [{ id: 'narrator', role: 'narrator' }];
            expect(assignHeroIds([{ id: 'narrator', name: 'Рассказчик' }], book).assignments[0]).to.include({ id: 'narrator', existing: true, reason: 'same_id' });
        });

        it('long ids: the suffix fits inside 64 characters', () => {
            const long = 'ж'.repeat(40); // "zh" × 40 = 80 characters
            const plan = assignHeroIds([{ id: long, name: 'Первый' }, { id: long, name: 'Второй' }, { id: long, name: 'Третий' }], []);
            for (const a of plan.assignments) {
                expect(a.id.length).to.be.at.most(64);
                expect(isValidHeroId(a.id)).to.equal(true);
            }
            expect(new Set(ids(plan)).size).to.equal(3);
            expect(ids(plan)[1].endsWith('_2')).to.equal(true);
            expect(ids(plan)[2].endsWith('_3')).to.equal(true);
        });

        it('a candidate without a usable id or name is skipped, the rest are not affected', () => {
            const plan = assignHeroIds([{ id: '!!!', name: '' }, { name: 'Юра' }, { id: '', name: '   ' }, null, 'yura', { id: '—', name: 'Анна' }], []);
            expect(ids(plan)).to.deep.equal(['yura', 'anna']);
            expect(plan.skipped.map((s) => s.reason)).to.deep.equal(['empty_id', 'empty_id']);
        });

        it('the same character listed twice in one window is one hero', () => {
            const plan = assignHeroIds([{ id: 'Юра', name: 'Юра' }, { id: 'Юра', name: 'Юра', alias: 'Юрка' }, { id: 'yurka', name: 'Юра' }], []);
            expect(ids(plan)).to.deep.equal(['yura', 'yura', 'yura']);
            expect(plan.assignments.filter((a) => !a.existing && a.reason === 'new')).to.have.length(1);
        });

        it('does not mutate its inputs', () => {
            const window = [{ id: 'Юра', name: 'Юра', aliases: ['Юрий'] }];
            const book = [{ id: 'anna', name: 'Анна', aliases: ['Аня'] }];
            const before = JSON.stringify([window, book]);
            assignHeroIds(window, book);
            expect(JSON.stringify([window, book])).to.equal(before);
        });
    });

    describe('assignHeroIds — the same hero in the next window keeps its id', () => {
        const book = [
            { id: 'narrator', role: 'narrator' },
            { id: 'yura', name: 'Юра', aliases: ['Юрий', 'Юрка'] },
            { id: 'sasha', name: 'Саша Белов' },
            { id: 'sasha_2', name: 'Александра', aliases: ['Саша'] },
            { id: 'anna_sergeevna', name: 'Анна Сергеевна' },
        ];

        it('matched by the model\'s id, by name and by alias — whatever spelling the model uses this time', () => {
            const plan = assignHeroIds([
                { id: 'yura', name: 'Юрий Андреевич' },      // reused our id
                { id: 'Юрий', name: 'Юрий' },                 // an alias as name
                { id: 'yuriy', name: 'ЮРКА' },                // another id, alias in another case
                { id: 'Анна', name: 'Анна Сергеевна' },       // full name
                { id: 'belov', name: 'Саша Белов' },
            ], book);
            expect(ids(plan)).to.deep.equal(['yura', 'yura', 'yura', 'anna_sergeevna', 'sasha']);
            expect(plan.assignments.map((a) => a.reason)).to.deep.equal(['same_id', 'matched_by_name', 'matched_by_name', 'matched_by_name', 'matched_by_name']);
            expect(plan.assignments.every((a) => a.existing)).to.equal(true);
            expect(plan.idMap.get('Юрий')).to.equal('yura');
            expect(plan.idMap.get('yuriy')).to.equal('yura');
            expect(plan.idMap.get('Анна')).to.equal('anna_sergeevna');
        });

        it('the hero created with a suffix is found again by name — a repeated window gives the same ids', () => {
            const window = [{ id: 'Саша', name: 'Саша Белов' }, { id: 'sasha', name: 'Александра' }, { id: 'САША', name: 'Саша-кочегар' }];
            const first = assignHeroIds(window, []);
            const afterFirst = first.assignments.map((a) => ({ id: a.id, name: a.name, aliases: a.aliases }));
            const second = assignHeroIds(window, afterFirst);
            expect(ids(second)).to.deep.equal(ids(first));
            expect(second.assignments.every((a) => a.existing)).to.equal(true);
            const third = assignHeroIds([...window].reverse(), afterFirst);
            expect(ids(third)).to.deep.equal([...ids(first)].reverse());
        });

        it('an ambiguous alias does not merge heroes: the candidate is a new hero', () => {
            // "Саша" is the NAME-start of sasha and an ALIAS of sasha_2 → as a bare name it points at sasha_2 only
            // (alias), so make it truly ambiguous: two heroes claim the same alias.
            const cast = [
                { id: 'yura', name: 'Юра', aliases: ['Доктор'] },
                { id: 'boris', name: 'Борис', aliases: ['доктор'] },
            ];
            const plan = assignHeroIds([{ id: 'doktor', name: 'Доктор' }], cast);
            expect(plan.assignments[0]).to.include({ id: 'doktor', existing: false, reason: 'new' });
            // name points at one hero, alias at another → nobody
            const split = assignHeroIds([{ id: 'x1', name: 'Юра', alias: 'Борис' }], cast);
            expect(split.assignments[0].existing).to.equal(false);
            expect(split.assignments[0].id).to.equal('x1');
        });

        it('a name that only resembles an existing one is a different hero', () => {
            const plan = assignHeroIds([{ id: 'yura_b', name: 'Юра Белов' }, { id: 'anna', name: 'Анна' }], book);
            expect(ids(plan)).to.deep.equal(['yura_b', 'anna']);
            expect(plan.assignments.every((a) => !a.existing)).to.equal(true);
        });

        it('the model wrote the id of a hero in Cyrillic or another case → the same hero, the new name is an alias', () => {
            for (const rawId of ['Юра', 'ЮРА', 'Yura', 'yura']) {
                const plan = assignHeroIds([{ id: rawId, name: 'Юрий Живаго-младший' }], book);
                expect(plan.assignments[0], rawId).to.include({ id: 'yura', existing: true, reason: 'same_id' });
                expect(plan.assignments[0].name).to.equal('Юрий Живаго-младший');
            }
            // …but "sasha" is shared by sasha and sasha_2 in this book: the id alone decides nothing
            const shared = assignHeroIds([{ id: 'Саша', name: 'Совсем другой Саша' }], book);
            expect(shared.assignments[0]).to.include({ id: 'sasha_3', existing: false });
        });
    });

    describe('helpers', () => {
        it('mergeAliases keeps the first spelling, drops repeats after normalizeForMatch and the name itself', () => {
            expect(mergeAliases('Юра', ['Юрий', ' юрий ', 'ЮРА'], ['Юрка', '', null, 'Юрий'])).to.deep.equal(['Юрий', 'Юрка']);
            expect(mergeAliases('', undefined, ['a', 'A'])).to.deep.equal(['a']);
        });
        it('firstFreeId returns the base when it is free and valid', () => {
            expect(firstFreeId('yura', new Set())).to.equal('yura');
            expect(firstFreeId('yura', new Set(['yura', 'yura_2']))).to.equal('yura_3');
            expect(firstFreeId('book', new Set())).to.equal('book_2');
        });
    });
});
