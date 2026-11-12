// Test helper (VOICE_REFERENCES.md): a LOCKED, verified voice reference for a
// fixture book — a real canonical WAV (pcm_s16le mono 24 kHz) in the content
// folder OUTPUT_DIR/<build_id>/voices/<id>/<cand>.wav + the voices.json link.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REF_TEXT = 'Вечер опускался на город медленно и тихо.';

function toneWav(seconds = 5, rate = 24000) {
    const n = Math.round(seconds * rate);
    const data = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) data.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 180 * i) / rate)), i * 2);
    const fmt = Buffer.alloc(16);
    fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(rate, 4);
    fmt.writeUInt32LE(rate * 2, 8); fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);
    const chunk = (id, b) => Buffer.concat([Buffer.from(id, 'latin1'), Buffer.from(Uint32Array.of(b.length).buffer), b]);
    const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', data)]);
    return Buffer.concat([Buffer.from('RIFF'), Buffer.from(Uint32Array.of(body.length).buffer), body]);
}

/**
 * Write the reference file and set book.voices[voiceId] = {timbre, manner, reference}.
 * @returns {{path:string, sha256:string, name:string}}
 */
function lockReference(book, outputDir, voiceId = 'narrator', { candidateId = 'cfix', refText = REF_TEXT } = {}) {
    const buildId = book.manifest.build_id;
    const rel = `voices/${voiceId}/${candidateId}.wav`;
    const abs = path.join(outputDir, buildId, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const buf = toneWav();
    fs.writeFileSync(abs, buf);
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    book.voices = book.voices || {};
    book.voices[voiceId] = {
        timbre: 'Calm male voice.', manner: voiceId === 'narrator' ? 'Slow narration.' : '', timbre_source: 'user',
        reference: { file: rel, ref_text: refText, source: 'designed', model: 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign', seed: 1, sha256, verification: 'passed', locked: true, candidate_id: candidateId },
    };
    return { path: abs, sha256, name: `vref_${sha256.slice(0, 32)}.wav` };
}

module.exports = { lockReference, toneWav, REF_TEXT };
