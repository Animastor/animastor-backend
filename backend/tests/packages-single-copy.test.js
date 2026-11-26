// ======================================================
// One installed copy of every @animastor/* package (bootstrap release, 2026-11-26)
// ======================================================
// Packages bind process-wide ports at the composition root (backend.cjs:
// configureBooksRoot on @animastor/vbook-runtime, setStructureDetector on
// @animastor/parser, …). A second, nested copy (node_modules/<pkg>/node_modules/
// @animastor/<dep>) never gets that binding: vbook-runtime 0.6.0 + editor /
// player / ai-analysis on ^0.5.0 would have installed nested 0.5.0 copies and
// editor book operations would throw "booksRoot is not configured" in prod —
// the suite runs the monorepo sources and would not notice.
// Fix: backend/package.json "overrides" pins @animastor/vbook-runtime to the
// backend's own spec. This guard keeps the lock free of nested copies.

'use strict';

const { expect } = require('chai');
const path = require('path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const LOCK = require(path.join(__dirname, '..', 'package-lock.json'));

describe('package-lock: one copy of each @animastor/* package', () => {
    it('no nested node_modules/**/node_modules/@animastor/*', () => {
        const nested = Object.keys(LOCK.packages || {})
            .filter((k) => k.split('node_modules/').length > 2)
            .filter((k) => k.split('node_modules/').pop().startsWith('@animastor/'));
        expect(nested, `nested @animastor copies (add an override or bump the dependent package):\n  ${nested.join('\n  ')}`)
            .to.deep.equal([]);
    });

    it('vbook-runtime is pinned for every dependent via overrides', () => {
        expect(pkg.overrides && pkg.overrides['@animastor/vbook-runtime']).to.equal('$@animastor/vbook-runtime');
    });
});
