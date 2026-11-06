// ======================================================
// gen/validate-media — default result validators (ADR §7 п.1, §13.4)
// ======================================================
// Audio: MP3 magic bytes (ID3v2 tag or MPEG Layer III frame sync), duration
// > 0 from the frame headers, and NOT silence — RMS of the decoded PCM above
// a threshold (parameter, dBFS). Image: PNG signature. Video: MP4 `ftyp` box.
//
// PCM decoding is injected (`decodePcm(path) → Int16Array`); the default
// spawns the `ffmpeg` binary (node builtin child_process, no npm dependency).
// Fail-closed: no decoder → the result is NOT accepted (reason
// decoder_unavailable) — «тишина = ready» must never come back.

'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

const DEFAULT_RMS_THRESHOLD_DBFS = -50;
const MIN_AUDIO_BYTES = 256;

// MPEG audio tables (Layer III only)
const BITRATES_KBPS = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

/** Parse one MPEG Layer III frame header at buf[off]. @returns {{len:number, samples:number, sr:number}|null} */
function parseFrameHeader(buf, off) {
    if (off + 4 > buf.length) return null;
    const b1 = buf[off + 1], b2 = buf[off + 2];
    if (buf[off] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
    const verBits = (b1 >> 3) & 0x03;            // 00 = 2.5, 10 = 2, 11 = 1
    const layerBits = (b1 >> 1) & 0x03;          // 01 = Layer III
    if (verBits === 0x01 || layerBits !== 0x01) return null;
    const version = verBits === 0x03 ? 1 : verBits === 0x02 ? 2 : 25;
    const brIdx = (b2 >> 4) & 0x0f;
    const srIdx = (b2 >> 2) & 0x03;
    if (brIdx === 0 || brIdx === 0x0f || srIdx === 0x03) return null;
    const padding = (b2 >> 1) & 0x01;
    const bitrate = BITRATES_KBPS[version === 1 ? 1 : 2][brIdx] * 1000;
    const sr = SAMPLE_RATES[version][srIdx];
    const coef = version === 1 ? 144 : 72;
    const len = Math.floor((coef * bitrate) / sr) + padding;
    return { len, samples: version === 1 ? 1152 : 576, sr };
}

/**
 * Inspect an MP3 buffer: magic + frame walk.
 * @returns {{ok:true, durationSec:number, frames:number}|{ok:false, reason:string}}
 */
function inspectMp3(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < MIN_AUDIO_BYTES) return { ok: false, reason: 'too_small' };
    let off = 0;
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) { // "ID3"
        if (buf.length < 10) return { ok: false, reason: 'not_mp3' };
        const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
        off = 10 + size + ((buf[5] & 0x10) ? 10 : 0);
    }
    const first = parseFrameHeader(buf, off);
    if (!first) return { ok: false, reason: 'not_mp3' };
    let frames = 0;
    let duration = 0;
    while (off < buf.length) {
        const h = parseFrameHeader(buf, off);
        if (!h || h.len <= 4) break;
        if (off + h.len > buf.length) break; // truncated tail frame — not counted
        frames += 1;
        duration += h.samples / h.sr;
        off += h.len;
    }
    if (frames === 0 || !(duration > 0)) return { ok: false, reason: 'zero_duration' };
    return { ok: true, durationSec: duration, frames };
}

/** RMS of 16-bit PCM in dBFS (-Infinity for digital silence). */
function rmsDbfs(samples) {
    if (!samples || samples.length === 0) return -Infinity;
    let acc = 0;
    for (let i = 0; i < samples.length; i += 1) acc += samples[i] * samples[i];
    const rms = Math.sqrt(acc / samples.length);
    return rms === 0 ? -Infinity : 20 * Math.log10(rms / 32768);
}

/** Default decoder: ffmpeg → mono 16 kHz s16le. Rejects with code ENOENT if ffmpeg is absent. */
function ffmpegDecodePcm(filePath, { ffmpegPath = 'ffmpeg', timeoutMs = 60_000 } = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegPath, ['-v', 'error', '-nostdin', '-i', filePath, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
            { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let stderr = '';
        const timer = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
        p.stdout.on('data', (d) => chunks.push(d));
        p.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d.toString(); });
        p.on('error', (err) => { clearTimeout(timer); reject(err); });
        p.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(Object.assign(new Error(`ffmpeg exit ${code}: ${stderr.trim()}`), { code: 'EDECODE' }));
            const buf = Buffer.concat(chunks);
            resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
        });
    });
}

/**
 * @param {object} [opts]
 * @param {number} [opts.rmsThresholdDbfs=-50] below → silence (rejected)
 * @param {(path:string)=>Promise<Int16Array>} [opts.decodePcm] PCM decoder
 * @returns {(tmpPath:string)=>Promise<{ok:boolean, reason?:string, durationSec?:number, rmsDbfs?:number}>}
 */
function createAudioValidator(opts = {}) {
    const threshold = Number.isFinite(opts.rmsThresholdDbfs) ? opts.rmsThresholdDbfs : DEFAULT_RMS_THRESHOLD_DBFS;
    const decodePcm = typeof opts.decodePcm === 'function' ? opts.decodePcm : ffmpegDecodePcm;
    return async function validateAudio(tmpPath) {
        const buf = await fs.promises.readFile(tmpPath);
        const mp3 = inspectMp3(buf);
        if (!mp3.ok) return mp3;
        let pcm;
        try {
            pcm = await decodePcm(tmpPath);
        } catch (err) {
            if (err && err.code === 'ENOENT') return { ok: false, reason: 'decoder_unavailable' };
            return { ok: false, reason: 'decode_failed' };
        }
        const level = rmsDbfs(pcm);
        if (!(level >= threshold)) {
            return { ok: false, reason: 'silence', durationSec: mp3.durationSec, rmsDbfs: level };
        }
        return { ok: true, durationSec: mp3.durationSec, rmsDbfs: level };
    };
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function readHead(filePath, n) {
    const fh = await fs.promises.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, 0);
        return buf.subarray(0, bytesRead);
    } finally { await fh.close(); }
}

async function validatePng(tmpPath) {
    const head = await readHead(tmpPath, 8);
    return head.equals(PNG_SIG) ? { ok: true } : { ok: false, reason: 'not_png' };
}

async function validateMp4(tmpPath) {
    const head = await readHead(tmpPath, 12);
    return head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp' ? { ok: true } : { ok: false, reason: 'not_mp4' };
}

/**
 * Default validateResult port: dispatches by job.kind.
 * @param {object} [opts] forwarded to createAudioValidator
 */
function createDefaultValidateResult(opts = {}) {
    const audio = createAudioValidator(opts);
    return async function validateResult(job, tmpPath) {
        switch (job && job.kind) {
            case 'audio_chunk':
            case 'audio_merge': return audio(tmpPath);
            case 'iu_image': return validatePng(tmpPath);
            case 'video_group':
            case 'video_merge': return validateMp4(tmpPath);
            default: return { ok: false, reason: 'unknown_kind' };
        }
    };
}

module.exports = {
    DEFAULT_RMS_THRESHOLD_DBFS,
    inspectMp3,
    rmsDbfs,
    ffmpegDecodePcm,
    createAudioValidator,
    createDefaultValidateResult,
    validatePng,
    validateMp4,
};
