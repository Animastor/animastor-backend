// ======================================================
// VBook 4 step 3 — one book in two shapes (acceptance: image and video prompts
// of the v4 book equal the 3.1 golden of the same book)
// ======================================================
// SPEC is the book once. book31() renders it in the 3.1 shape the generation
// code read before step 3 (book.characters, scene.passport[id],
// chapter.character[id]); bookV4() in the v4 shape (heroes, hero.looks +
// chapter.looks, scene.look_patch). golden.json was produced by the 3.1 code
// from book31() BEFORE the readers were moved (scripts in the step 3 report).
//
// What is covered: base passport; a chapter override of clothes (a look
// assigned to the chapter in v4); a scene override of appearance / clothes /
// video_tokens (look_patch); two participants whose scene tokens collide (the
// second falls back to its base tokens); a participant written as a near-id
// ("berlioz" → mikhail_berlioz, fuzzy match); a voice-only hero (no passport);
// names in image.prompt / video.action / audio.speaker normalised to ids.
// Not covered on purpose: scene.visual.character (never written, dropped by v4).

'use strict';

const SPEC = {
    heroes: [
        {
            id: 'mikhail_berlioz', name: 'Михаил Александрович Берлиоз',
            passport: { appearance: 'Short, plump, bald man in his forties, round glasses.', clothes: 'grey summer suit, straw hat', video_tokens: ['round glasses', 'straw hat'] },
            voice: { timbre: 'High male tenor. Native Russian pronunciation.', manner: 'Lecturing.' },
        },
        {
            id: 'ivan_ponyrev', name: 'Иван Николаевич Понырев (Бездомный)',
            passport: { appearance: 'Broad-shouldered young man with ginger hair.', clothes: 'checked cap, white shirt, crumpled trousers', video_tokens: ['checked cap'] },
            voice: { timbre: 'Clear male tenor of a young man. Native Russian pronunciation.', manner: '' },
        },
        {
            id: 'voland', name: 'Воланд',
            passport: { appearance: 'Tall man over forty, one eye green, the other black.', clothes: 'expensive grey suit, beret', video_tokens: ['beret', 'cane with poodle head'] },
            voice: { timbre: 'Low dry male voice with a slight foreign accent.', manner: 'Polite and unhurried.' },
        },
        {
            id: 'koroviev', name: 'Коровьев',
            passport: { appearance: 'Long thin citizen with a tiny head.', clothes: 'checked jacket, cracked pince-nez', video_tokens: ['checked jacket'] },
        },
        { id: 'tram_driver', name: 'Вагоновожатая', voice: { timbre: 'Young female voice. Native Russian pronunciation.', manner: '' } },
    ],
    chapters: [
        {
            chapter_id: 'ch1', title: 'Никогда не разговаривайте с неизвестными',
            // ch1: Ivan wears the summer outfit everywhere (a chapter look)
            chapterLook: { ivan_ponyrev: { id: 'summer', label: 'Летом', fields: { clothes: 'cowboy shirt, white trousers, slippers' } } },
            scenes: [
                {
                    scene_id: 's1', title: 'Патриаршие пруды', participants: ['mikhail_berlioz', 'ivan_ponyrev'],
                    location: { id: 'patriarch_ponds', environment: { time: 'evening' } },
                    units: [
                        { id: 'u1', type: 'narration', text: 'В час жаркого весеннего заката…', image: { shot: 'wide', prompt: 'Берлиоз and Бездомный walk along the ponds' }, video: { action: 'Берлиоз wipes his glasses, Бездомный looks around' } },
                        { id: 'u2', type: 'dialogue', text: '— Нарзану нету, — ответила женщина.', audio: { speaker: 'Иван' }, image: { shot: 'medium', prompt: 'ivan_ponyrev at the kiosk' }, video: { action: 'ivan_ponyrev leans on the counter' } },
                    ],
                },
                {
                    // scene overrides: Berlioz's appearance and tokens (look_patch in v4); Voland and
                    // Koroviev get colliding tokens — Koroviev falls back to his base tokens
                    scene_id: 's2', title: 'Иностранец', participants: ['berlioz', 'voland', 'koroviev', 'tram_driver'],
                    location: { id: 'patriarch_ponds' },
                    override: {
                        mikhail_berlioz: { appearance: 'Short, plump man, pale and sweating.', video_tokens: ['round glasses', 'sweat'] },
                        voland: { video_tokens: ['beret'] },
                        koroviev: { video_tokens: ['beret'], clothes: 'checked jacket' },
                    },
                    units: [
                        { id: 'u3', type: 'narration', text: 'И тут…', image: { shot: 'close_up', prompt: 'Воланд smiles at Берлиоз' }, video: { action: 'Воланд tips his beret, Коровьев sways behind' } },
                        { id: 'u4', type: 'dialogue', text: '— Вы — немец?', audio: { speaker: 'Берлиоз' }, image: { shot: 'medium', prompt: 'the two men on the bench' }, video: { action: 'the two men turn to each other' } },
                    ],
                },
            ],
        },
        {
            chapter_id: 'ch2', title: 'Понтий Пилат',
            scenes: [
                {
                    // ch2 has no chapter look: Ivan in his base clothes; clothes override for Voland
                    scene_id: 's3', title: 'Погоня', participants: ['ivan_ponyrev', 'voland'],
                    location: { id: 'arbat' },
                    override: { voland: { clothes: 'black cloak' } },
                    units: [
                        { id: 'u5', type: 'narration', text: 'Иван бросился…', image: { shot: 'wide', prompt: 'Иван chases Воланд across the square' }, video: { action: 'Иван runs, Воланд walks away calmly' } },
                    ],
                },
            ],
        },
    ],
    locations: {
        patriarch_ponds: { description: 'Patriarch Ponds alley under lime trees, Moscow 1930s', environment: { season: 'late spring', weather: 'hot' } },
        arbat: { description: 'Arbat square with a tram line' },
    },
    bible: { country: 'USSR', epoch: '1930s', render_rules: { style: 'oil_painting' } },
};

