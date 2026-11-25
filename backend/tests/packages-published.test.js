// ======================================================
// packages/<pkg>/src must be what backend installs from the registry (post171)
// ======================================================
// The backend tests run the CANONICAL monorepo sources (../packages/**, see
// tests/monorepo-source-bindings.cjs), but the production image installs
// @animastor/* from the npm registry at the versions in package-lock.json
// (Dockerfile: npm install). A change to packages/<pkg>/src that was never
// published (or published without bumping the backend lock) therefore passes
// every test and never reaches prod — post171: editor 0.5.0 shipped the old
// blank-book build_id while the tests saw the fix.
//
// For every package under packages/ that backend installs from the registry
// (top-level node_modules/<name> in package-lock.json, resolved from
// registry.npmjs.org), the installed src/ must be byte-identical to
// packages/<dir>/src. Requires `npm ci` (test-backend.sh deps guard).

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
const PACKAGES = path.resolve(BACKEND, '..', 'packages');
const LOCK = require(path.join(BACKEND, 'package-lock.json'));

/** relative path → Buffer, every file under dir (sorted) */
function tree(dir) {
    const out = new Map();
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) out.set(path.relative(dir, p), fs.readFileSync(p));
        }
    };
    walk(dir);
    return out;
}

/** [{ dir, name, version }] — packages/* that backend installs from the registry */
function registryInstalledPackages() {
    const list = [];
    for (const dir of fs.readdirSync(PACKAGES).sort()) {
        const pj = path.join(PACKAGES, dir, 'package.json');
        if (!fs.existsSync(pj) || !fs.existsSync(path.join(PACKAGES, dir, 'src'))) continue;
        const { name } = JSON.parse(fs.readFileSync(pj, 'utf8'));
        const entry = (LOCK.packages || {})[`node_modules/${name}`];
        if (!entry || typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/')) continue;
        list.push({ dir, name, version: entry.version });
    }
    return list;
}

/** differences between two src trees, as human-readable lines */
function srcDiff(installed, canonical) {
    const a = tree(installed);
    const b = tree(canonical);
    const lines = [];
    for (const f of new Set([...a.keys(), ...b.keys()])) {
        if (!a.has(f)) lines.push(`only in packages/: ${f}`);
        else if (!b.has(f)) lines.push(`only in the installed copy: ${f}`);
        else if (!a.get(f).equals(b.get(f))) lines.push(`differs: ${f}`);
    }
    return lines.sort();
}

describe('packages/<pkg>/src = the registry copy backend installs (post171)', () => {
    const pkgs = registryInstalledPackages();

    it('covers the registry-installed packages (editor and assistant included)', () => {
        const names = pkgs.map((p) => p.name);
        expect(names).to.include.members(['@animastor/editor', '@animastor/assistant']);
    });

    for (const { dir, name, version } of pkgs) {
        it(`${name}@${version} (lock) — node_modules src = packages/${dir}/src`, () => {
            const installed = path.join(BACKEND, 'node_modules', ...name.split('/'), 'src');
            expect(fs.existsSync(installed), `${installed} — run npm ci in backend`).to.equal(true);
            const installedVersion = JSON.parse(fs.readFileSync(path.join(installed, '..', 'package.json'), 'utf8')).version;
            const diff = srcDiff(installed, path.join(PACKAGES, dir, 'src'));
            expect(diff, `packages/${dir} изменён, а версия в lock старая (lock ${name}@${version}, установлено ${installedVersion}) — опубликуйте и обновите lock (затем npm ci):\n  ${diff.join('\n  ')}`)
                .to.deep.equal([]);
        });
    }
});
