// ======================================================
// STAGE 96 — DATA_ROOT configuration contract
// ======================================================
// План Stage 95 §2.2 (шаг S1): единая точка настройки корня данных
// в config/runtime-config.js.
//
// Гарантии, которые фиксируют тесты:
//   1. без переменных окружения — прежние дефолты байт-в-байт:
//      OUTPUT_DIR=/data/output, BOOKS_DIR=/data/books (эти контейнерные
//      пути являются негласным контрактом с сохранёнными строками
//      PG scene_assets.path и Redis animastor:assets:* — менять их
//      в Stage 96 запрещено);
//   2. DATA_ROOT задаёт общий корень: <root>/books и <root>/output;
//   3. явный BOOKS_DIR / OUTPUT_DIR имеет приоритет над вычислением;
//   4. старые конфигурации (только BOOKS_DIR и/или только OUTPUT_DIR)
//      ведут себя как до Stage 96;
//   5. production-код больше не дублирует дефолты локальными
//      fallback-литералами (проверка исходников).
//
// Окружение и require-кэш восстанавливаются в finally — монолитный
// singleton config других тестов не затрагивается.
// ======================================================

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = require.resolve('../src/config/runtime-config');
const CWD = path.resolve(__dirname, '..');
const ENV_KEYS = ['DATA_ROOT', 'BOOKS_DIR', 'OUTPUT_DIR'];

