// ======================================================
// The PG tables with build_id — one list, kept in two places (post171)
// ======================================================
// book-repo.buildIdsNamedByOtherBooks (the .vbook importer) and
// book-deletion.cjs BUILD_ID_TABLES (the deletion cascade — Book Model layer,
// it may not require the repository) each keep the list of PG tables that
// record a build_id next to a book_id. Both are read as TEXT here (no import
// across the layer boundary) and must:
//   1. be the same set;
//   2. contain every table that schema.js (the single DDL owner, PG-5) gives
//      both a build_id and a book_id column.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** `const BUILD_ID_TABLES = Object.freeze([ 'a', 'b', … ])` → ['a', 'b', …] */
function listOf(text, file) {
    const m = text.match(/const BUILD_ID_TABLES = Object\.freeze\(\[([\s\S]*?)\]\)/);
    expect(m, `BUILD_ID_TABLES in ${file}`).to.not.equal(null);
    return [...m[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((x) => x[1]);
}

/** table → Set(columns), from CREATE TABLE blocks and `{ table, column }` migration entries. */
function schemaColumns(text) {
    const out = new Map();
    const add = (t, c) => { if (!out.has(t)) out.set(t, new Set()); out.get(t).add(c); };
    const re = /CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)\s*\(/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        // the body up to the matching ')'
        let depth = 1;
        let i = re.lastIndex;
        for (; i < text.length && depth > 0; i++) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') depth--;
        }
        const body = text.slice(re.lastIndex, i - 1);
        for (const line of body.split('\n')) {
            const col = line.match(/^\s*([a-z_][a-z0-9_]*)\s+[A-Z]/);
            if (col && !/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK)$/i.test(col[1])) add(m[1], col[1]);
        }
    }
    for (const x of text.matchAll(/\{\s*table:\s*'([a-z_][a-z0-9_]*)',\s*column:\s*'([a-z_][a-z0-9_]*)'/g)) add(x[1], x[2]);
    return out;
}

describe('PG tables with build_id — book-repo and book-deletion agree with schema.js (post171)', () => {
    const repo = listOf(read('storage/postgres/repositories/book-repo.js'), 'book-repo.js');
    const deletion = listOf(read('services/book-deletion.cjs'), 'book-deletion.cjs');

    it('book-repo.buildIdsNamedByOtherBooks and book-deletion BUILD_ID_TABLES are the same set', () => {
        expect(repo.length).to.be.greaterThan(0);
        expect([...new Set(repo)].sort()).to.deep.equal([...new Set(deletion)].sort());
    });

    it('every schema.js table with both build_id and book_id is in the list', () => {
        const cols = schemaColumns(read('storage/postgres/schema.js'));
        const withBoth = [...cols].filter(([, c]) => c.has('build_id') && c.has('book_id')).map(([t]) => t).sort();
        // the parser must see the tables it is meant to see (a broken parser must not pass silently)
        expect(withBoth).to.include.members(['scenes', 'image_units', 'scene_assets']);
        expect(withBoth.filter((t) => !repo.includes(t)), 'tables missing from BUILD_ID_TABLES').to.deep.equal([]);
    });
});
