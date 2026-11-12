// ======================================================
// utils/build-dir — clear a build folder but keep the voice references
// ======================================================
// VOICE_REFERENCES.md: build_<book_id>/voices/ holds the locked voice
// references (designed on the GPU or uploaded by the user). «Очистить кэш»
// and the cleanup service clear the GENERATED content only; voices/ goes
// away only together with the book (services/book-deletion.cjs).

'use strict';

const fs = require('fs');
const path = require('path');

const PRESERVED_ENTRIES = Object.freeze(['voices']);

/**
 * Remove every entry of buildPath except PRESERVED_ENTRIES.
 * @returns {{removed:number, kept:string[]}}
 */
function clearBuildDirKeepingVoices(buildPath, fsImpl = fs) {
    if (!fsImpl.existsSync(buildPath)) return { removed: 0, kept: [] };
    let removed = 0;
    const kept = [];
    for (const entry of fsImpl.readdirSync(buildPath)) {
        if (PRESERVED_ENTRIES.includes(entry)) { kept.push(entry); continue; }
        fsImpl.rmSync(path.join(buildPath, entry), { recursive: true, force: true });
        removed += 1;
    }
    if (kept.length === 0) {
        try { fsImpl.rmdirSync(buildPath); } catch (_) { /* not empty / gone */ }
    }
    return { removed, kept };
}

module.exports = { clearBuildDirKeepingVoices, PRESERVED_ENTRIES };