function snapshotEnv() {
    const snap = {};
    for (const k of ENV_KEYS) {
        snap[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    }
    return snap;
}

function restoreEnv(snap) {
    for (const k of ENV_KEYS) {
        if (snap[k] === undefined) delete process.env[k];
        else process.env[k] = snap[k];
    }
}

/**
 * Загружает СВЕЖУЮ копию runtime-config с заданным окружением,
 * восстанавливая и env, и require.cache в finally (синглтон,
 * которым пользуются остальные тесты, не меняется).
 */
function loadConfig(envPatch = {}) {
    const envSnap = snapshotEnv();
    const cacheEntry = require.cache[CONFIG_PATH];
    try {
        for (const k of ENV_KEYS) delete process.env[k];
        for (const [k, v] of Object.entries(envPatch)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = String(v);
        }
        delete require.cache[CONFIG_PATH];
        return require(CONFIG_PATH);
    } finally {
        if (cacheEntry) require.cache[CONFIG_PATH] = cacheEntry;
        else delete require.cache[CONFIG_PATH];
        restoreEnv(envSnap);
    }
}

describe('Stage 96 — DATA_ROOT (runtime-config)', () => {
    describe('1. дефолты без переменных окружения', () => {
        it('без env: DATA_ROOT пуст, пути прежние байт-в-байт', () => {
            const cfg = loadConfig({});
            expect(cfg.DATA_ROOT).to.equal('');
            expect(cfg.OUTPUT_DIR).to.equal('/data/output');
            expect(cfg.BOOKS_DIR).to.equal('/data/books');
        });

        it('пустые/шумные DATA_ROOT игнорируются → прежние дефолты', () => {
            for (const bad of ['', '   ', '\t', undefined]) {
                const cfg = loadConfig({ DATA_ROOT: bad });
                expect(cfg.OUTPUT_DIR, `DATA_ROOT=${JSON.stringify(bad)}`).to.equal('/data/output');
                expect(cfg.BOOKS_DIR, `DATA_ROOT=${JSON.stringify(bad)}`).to.equal('/data/books');
            }
        });
    });

    describe('2. DATA_ROOT как общий корень', () => {
        it('вычисляет <root>/books и <root>/output', () => {
            const cfg = loadConfig({ DATA_ROOT: '/srv/animastor-data' });
            expect(cfg.DATA_ROOT).to.equal('/srv/animastor-data');
            expect(cfg.BOOKS_DIR).to.equal('/srv/animastor-data/books');
            expect(cfg.OUTPUT_DIR).to.equal('/srv/animastor-data/output');
        });

        it('хвостовые слэши нормализуются без изменения семантики', () => {
            const cfg = loadConfig({ DATA_ROOT: '/srv/animastor-data/' });
            expect(cfg.DATA_ROOT).to.equal('/srv/animastor-data');
            expect(cfg.BOOKS_DIR).to.equal('/srv/animastor-data/books');
            expect(cfg.OUTPUT_DIR).to.equal('/srv/animastor-data/output');
        });

        it('невалидные значения (относительный путь, "/") считаются пустыми', () => {
            for (const bad of ['data/books', './data', '/', '//', 'srv/data']) {
                const cfg = loadConfig({ DATA_ROOT: bad });
                expect(cfg.OUTPUT_DIR, `DATA_ROOT=${JSON.stringify(bad)}`).to.equal('/data/output');
                expect(cfg.BOOKS_DIR, `DATA_ROOT=${JSON.stringify(bad)}`).to.equal('/data/books');
            }
        });
    });

    describe('3. приоритет явных BOOKS_DIR / OUTPUT_DIR', () => {
        it('явный OUTPUT_DIR выше вычисления из DATA_ROOT', () => {
            const cfg = loadConfig({ DATA_ROOT: '/srv/animastor-data', OUTPUT_DIR: '/custom/output' });
            expect(cfg.OUTPUT_DIR).to.equal('/custom/output');
            expect(cfg.BOOKS_DIR).to.equal('/srv/animastor-data/books');
        });

        it('явный BOOKS_DIR выше вычисления из DATA_ROOT', () => {
            const cfg = loadConfig({ DATA_ROOT: '/srv/animastor-data', BOOKS_DIR: '/custom/books' });
            expect(cfg.BOOKS_DIR).to.equal('/custom/books');
            expect(cfg.OUTPUT_DIR).to.equal('/srv/animastor-data/output');
        });

        it('оба явных — оба выше DATA_ROOT', () => {
            const cfg = loadConfig({
                DATA_ROOT: '/srv/animastor-data',
                BOOKS_DIR: '/custom/books',
                OUTPUT_DIR: '/custom/output',
            });
            expect(cfg.BOOKS_DIR).to.equal('/custom/books');
            expect(cfg.OUTPUT_DIR).to.equal('/custom/output');
        });
    });

    describe('4. обратная совместимость старых конфигураций', () => {
        it('только OUTPUT_DIR (старый стиль): BOOKS_DIR остаётся дефолтом', () => {
            const cfg = loadConfig({ OUTPUT_DIR: '/mnt/legacy/output' });
            expect(cfg.OUTPUT_DIR).to.equal('/mnt/legacy/output');
            expect(cfg.BOOKS_DIR).to.equal('/data/books');
        });

        it('только BOOKS_DIR (старый стиль): OUTPUT_DIR остаётся дефолтом', () => {
            const cfg = loadConfig({ BOOKS_DIR: '/mnt/legacy/books' });
            expect(cfg.BOOKS_DIR).to.equal('/mnt/legacy/books');
            expect(cfg.OUTPUT_DIR).to.equal('/data/output');
        });

        it('оба явных заданы (текущая production-конфигурация) — значения не меняются', () => {
            const cfg = loadConfig({ BOOKS_DIR: '/data/books', OUTPUT_DIR: '/data/output' });
            expect(cfg.BOOKS_DIR).to.equal('/data/books');
            expect(cfg.OUTPUT_DIR).to.equal('/data/output');
            expect(cfg.DATA_ROOT).to.equal('');
        });

        it('пустая строка в явной переменной не отменяет дефолт (как до Stage 96)', () => {
            const cfg = loadConfig({ BOOKS_DIR: '', OUTPUT_DIR: '' });
            expect(cfg.BOOKS_DIR).to.equal('/data/books');
            expect(cfg.OUTPUT_DIR).to.equal('/data/output');
        });
    });

    describe('6. контейнерные пути PG/Redis сохранены', () => {
        it('дефолтные пути — ровно те строки, что хранятся в PG/Redis', () => {
            // PG scene_assets.path содержит '/data/output/…', legacy-реестр
            // Redis animastor:assets:* — 'canonical=/data/output/…';
            // code читает их через fs.access/fs.existsSync. Менять значения
            // без отдельного этапа нормализации нельзя.
            const cfg = loadConfig({});
            expect(cfg.OUTPUT_DIR).to.equal('/data/output');
            expect(cfg.BOOKS_DIR).to.equal('/data/books');
        });
    });

    describe('5. backend: локальные fallback-литералы устранены', () => {
        const read = (rel) => fs.readFileSync(path.join(CWD, rel), 'utf8');

        it('backend.cjs: artifactRoot без локального дефолта', () => {
            const src = read('src/backend.cjs');
            expect(src).to.include('artifactRoot: () => config.OUTPUT_DIR,');
            expect(src).to.not.match(/artifactRoot: \(\) => config\.OUTPUT_DIR \|\|/);
        });

        it('task-handler.cjs: snapshot-путь только из config.BOOKS_DIR', () => {
            const src = read('src/services/task-handler.cjs');
            expect(src).to.not.include("config.BOOKS_DIR || '/data/books'");
            expect((src.match(/path\.join\(config\.BOOKS_DIR,/g) || []).length).to.equal(2);
        });

        it('book-deletion.cjs: snapshot-путь только из config.BOOKS_DIR', () => {
            const src = read('src/services/book-deletion.cjs');
            expect(src).to.not.include("config.BOOKS_DIR || '/data/books'");
            expect(src).to.include('path.join(config.BOOKS_DIR,');
        });
    });
});
