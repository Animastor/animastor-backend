// ======================================================
// VBook 4 step 3 — audio reads heroes: one layer of reference statuses, TTS text
// ======================================================
// VBOOK_FORMAT_V4 §5.1, §12 step 3:
//   - referenceStatus (backend, eight statuses) is built on the port's
//     referenceState (ok | missing | mismatch) and isReferenceVerified; the
//     backend no longer reads the reference file or compares sha256 itself
//     (owner's decision В9). Consequences of the port's rules: a link into
//     ANOTHER hero's folder (malformed) and a symbolic link (file_missing) are
//     never used;
//   - the text for TTS is join(timbre, manner) — voiceInstruct(hero) — and the
//     audio voice of a speaker comes from the hero file (getCharacterVoice).

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vr = require('../src/audio/voice-references');
const generation = require('../src/audio/generation');
const voicePort = require('@animastor/vbook-runtime/voice');
const { voiceInstruct, narrator } = require('@animastor/vbook-runtime/heroes.cjs');
const { lockReference } = require('./helpers/voice-reference-fixture');

describe('VBook 4 step 3 — audio on heroes', () => {
    let out;
    beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'v4-s3-audio-')); });
    afterEach(() => fs.rmSync(out, { recursive: true, force: true }));

    const book = () => ({
        manifest: { book_id: 'b', build_id: 'build_b' },
        heroes: [
            { schema: 'animastor.character/1', id: 'narrator', role: 'narrator', voice: { timbre: 'A calm male voice.', manner: 'Slow narration.' } },
            { schema: 'animastor.character/1', id: 'anna', name: 'Анна', voice: { timbre: 'A light soprano.', manner: '' } },
            { schema: 'animastor.character/1', id: 'boris', name: 'Борис' },
        ],
    });

    it('the TTS text is join(timbre, manner) of the hero file; empty parts are skipped', () => {
        const b = book();
        expect(voiceInstruct(narrator(b))).to.equal('A calm male voice. Slow narration.');
        expect(voiceInstruct(b.heroes[1])).to.equal('A light soprano.');
        expect(voiceInstruct(b.heroes[2])).to.equal('');
        expect(voicePort.getCharacterVoice(b, 'anna')).to.include({ timbre: 'A light soprano.', manner: '' });
    });

    it('a speaker that is a hero with a voice → that voice; anyone else → the narrator voice of the scene', () => {
        const b = book();
        expect(generation.voiceIdForSpeaker('anna', { scene: {} }, b)).to.equal('anna');
        expect(generation.voiceIdForSpeaker('boris', { scene: {} }, b)).to.equal('narrator');
        expect(generation.voiceIdForSpeaker('женщина в будочке', { scene: {} }, b)).to.equal('narrator');
    });

    describe('referenceStatus is the port\'s referenceState, mapped', () => {
        it('ok / sha_mismatch / file_missing follow referenceState; path and bytes of an ok reference', () => {
            const svc = vr.createVoiceReferences({ outputDir: out });
            const b = book();
            const ref = lockReference(b, out, 'anna');
            const dir = svc.paths.buildDir('build_b');
            const r = voicePort.getCharacterVoice(b, 'anna').reference;
            expect(voicePort.referenceState(dir, r, 'anna')).to.equal('ok');
            const st = svc.referenceStatus(b, 'anna');
            expect(st).to.include({ status: 'ok', path: ref.path, bytes: fs.statSync(ref.path).size });
            fs.appendFileSync(ref.path, 'x');
            expect(voicePort.referenceState(dir, r, 'anna')).to.equal('mismatch');
            expect(svc.referenceStatus(b, 'anna').status).to.equal('sha_mismatch');
            fs.unlinkSync(ref.path);
            expect(voicePort.referenceState(dir, r, 'anna')).to.equal('missing');
            expect(svc.referenceStatus(b, 'anna').status).to.equal('file_missing');
        });

        it('a link into ANOTHER hero\'s folder is refused by the port (malformed), never read as anna\'s file', () => {
            const svc = vr.createVoiceReferences({ outputDir: out });
            const b = book();
            lockReference(b, out, 'narrator');
            const narratorRef = voicePort.getCharacterVoice(b, 'narrator').reference;
            lockReference(b, out, 'anna');
            b.heroes.find((h) => h.id === 'anna').voice.reference = { ...narratorRef };
            expect(svc.referenceStatus(b, 'narrator').status).to.equal('ok');
            expect(svc.referenceStatus(b, 'anna').status).to.equal('malformed');
            // and the port state of that link for anna is "missing" (outside voices/anna/)
            expect(voicePort.referenceState(svc.paths.buildDir('build_b'), narratorRef, 'anna')).to.equal('missing');
        });

        it('a symbolic link in place of the file is not followed → file_missing', () => {
            const svc = vr.createVoiceReferences({ outputDir: out });
            const b = book();
            const ref = lockReference(b, out, 'anna');
            const real = path.join(out, 'elsewhere.wav');
            fs.renameSync(ref.path, real);
            fs.symlinkSync(real, ref.path);
            expect(svc.referenceStatus(b, 'anna').status).to.equal('file_missing');
        });

        it('the reasons synthesis is refused stay: missing_voice, missing, unlocked, not_verified, malformed', () => {
            const svc = vr.createVoiceReferences({ outputDir: out });
            const b = book();
            expect(svc.referenceStatus(b, 'nobody').status).to.equal('missing_voice');
            expect(svc.referenceStatus(b, 'anna').status).to.equal('missing');
            lockReference(b, out, 'anna');
            const v = b.heroes.find((h) => h.id === 'anna').voice;
            v.reference.locked = false;
            expect(svc.referenceStatus(b, 'anna').status).to.equal('unlocked');
            v.reference.locked = true; v.reference.verification = 'failed';
            expect(svc.referenceStatus(b, 'anna').status).to.equal('not_verified');
            v.reference.verification = 'passed'; v.reference.file = '../../etc/passwd';
            expect(svc.referenceStatus(b, 'anna').status).to.equal('malformed');
        });

        it('voice-references.js reads no reference file and computes no sha256 for the status', () => {
            const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'audio', 'voice-references.js'), 'utf8');
            const body = src.slice(src.indexOf('function referenceStatus('), src.indexOf('function referenceInput('));
            expect(body).to.include('voicePort.referenceState(');
            expect(body).to.not.match(/readFileSync|sha256\(|createHash/);
        });
    });
});
