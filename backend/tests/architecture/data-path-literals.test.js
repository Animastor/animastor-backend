// ======================================================
// STAGE 96 — DATA-PATH LITERALS GATE (grep-гейт Stage 95 §3, S4)
// ======================================================
// Статический запрет на literals '/data/books' и '/data/output'
// вне разрешённых мест. Разрешённый список — дословно из плана
// Stage 95 §3 (S4) плюс backend/scripts/audit-* (Stage 96, Этап 3:
// аудит-скрипты намеренно не менялись — для runtime они не требуются).
//
// Сканируются исходники монорепо (node_modules/dist/build не входят).
// ======================================================

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const PATTERNS = ['/data/books', '/data/output'];

const SCAN_ROOTS = [
    'backend',
    'packages',
    'docker',
    'scripts',
    'frontends',
    'proxy',
    'backups',
    'docker-compose.yml',
];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.cache']);

const EXTENSIONS = new Set([
    '.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx',
    '.json', '.yml', '.yaml', '.sh', '.md', '.sql',
]);

// Разрешённые места (Stage 95 §3 S4 + audit-скрипты + тесты Stage 96)
const ALLOWED = [
    /^backend\/src\/config\/runtime-config\.js$/,   // владелец дефолта
    /^backend\/tests\//,                            // стабы/тесты
    /^backend\/scripts\/audit-/,                    // аудит-скрипты (не менялись)
    /^packages\/[^/]+\/test\//,                     // пакетные тесты (Stage 96)
    /^packages\/animastor-vbook-runtime\/src\/index\.js$/,  // комментарии
    /^packages\/animastor-vbook-runtime\/README\.md$/,      // пример API
    /^docker-compose\.yml$/,                        // deploy-конфиг (запрещён к правке)
    /^docker\/compose\//,                           // deploy-конфиг (запрещён к правке)
    /^backups\//,                                   // архивы снапшотов
];

function walk(absPath, out) {
    const st = fs.statSync(absPath);
    if (st.isDirectory()) {
        const name = path.basename(absPath);
        if (SKIP_DIRS.has(name)) return;
        for (const entry of fs.readdirSync(absPath)) {
            walk(path.join(absPath, entry), out);
        }
        return;
    }
    if (!EXTENSIONS.has(path.extname(absPath))) return;
    const rel = path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
    let content;
    try {
        content = fs.readFileSync(absPath, 'utf8');
    } catch (_) {
        return;
    }
    for (const pat of PATTERNS) {
        if (content.includes(pat)) out.push({ file: rel, pattern: pat });
    }
}

function scan() {
    const hits = [];
    for (const root of SCAN_ROOTS) {
        const abs = path.join(REPO_ROOT, root);
        if (fs.existsSync(abs)) walk(abs, hits);
    }
    return hits;
}

describe('Stage 96 — grep-гейт литералов data-путей', () => {
    let hits;

    before(() => {
        hits = scan();
    });

    it('все литералы находятся в разрешённых местах (Stage 95 §3 S4)', () => {
        const offenders = hits
            .filter((h) => !ALLOWED.some((re) => re.test(h.file)))
            .map((h) => `${h.file} → ${h.pattern}`);
        expect(offenders, 'литерал вне whitelist').to.deep.equal([]);
    });

    it('orchestration-src не содержит литералов (4 сайта закрыты)', () => {
        const orch = hits.filter((h) =>
            h.file.startsWith('packages/animastor-orchestration/') &&
            !ALLOWED.some((re) => re.test(h.file))
        );
        expect(orch, 'orchestration должен ходить через artifactRoot-шов').to.deep.equal([]);
    });

    it('backend/src: единственный владелец дефолта — runtime-config', () => {
        const srcHits = [...new Set(
            hits.filter((h) => h.file.startsWith('backend/src/')).map((h) => h.file)
        )];
        expect(srcHits).to.deep.equal(['backend/src/config/runtime-config.js']);
    });

    it('composition root вяжет artifactRoot без локального fallback', () => {
        const src = fs.readFileSync(path.join(REPO_ROOT, 'backend/src/backend.cjs'), 'utf8');
        expect(src).to.include('artifactRoot: () => config.OUTPUT_DIR,');
        expect(src).to.not.match(/\|\| '\/data\/output'/);
    });

    it('snapshot-фолбэки backend-сервисов устранены', () => {
        for (const rel of [
            'backend/src/services/task-handler.cjs',
            'backend/src/services/book-deletion.cjs',
        ]) {
            const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
            expect(src, rel).to.not.include("|| '/data/books'");
        }
    });

    it('нормализация: гейт действительно сканирует ожидаемые зоны', () => {
        // Защита от «пустого» гейта: владельцу дефолта позволено
        // содержать литералы — значит, скан находит хотя бы его.
        expect(hits.length, 'скан ничего не нашёл — гейт деградировал').to.be.greaterThan(0);
        const runtimeOwner = hits.filter((h) => h.file === 'backend/src/config/runtime-config.js');
        expect(runtimeOwner.length).to.be.greaterThan(0);
    });
});
