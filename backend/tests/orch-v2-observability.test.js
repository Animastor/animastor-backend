'use strict';
// О3 (reports/2026-11-07/orch-v2-image-scene-run.md): the v2 host wiring is observable.
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

describe('О3 — orchestration v2 host observability', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'orchestration-v2', 'index.js'), 'utf8');

    it('NOTIFY→SSE errors are warned, not swallowed by an empty catch', () => {
        expect(src).to.not.match(/onNotify\([^;]*\.catch\(\(\) => \{\}\)/s);
        expect(src).to.include('[ORCH-V2] progress NOTIFY→SSE failed');
    });

    it('the core gets the host logger port (its [gen-v2] info lines reach docker logs)', () => {
        expect(src).to.match(/gen\.createOrchestration\(\{[^}]*logger: console/s);
    });

    it('the core formats [gen-v2] lines without secrets (formatGenEvent is exported)', () => {
        const { gen } = require('@animastor/orchestration');
        if (typeof gen.formatGenEvent !== 'function') {
            throw new Error('needs @animastor/orchestration >= 1.2.0 (publish 1.2.0 + bump the backend dependency)');
        }
        const line = gen.formatGenEvent('claim', { job_id: 'j', attempt: 1, upload_token: 't0ken' });
        expect(line).to.equal('[gen-v2] claim job_id=j attempt=1');
    });
});
