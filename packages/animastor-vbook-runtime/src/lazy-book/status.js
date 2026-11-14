// ======================================================
// Lazy Book — Status & Summaries
// ======================================================

const { SceneStatus } = require('./constants');
const { splitIntoChapters } = require('@animastor/parser');
const draft = require('./draft');
const { passportHeroes } = require('../heroes.cjs');

function getBookStatus(bookId) {
    const d = draft.loadDraftBook(bookId);
    if (!d) return null;

    let totalChapters = 0;
    if (d.sourceText) {
        totalChapters = splitIntoChapters(d.sourceText).length;
    }

    let totalScenes = 0;
    for (const ch of d.chapters) {
        totalScenes += ch.scenes ? ch.scenes.length : 0;
    }

    // "Characters" of a book are heroes with a passport (VBOOK_FORMAT_V4 §4);
    // the narrator and voice-only speakers are heroes but not characters.
    const characters = passportHeroes(d);
    const aliasCount = d.heroes.reduce((n, h) => n + (Array.isArray(h.aliases) ? h.aliases.length : 0), 0);

    return {
        bookId,
        state: d.manifest.state,
        source: d.manifest.source,
        title: d.book.title,
        author: d.book.author,
        language: d.book.language,
        hasSource: !!d.sourceText,
        hasCharacters: characters.length > 0,
        hasBible: Object.keys(d.bible).length > 0,
        totalChapters,
        parsedChapters: d.chapters.length,
        totalScenes,
        parsedScenes: totalScenes,
        characterCount: characters.length,
        heroCount: d.heroes.length,
        aliasCount,
        heroIssues: d.hero_issues.filter((i) => i.blocking).length,
        locationCount: Object.keys(d.locations || {}).length,
        sourceSize: d.manifest.import_meta?.original_size || 0,
        updatedAt: d.manifest.updated_at,
    };
}

function getChaptersSummary(bookId) {
    const d = draft.loadDraftBook(bookId);
    if (!d) return null;

    const allChapters = d.sourceText ? splitIntoChapters(d.sourceText) : [];

    const chapters = allChapters.map((ch, i) => {
        const parsed = d.chapters.find(c => c.chapter_index === i);
        return {
            index: i,
            title: ch.title,
            startLine: ch.startLine,
            endLine: ch.endLine,
            status: parsed ? SceneStatus.PARSED : SceneStatus.NOT_PARSED,
            chapterId: parsed ? parsed.chapter : null,
            sceneCount: parsed ? (parsed.scenes ? parsed.scenes.length : 0) : null,
            sceneTitles: parsed ? (parsed.scenes || []).map(s => s.scene_title || `Scene ${s.scene_id}`) : [],
        };
    });

    return {
        bookId,
        state: d.manifest.state,
        totalChapters: allChapters.length,
        parsedChapters: d.chapters.length,
        chapters,
    };
}

module.exports = {
    getBookStatus,
    getChaptersSummary,
};