const clone = (v) => JSON.parse(JSON.stringify(v));

function scene31(s) {
    const out = { scene_id: s.scene_id, title: s.title, participants: [...s.participants], location: clone(s.location), units: clone(s.units) };
    if (s.override) out.passport = clone(s.override);
    return out;
}

function book31() {
    return {
        manifest: { book_id: 'step3_fixture', vbook_version: '3.1', render: { mode: 'standard' } },
        book: { title: 'Мастер и Маргарита (фикстура шага 3)' },
        bible: clone(SPEC.bible),
        locations: clone(SPEC.locations),
        characters: SPEC.heroes.filter((h) => h.passport).map((h) => ({ id: h.id, name: h.name, passport: clone(h.passport) })),
        voices: Object.fromEntries(SPEC.heroes.filter((h) => h.voice).map((h) => [h.id, clone(h.voice)])),
        chapters: SPEC.chapters.map((c) => ({
            chapter_id: c.chapter_id, title: c.title,
            ...(c.chapterLook ? { character: Object.fromEntries(Object.entries(c.chapterLook).map(([id, look]) => [id, clone(look.fields)])) } : {}),
            scenes: c.scenes.map(scene31),
        })),
    };
}

function bookV4() {
    const heroes = SPEC.heroes.map((h) => {
        const hero = { schema: 'animastor.character/1', id: h.id, name: h.name };
        if (h.passport) hero.passport = clone(h.passport);
        if (h.voice) hero.voice = clone(h.voice);
        const looks = [];
        for (const c of SPEC.chapters) {
            if (c.chapterLook && c.chapterLook[h.id]) looks.push(clone(c.chapterLook[h.id]));
        }
        if (looks.length) hero.looks = looks;
        return hero;
    });
    return {
        manifest: { book_id: 'step3_fixture', vbook_version: 4, render: { mode: 'standard' } },
        book: { title: 'Мастер и Маргарита (фикстура шага 3)' },
        bible: clone(SPEC.bible),
        locations: clone(SPEC.locations),
        behaviour: { schema: 'animastor.behaviour-globals/1', defaults: { max_per_scene: 2 }, rules: [] },
        heroes,
        hero_issues: [],
        chapters: SPEC.chapters.map((c) => ({
            chapter_id: c.chapter_id, title: c.title,
            ...(c.chapterLook ? { looks: Object.fromEntries(Object.entries(c.chapterLook).map(([id, look]) => [id, look.id])) } : {}),
            scenes: c.scenes.map((s) => {
                const out = { scene_id: s.scene_id, title: s.title, participants: [...s.participants], location: clone(s.location), units: clone(s.units) };
                if (s.override) out.look_patch = clone(s.override);
                return out;
            }),
        })),
    };
}

/** Every prompt of a book: image per unit, video per scene (same calls for both shapes). */
function allPrompts(book, { buildImagePrompt, buildVideoPrompt }) {
    const out = { image: {}, video: {} };
    for (const chapter of book.chapters) {
        for (const scene of chapter.scenes) {
            for (const unit of scene.units) {
                out.image[`${chapter.chapter_id}/${scene.scene_id}/${unit.id}`] = buildImagePrompt(unit, scene, chapter, book);
            }
            const sceneData = { chapter_id: chapter.chapter_id, scene_id: scene.scene_id, chapter, scene, payload: scene };
            out.video[`${chapter.chapter_id}/${scene.scene_id}`] = buildVideoPrompt(sceneData, book, scene.units, scene.units.map(() => 3));
        }
    }
    return out;
}

module.exports = { SPEC, book31, bookV4, allPrompts };
