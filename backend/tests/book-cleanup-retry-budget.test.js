'use strict';
// ════════════════════════════════════════════════════════════════════
//  DELETE /book (and DELETE /book/:id/cache) must not leak retry budgets
// ════════════════════════════════════════════════════════════════════
//  reports/2026-11-05/release-L.md §6: after the task-L prod smoke, the
//  standard DELETE /book left `animastor:retry-budget:{book}:{ch}:{sc}:audio`
//  with TTL -1 (orchestration retry-budget-manager writes the per-scene key
//  without a TTL, and cleanBookRedisKeys had no pattern for it). Both callers
//  (services/book-deletion.cjs, routes/book/cache-routes.cjs) go through
//  cleanBookRedisKeys, so the helper is pinned here:
//   - this book's per-scene/stage budgets are deleted;
//   - another book's budgets (including a book whose id is a prefix) stay;
//   - the global / type:{t} / worker:{id} aggregates stay, even when the book
//     id is literally "type" or "worker";
//   - the book id is glob-escaped in the MATCH pattern.

const { expect } = require('chai');
const { createMockRedis } = require('./mocks/redis-mock');

const BOOK = 'new_book_1793873878331';
const budgetKey = (book, ch, sc, stage) => `animastor:retry-budget:${book}:${ch}:${sc}:${stage}`;

describe('cleanBookRedisKeys — retry-budget keys (task L follow-up)', () => {
    let redis;
    let helpers;
    let patterns;

    beforeEach(() => {
        redis = createMockRedis();
        patterns = [];
        const originalScan = redis.scan;
        redis.scan = async (cursor, ...args) => {
            const i = args.indexOf('MATCH');
            if (i !== -1) patterns.push(args[i + 1]);
            return originalScan.call(redis, cursor, ...args);
        };
        helpers = require('../src/helpers/redis-helpers.cjs')(redis, {});
    });

    it("deletes this book's per-scene/stage budgets and nothing else", async () => {
        await redis.set(budgetKey(BOOK, 'ch-aa09235d', 'sc-00fe9bc7', 'audio'), '9');
        await redis.set(budgetKey(BOOK, 'ch-aa09235d', 'sc-00fe9bc7', 'image'), '3');
        await redis.set(budgetKey(BOOK, 'ch-2', 'sc-2', 'video'), '0');
        // a book whose id starts with BOOK, and an unrelated book
        await redis.set(budgetKey(`${BOOK}9`, 'ch-x', 'sc-x', 'audio'), '7');
        await redis.set(budgetKey('ba_1788172242081', 'ch-y', 'sc-y', 'audio'), '5');
        // aggregates
        await redis.set('animastor:retry-budget:global', '99', 'EX', 60);
        await redis.set('animastor:retry-budget:type:transient', '49', 'EX', 300);
        await redis.set('animastor:retry-budget:worker:f7dcbda1-0000', '19', 'EX', 60);

        await helpers.cleanBookRedisKeys(redis, BOOK);

        expect(await redis.get(budgetKey(BOOK, 'ch-aa09235d', 'sc-00fe9bc7', 'audio'))).to.equal(null);
        expect(await redis.get(budgetKey(BOOK, 'ch-aa09235d', 'sc-00fe9bc7', 'image'))).to.equal(null);
        expect(await redis.get(budgetKey(BOOK, 'ch-2', 'sc-2', 'video'))).to.equal(null);

        expect(await redis.get(budgetKey(`${BOOK}9`, 'ch-x', 'sc-x', 'audio'))).to.equal('7');
        expect(await redis.get(budgetKey('ba_1788172242081', 'ch-y', 'sc-y', 'audio'))).to.equal('5');
        expect(await redis.get('animastor:retry-budget:global')).to.equal('99');
        expect(await redis.get('animastor:retry-budget:type:transient')).to.equal('49');
        expect(await redis.get('animastor:retry-budget:worker:f7dcbda1-0000')).to.equal('19');
    });

    it('a book id equal to "type" / "worker" / "global" never reaches the aggregates', async () => {
        await redis.set('animastor:retry-budget:global', '99');
        await redis.set('animastor:retry-budget:type:transient', '49');
        await redis.set('animastor:retry-budget:worker:w-1', '19');

        for (const id of ['type', 'worker', 'global']) {
            await helpers.cleanBookRedisKeys(redis, id);
        }

        expect(await redis.get('animastor:retry-budget:global')).to.equal('99');
        expect(await redis.get('animastor:retry-budget:type:transient')).to.equal('49');
        expect(await redis.get('animastor:retry-budget:worker:w-1')).to.equal('19');
    });

    it('the retry-budget MATCH pattern is glob-escaped and anchored to 3 segments', async () => {
        await helpers.cleanBookRedisKeys(redis, BOOK);
        await helpers.cleanBookRedisKeys(redis, 'a*b?[c]');
        const rb = patterns.filter((p) => String(p).startsWith('animastor:retry-budget:'));
        expect(rb).to.include(`animastor:retry-budget:${BOOK}:*:*:*`);
        expect(rb).to.include('animastor:retry-budget:a\\*b\\?\\[c\\]:*:*:*');
    });
});
