'use strict';

// ADR §5: src/gen depends only on node builtins, its own files, the pg pool
// handed in by the host and the host ports. Static scan, no DB needed.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const GEN = path.resolve(__dirname, '../../src/gen');
const BUILTINS = new Set(['fs', 'path', 'crypto', 'child_process', 'stream']);

function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
    });
}

describe('gen v2 — dependency boundary (ADR §5)', () => {
    it('src/gen requires only node builtins and files inside src/gen', () => {
        const offenders = [];
        for (const f of files(GEN)) {
            const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
            for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
                const spec = m[1].replace(/^node:/, '');
                if (BUILTINS.has(spec)) continue;
                if (spec.startsWith('.')) {
                    const target = path.resolve(path.dirname(f), spec);
                    if (target === GEN || target.startsWith(GEN + path.sep)) continue;
                }
                offenders.push(`${path.relative(GEN, f)} → ${m[1]}`);
            }
        }
        assert.deepEqual(offenders, []);
    });

    it('no Redis / Express / ComfyUI / src/legacy usage in code (the books.orchestration value \'legacy\' is data)', () => {
        for (const f of files(GEN)) {
            const code = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
            assert.doesNotMatch(code, /ioredis|redis\.|express|comfy|\/legacy|legacy\//i, path.relative(GEN, f));
        }
    });
});
