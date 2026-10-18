const { query } = require('../../src/storage/postgres/database');

const GUEST_WS_NAME = 'Guest workspace';

async function captureGuestWorkspaceBaseline() {
    const ws = await query(`SELECT id FROM workspaces WHERE name = $1`, [GUEST_WS_NAME]);
    const guests = await query(`SELECT count(*)::int AS n FROM guests`);
    return { wsIds: new Set(ws.rows.map((r) => r.id)), guestCount: guests.rows[0].n };
}

async function teardownGuestWorkspaces(baseline, opts = {}) {
    const assertGuestCount = opts.assertGuestCount !== false;
    if (!baseline) return { removed: 0, ids: [] };
    const current = await query(`SELECT id FROM workspaces WHERE name = $1`, [GUEST_WS_NAME]);
    const created = current.rows.map((r) => r.id).filter((id) => !baseline.wsIds.has(id));
    let removed = 0;
    if (created.length > 0) {
        const res = await query(
            `DELETE FROM workspaces WHERE name = $1 AND id = ANY($2)`,
            [GUEST_WS_NAME, created]
        );
        removed = res.rowCount || 0;
        console.log(`[PG-TEARDOWN] removed ${removed} auto-provisioned guest workspace(s): ${created.join(', ')}`);
    }
    const leftover = await query(
        `SELECT count(*)::int AS n FROM workspaces WHERE name = $1 AND id = ANY($2)`,
        [GUEST_WS_NAME, created]
    );
    if (leftover.rows[0].n !== 0) {
        throw new Error(`guest-workspace teardown left ${leftover.rows[0].n} of ${created.length} row(s)`);
    }
    if (assertGuestCount) {
        const guests = await query(`SELECT count(*)::int AS n FROM guests`);
        if (guests.rows[0].n !== baseline.guestCount) {
            throw new Error(`guests count ${guests.rows[0].n} != baseline ${baseline.guestCount}`);
        }
        const ws = await query(`SELECT count(*)::int AS n FROM workspaces WHERE name = $1`, [GUEST_WS_NAME]);
        if (ws.rows[0].n !== baseline.wsIds.size) {
            throw new Error(`guest workspaces count ${ws.rows[0].n} != baseline ${baseline.wsIds.size}`);
        }
    }
    return { removed, ids: created };
}

module.exports = { captureGuestWorkspaceBaseline, teardownGuestWorkspaces, GUEST_WS_NAME };
