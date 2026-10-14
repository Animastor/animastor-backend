#!/usr/bin/env node
// Orphan-books audit — read-only drift report across every book source of truth.
// Usage: node scripts/audit-orphan-books.js [--strict]
//
//   books / scenes / scene_assets / generation_tasks / image_units / /data/books
//   (SELECT-only + fs listing; no PG/Redis/FS mutation)
//
// Classes:
//   I   books_without_scenes       — derived rows exist but no `scenes` rows
//                                    → absent from listBooks (SELECT DISTINCT book_id FROM scenes)
//   II  scenes_without_books       — `scenes` rows whose books row / disk bundle is gone
//   III disk_books_without_scenes  — canonical bundle registered nowhere in PG
//   IV  null_build_id_duplicates   — scene_assets rows with build_id IS NULL that
//                                    cannot be deduped by the unique constraint
//
// Exit code: 0 (report) by default; 1 when --strict and any class has findings.

const path = require('path');

const BOOKS_DIR = process.env.BOOKS_DIR || '/data/books';
const PASS = '\x1b[32m✓\x1b[0m';
const WARN = '\x1b[33m⚠\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';

function logOk(msg) { console.log(`${PASS} ${msg}`); }
function logWarn(msg) { console.log(`${WARN} ${msg}`); }
function logFail(msg) { console.log(`${FAIL} ${msg}`); }

async function main() {
    const strict = process.argv.includes('--strict');
    const { collectOrphanReport, countIssues } = require('../src/services/orphan-books-audit');
    const { query } = require('../src/storage/postgres/database');

    console.log('## Orphan-books audit (read-only)');
    console.log(`books_dir: ${BOOKS_DIR}`);

    const report = await collectOrphanReport({ booksDir: BOOKS_DIR, query });
    const s = report.stats;

    console.log('\n### stats');
    console.log(`books rows=${s.books_rows}  scenes books=${s.scene_books} rows=${s.scene_rows}  ` +
        `disk bundles=${s.disk_bundles}  scene_assets=${s.scene_assets_total} ` +
        `(null build_id=${s.scene_assets_null_build} in ${s.scene_assets_null_keys} keys, ` +
        `redundant=${s.null_build_redundant_rows})`);

    console.log('\n### I. books without scenes (invisible to listBooks)');
    if (report.booksWithoutScenes.length === 0) {
        logOk('none');
    } else {
        logFail(`${report.booksWithoutScenes.length} book(s)`);
        for (const b of report.booksWithoutScenes) {
            console.log(`    ${b.book_id}  assets=${b.assets} tasks=${b.tasks} iu=${b.image_units} ` +
                `books_row=${b.in_books ? 'yes' : 'no'} disk=${b.on_disk ? 'yes' : 'no'}`);
        }
    }

    console.log('\n### II. scenes rows without a books row');
    if (report.scenesWithoutBooks.length === 0) {
        logOk('none');
    } else {
        logWarn(`${report.scenesWithoutBooks.length} book(s)`);
        for (const b of report.scenesWithoutBooks) {
            console.log(`    ${b.book_id}  scenes=${b.scenes} disk=${b.on_disk ? 'yes' : 'no'}`);
        }
    }

    console.log('\n### III. disk bundles registered nowhere in PG');
    if (report.diskBooksWithoutScenes.length === 0) {
        logOk('none');
    } else {
        logWarn(`${report.diskBooksWithoutScenes.length} bundle(s)`);
        for (const b of report.diskBooksWithoutScenes) console.log(`    ${b.book_id}`);
    }

    console.log('\n### IV. scene_assets NULL build_id duplicates');
    if (report.nullBuildDuplicates.length === 0) {
        logOk('none');
    } else {
        logWarn(`${report.nullBuildDuplicates.length} key(s), ` +
            `${s.null_build_redundant_rows} redundant row(s)`);
        for (const d of report.nullBuildDuplicates.slice(0, 20)) {
            console.log(`    ${d.book_id} ${d.chapter_id}/${d.scene_id} ${d.asset_type} rows=${d.rows}`);
        }
        if (report.nullBuildDuplicates.length > 20) {
            console.log(`    … ${report.nullBuildDuplicates.length - 20} more`);
        }
    }

    const issues = countIssues(report);
    console.log(`\n${issues === 0 ? PASS : FAIL} issues: ${issues}`);
    if (strict && issues > 0) process.exitCode = 1;
}

main()
    .catch(err => {
        console.error(`${FAIL} audit failed: ${err.message}`);
        process.exitCode = 2;
    })
    .finally(() => {
        const database = require(path.join(__dirname, '..', 'src', 'storage', 'postgres', 'database'));
        database.closePool().catch(() => {});
    });
