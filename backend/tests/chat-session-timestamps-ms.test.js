// ======================================================
// ai_chat_sessions — timestamps are epoch ms
// ======================================================
// Every writer stores Date.now() and clients read ms; the table DEFAULT
// used to be epoch seconds. runMigrations switches the DEFAULT to ms and
// upscales rows that got the seconds default (idempotently).

const { expect } = require('chai');
const { query } = require('../src/storage/postgres/database');
const { runMigrations } = require('../src/storage/postgres/schema');

describe('ai_chat_sessions timestamps — epoch ms', () => {
    const ids = [];
    const newId = (tag) => {
        const id = `chat-ts-${tag}-${Date.now()}-${ids.length}`;
        ids.push(id);
        return id;
    };

    before(async () => {
        await runMigrations();
    });

    after(async () => {
        await query('DELETE FROM ai_chat_sessions WHERE id = ANY($1)', [ids]);
    });

    it('a row inserted without created_at/updated_at gets ms (> 1e12)', async () => {
        const id = newId('default');
        await query('INSERT INTO ai_chat_sessions (id, book_id) VALUES ($1, $2)', [id, 'chat-ts-book']);
        const { rows } = await query('SELECT created_at, updated_at FROM ai_chat_sessions WHERE id = $1', [id]);
        expect(Number(rows[0].created_at)).to.be.greaterThan(1e12);
        expect(Number(rows[0].updated_at)).to.be.greaterThan(1e12);
    });

    it('the migration upscales seconds rows once and leaves ms rows alone', async () => {
        const secId = newId('sec');
        const msId = newId('ms');
        const sec = 1790000000;
        const ms = 1790000000123;
        await query(
            'INSERT INTO ai_chat_sessions (id, book_id, created_at, updated_at) VALUES ($1, $3, $2, $2), ($4, $3, $5, $5)',
            [secId, sec, 'chat-ts-book', msId, ms]
        );

        await runMigrations();
        await runMigrations(); // idempotent: second run changes nothing

        const { rows } = await query(
            'SELECT id, created_at, updated_at FROM ai_chat_sessions WHERE id = ANY($1)',
            [[secId, msId]]
        );
        const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
        expect(Number(byId[secId].created_at)).to.equal(sec * 1000);
        expect(Number(byId[secId].updated_at)).to.equal(sec * 1000);
        expect(Number(byId[msId].created_at)).to.equal(ms);
        expect(Number(byId[msId].updated_at)).to.equal(ms);
    });
});
