'use strict';

// VOICE_REFERENCES.md — voice reference service (no PG / no GPU)

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vr = require('../src/audio/voice-references');
const { clearBuildDirKeepingVoices } = require('../src/utils/build-dir');
const generation = require('../src/audio/generation');
const { lockReference, toneWav } = require('./helpers/voice-reference-fixture');
const PHRASES = require('../ai/voice-reference-phrases.json');

function withInfo(buf, meta) {
    const text = Buffer.concat([Buffer.from(JSON.stringify(meta), 'utf8'), Buffer.from([0])]);
    const t2 = text.length % 2 ? Buffer.concat([text, Buffer.from([0])]) : text;
    const icmt = Buffer.concat([Buffer.from('ICMT'), Buffer.from(Uint32Array.of(t2.length).buffer), t2]);
    const body = Buffer.concat([Buffer.from('INFO'), icmt]);
    const out = Buffer.concat([buf, Buffer.from('LIST'), Buffer.from(Uint32Array.of(body.length).buffer), body]);
    out.writeUInt32LE(out.length - 8, 4);
    return out;
}

describe('voice references — strict transcript comparison (policy v1)', () => {
    it('normalises NFC, case, ё→е, punctuation, whitespace', () => {
        expect(vr.normaliseTranscript('  Ёлка, «зелёная»!\n Да…  ')).to.equal('елка зеленая да');
        expect(vr.normaliseTranscript('STRASSE straße')).to.equal('strasse strasse');
        expect(vr.normaliseTranscript('é')).to.equal(vr.normaliseTranscript('é'));   // NFD vs NFC
    });
    it('is strict: one different / missing / extra word fails', () => {
        const p = PHRASES.ru.conversational.text;
        expect(vr.compareTranscript(p, p.toUpperCase()).passed).to.equal(true);
        expect(vr.compareTranscript(p, p.replace('окна', 'двери')).passed).to.equal(false);
        expect(vr.compareTranscript(p, p.split(' ').slice(1).join(' ')).passed).to.equal(false);
        expect(vr.compareTranscript(p, `${p} да`).passed).to.equal(false);
        expect(vr.compareTranscript('', '').passed).to.equal(false);
        expect(vr.compareTranscript(p, p).policy_version).to.equal(vr.COMPARISON_POLICY_VERSION);
    });
    it('template phrases: ru / en / de, both styles, no digits', () => {
        for (const lang of ['ru', 'en', 'de']) {
            for (const style of ['narrative', 'conversational']) {
                const ph = PHRASES[lang][style];
                expect(ph.text, `${lang}/${style}`).to.match(/\S/);
                expect(ph.text, `${lang}/${style} digits`).to.not.match(/\d/);
                expect(ph.id).to.be.a('string');
                expect(ph.version).to.be.a('number');
            }
        }
    });
    it('narrator → narrative phrase, character → conversational; unsupported language → 409', () => {
        const book = { book: { language: 'de' } };
        expect(vr.phraseForVoice(book, 'narrator')).to.include({ style: 'narrative', language: 'German', id: 'de-narrative-1' });
        expect(vr.phraseForVoice(book, 'anna')).to.include({ style: 'conversational', language: 'German' });
        expect(() => vr.phraseForVoice({ book: { language: 'xx' } }, 'anna')).to.throw().with.property('code', 'voice_reference_language_unsupported');
    });
});

describe('voice references — WAV, paths, sha256, status', () => {
    let out;
    beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'vref-')); });
    afterEach(() => { fs.rmSync(out, { recursive: true, force: true }); });

    it('canonicalWav keeps fmt + data only; parseWavMeta reads the RIFF JSON', () => {
        const raw = withInfo(toneWav(1), { asr_transcript: 'привет', words: [] });
        expect(vr.parseWavMeta(raw).asr_transcript).to.equal('привет');
        const c = vr.canonicalWav(raw);
        expect(vr.parseWavMeta(c.buffer)).to.equal(null);
        expect(c.buffer.equals(toneWav(1))).to.equal(true);
        expect(c.fmt).to.deep.equal({ format: 1, channels: 1, sampleRate: 24000, bitsPerSample: 16 });
    });

    it('storage paths live under build_<id>/voices/<id>/; links outside voices/ are rejected', () => {
        const p = vr.createPaths(out);
        expect(p.candidateWav('build_b', 'anna', 'c1')).to.equal(path.join(out, 'build_b', 'voices', 'anna', 'c1.wav'));
        expect(p.relativeFile('anna', 'c1')).to.equal('voices/anna/c1.wav');
        expect(() => p.resolveLink('build_b', '../secret.wav')).to.throw().with.property('code', 'bad_reference');
        expect(() => p.candidateWav('build_b', '../x', 'c1')).to.throw().with.property('code', 'bad_request');
    });

    it('referenceStatus: missing / unlocked / file_missing / sha_mismatch / ok; requireReferences lists all', () => {
        const svc = vr.createVoiceReferences({ outputDir: out });
        const book = { manifest: { build_id: 'build_b' }, voices: { narrator: { timbre: 't' }, anna: { timbre: 'a' } } };
        expect(svc.referenceStatus(book, 'narrator').status).to.equal('missing');
        const ref = lockReference(book, out, 'narrator');
        expect(svc.referenceStatus(book, 'narrator').status).to.equal('ok');
        expect(svc.referenceInput(book, 'narrator')).to.include({ name: ref.name, sha256: ref.sha256, path: ref.path });
        book.voices.narrator.reference.locked = false;
        expect(svc.referenceStatus(book, 'narrator').status).to.equal('unlocked');
        book.voices.narrator.reference.locked = true;
        fs.appendFileSync(ref.path, 'x');
        expect(svc.referenceStatus(book, 'narrator').status).to.equal('sha_mismatch');
        fs.unlinkSync(ref.path);
        expect(svc.referenceStatus(book, 'narrator').status).to.equal('file_missing');
        expect(() => svc.requireReferences(book, ['narrator', 'anna', 'anna'])).to.throw().that.satisfies((e) =>
            e.status === 409 && e.code === 'voice_reference_required'
            && JSON.stringify(e.details) === JSON.stringify({ character_ids: ['narrator', 'anna'], reasons: { narrator: 'file_missing', anna: 'missing' } }));
    });

    it('designed candidate: duration bounds and transcript decide verification; select needs passed', () => {
        const svc = vr.createVoiceReferences({ outputDir: out });
        const book = { manifest: { build_id: 'build_b' }, book: { language: 'ru' }, voices: { anna: { timbre: 'Warm.' } } };
        const provider = require('@animastor/generation').comfyuiProvider;
        const units = svc.planCandidates(book, 'b', { mode: 'design', character_ids: ['anna'], count: 2 }, { ...provider, assembleVoiceReferenceWorkflow: (spec) => ({ spec }) });
        expect(units).to.have.length(2);
        const phrase = PHRASES.ru.conversational.text;
        const place = (u, buf) => {
            const p = svc.paths.candidateWav('build_b', 'anna', u.unit_key);
            fs.writeFileSync(p, buf);
            return svc.onCandidatePlaced({ book_id: 'b', build_id: 'build_b', scene_id: 'anna', unit_key: u.unit_key, job_id: 'j' }, p);
        };
        const short = place(units[0], withInfo(toneWav(2), { asr_transcript: phrase }));
        expect(short.verification).to.equal('failed');
        expect(short.verification_problems).to.deep.equal(['too_short']);
        const good = place(units[1], withInfo(toneWav(8), { asr_transcript: phrase, words: [{ w: 'a', start: 0, end: 1, p: 1 }] }));
        expect(good).to.include({ verification: 'passed', transcript_match: true, seed: good.seed, phrase_version: 1 });
        expect(good.words).to.have.length(1);
        expect(() => svc.selectCandidate(book, 'anna', units[0].unit_key)).to.throw().with.property('code', 'candidate_not_verified');
        const ref = svc.selectCandidate(book, 'anna', units[1].unit_key);
        expect(ref).to.include({ ref_text: phrase, locked: true, verification: 'passed', source: 'designed', sha256: good.sha256 });
    });

    it('uploaded sample: stored under uploads/, transcribe job with input file, ref_text = ASR proposal or the user text', () => {
        const svc = vr.createVoiceReferences({ outputDir: out });
        const book = { manifest: { build_id: 'build_b' }, book: { language: 'ru' }, voices: { anna: { timbre: 'Warm.' } } };
        expect(() => svc.storeUpload(book, 'anna', Buffer.from('x'), 'text/plain')).to.throw().with.property('status', 415);
        const scope = svc.storeUpload(book, 'anna', toneWav(6), 'audio/wav');
        expect(scope.upload.file).to.match(/^voices\/anna\/uploads\/c[0-9a-z]+\.wav$/);
        const provider = require('@animastor/generation').comfyuiProvider;
        const units = svc.planCandidates(book, 'b', scope, { ...provider, assembleVoiceTranscribeWorkflow: (spec) => ({ spec }) });
        expect(units).to.have.length(1);
        const files = svc.jobInputFiles({ build_id: 'build_b', input: units[0].input });
        expect(files[0].name).to.equal(`vupl_${scope.upload.sha256.slice(0, 32)}.wav`);
        expect(fs.existsSync(files[0].path)).to.equal(true);
        const p = svc.paths.candidateWav('build_b', 'anna', scope.candidate_id);
        fs.writeFileSync(p, withInfo(toneWav(6), { asr_transcript: 'Слова из образца.' }));
        const c = svc.onCandidatePlaced({ book_id: 'b', build_id: 'build_b', scene_id: 'anna', unit_key: scope.candidate_id, job_id: 'j' }, p);
        expect(c).to.include({ source: 'uploaded', ref_text: 'Слова из образца.', ref_text_source: 'asr', verification: 'passed' });
        const ref = svc.selectCandidate(book, 'anna', scope.candidate_id, { refText: 'Слова из образца, исправленные.' });
        expect(ref).to.include({ source: 'uploaded', ref_text: 'Слова из образца, исправленные.', seed: null, model: null });
    });

    it('«Очистить кэш» helper removes generated content but keeps voices/', () => {
        const b = path.join(out, 'build_b');
        fs.mkdirSync(path.join(b, 'voices', 'anna'), { recursive: true });
        fs.writeFileSync(path.join(b, 'voices', 'anna', 'c1.wav'), 'w');
        fs.writeFileSync(path.join(b, 'scene.mp3'), 'x');
        fs.mkdirSync(path.join(b, '.incoming'));
        expect(clearBuildDirKeepingVoices(b)).to.deep.equal({ removed: 2, kept: ['voices'] });
        expect(fs.readdirSync(b)).to.deep.equal(['voices']);
        fs.rmSync(path.join(b, 'voices'), { recursive: true });
        clearBuildDirKeepingVoices(b);
        expect(fs.existsSync(b)).to.equal(false);
    });
});

describe('voices of a scene (generation.js)', () => {
    const book = { voices: { narrator: { timbre: 'n' }, anna: { timbre: 'a' } }, book: { defaults: {} } };
    it('characters with a voice entry use their voice; episodic speakers and narration → narrator', () => {
        const segs = [
            { segment_type: 'narration', text: 'Текст.' },
            { segment_type: 'dialogue', text: 'anna: Привет.' },
            { segment_type: 'dialogue', text: 'женщина в будочке: Нет.' },
        ];
        expect(generation.requiredVoiceIds(segs, { payload: {} }, book).sort()).to.deep.equal(['anna', 'narrator']);
        expect(generation.voiceIdForSpeaker('женщина в будочке', { payload: {} }, book)).to.equal('narrator');
        expect(generation.voiceIdForSpeaker('anna', { payload: {} }, book)).to.equal('anna');
    });
});
