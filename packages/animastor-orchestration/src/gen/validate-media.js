// ======================================================
// gen/validate-media — default result validators (ADR §7 п.1, §13.4)
// ======================================================
// Audio: MP3 magic bytes (ID3v2 tag or MPEG Layer III frame sync), duration
// > 0 from the frame headers, and NOT silence — RMS of the decoded PCM above
// a threshold (parameter, dBFS). Image (1.1.0): PNG structure + CRC, dimensions > 0,
// pixel data inflates to the IHDR size, NOT a blank / single-colour frame (luma
// stddev threshold, parameter). Video: MP4 `ftyp` box.
//
// PCM decoding is injected (`decodePcm(path) → Int16Array`); the default
// spawns the `ffmpeg` binary (node builtin child_process, no npm dependency).
// Fail-closed: no decoder → the result is NOT accepted (reason
// decoder_unavailable) — «тишина = ready» must never come back.

'use strict';

const fs = require('fs');
const zlib = require('zlib');
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

// ── PNG (1.1.0): structure + dimensions + «not a blank frame» ────────────
// A GPU image result is accepted only if it is a well-formed PNG (signature,
// IHDR first, CRC of every chunk, IDAT present, IEND last), its dimensions are
// > 0, the pixel stream inflates to exactly the size IHDR promises, and the
// frame is not one flat colour: the standard deviation of the luma over
// sampled pixels must reach `minLumaStddev` (default 2.0 on a 0..255 scale).
// A black / single-colour frame (a VAE or safety-filter failure) has stddev 0;
// any real picture is far above 2. The same «blank = invalid_result» rule as
// silence for audio (ADR §7 п.1, §13.4): one retry, then failed.
const DEFAULT_MIN_LUMA_STDDEV = 2.0;
const PNG_MAX_SIDE = 16384;
const PNG_MAX_DECODE_PIXELS = 64 * 1024 * 1024;
const PNG_SAMPLE_TARGET = 1 << 16;       // ~65k pixels sampled for the flatness check
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf, start, end) {
    let c = 0xffffffff;
    for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

/** Undo the per-scanline filters in place. @returns {Buffer|null} raw rows (no filter bytes) */
function unfilter(data, width, height, bpp, rowBytes) {
    const out = Buffer.alloc(rowBytes * height);
    let prev = null;
    for (let y = 0; y < height; y += 1) {
        const off = y * (rowBytes + 1);
        const type = data[off];
        const row = out.subarray(y * rowBytes, (y + 1) * rowBytes);
        for (let x = 0; x < rowBytes; x += 1) {
            const raw = data[off + 1 + x];
            const a = x >= bpp ? row[x - bpp] : 0;
            const b = prev ? prev[x] : 0;
            const c = prev && x >= bpp ? prev[x - bpp] : 0;
            let v;
            switch (type) {
                case 0: v = raw; break;
                case 1: v = raw + a; break;
                case 2: v = raw + b; break;
                case 3: v = raw + ((a + b) >> 1); break;
                case 4: v = raw + paeth(a, b, c); break;
                default: return null;
            }
            row[x] = v & 0xff;
        }
        prev = row;
    }
    return out;
}

/**
 * Luma standard deviation over sampled pixels (8/16-bit, non-palette or palette).
 * @returns {number}
 */
function lumaStddev(rows, width, height, colorType, depth, rowBytes, palette) {
    const ch = PNG_CHANNELS[colorType];
    const bytesPerSample = depth === 16 ? 2 : 1;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / PNG_SAMPLE_TARGET)));
    const sample = (rowOff, idx) => (depth === 16 ? rows[rowOff + idx * 2] : rows[rowOff + idx]);   // high byte
    let n = 0; let sum = 0; let sumSq = 0;
    for (let y = 0; y < height; y += step) {
        const rowOff = y * rowBytes;
        for (let x = 0; x < width; x += step) {
            let l;
            if (colorType === 3) {
                const i = rows[rowOff + x];
                const p = palette && i * 3 + 2 < palette.length ? i * 3 : 0;
                l = palette ? 0.299 * palette[p] + 0.587 * palette[p + 1] + 0.114 * palette[p + 2] : i;
            } else if (colorType === 0 || colorType === 4) {
                l = sample(rowOff, x * ch);
            } else {
                const base = x * ch;
                l = 0.299 * sample(rowOff, base) + 0.587 * sample(rowOff, base + 1) + 0.114 * sample(rowOff, base + 2);
            }
            n += 1; sum += l; sumSq += l * l;
        }
    }
    if (n === 0) return 0;
    const mean = sum / n;
    return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
}

/**
 * Inspect a PNG buffer.
 * @param {Buffer} buf
 * @param {{minLumaStddev?:number}} [opts]
 * @returns {{ok:true, width:number, height:number, lumaStddev:number|null, flat_check:string}
 *          |{ok:false, reason:string, width?:number, height?:number, lumaStddev?:number}}
 *   reason ∈ not_png | truncated | bad_crc | no_ihdr | bad_dimensions | bad_header | no_idat
 *            | no_iend | corrupt_data | blank_frame
 */
function inspectPng(buf, opts = {}) {
    const minStd = Number.isFinite(opts.minLumaStddev) ? opts.minLumaStddev : DEFAULT_MIN_LUMA_STDDEV;
    if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return { ok: false, reason: 'not_png' };
    let off = 8;
    let ihdr = null; let palette = null; let sawIend = false;
    const idat = [];
    let first = true;
    while (off < buf.length) {
        if (off + 12 > buf.length) return { ok: false, reason: 'truncated' };
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        if (len > 0x7fffffff || off + 12 + len > buf.length) return { ok: false, reason: 'truncated' };
        const crc = buf.readUInt32BE(off + 8 + len);
        if (crc32(buf, off + 4, off + 8 + len) !== crc) return { ok: false, reason: 'bad_crc' };
        const data = buf.subarray(off + 8, off + 8 + len);
        if (first && type !== 'IHDR') return { ok: false, reason: 'no_ihdr' };
        first = false;
        if (type === 'IHDR') {
            if (len !== 13) return { ok: false, reason: 'bad_header' };
            ihdr = {
                width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9],
                compression: data[10], filter: data[11], interlace: data[12],
            };
        } else if (type === 'PLTE') {
            palette = data;
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            sawIend = true;
            break;
        }
        off += 12 + len;
    }
    if (!ihdr) return { ok: false, reason: 'no_ihdr' };
    const { width, height, depth, colorType } = ihdr;
    if (!(width > 0 && height > 0) || width > PNG_MAX_SIDE || height > PNG_MAX_SIDE) {
        return { ok: false, reason: 'bad_dimensions', width, height };
    }
    if (!PNG_CHANNELS[colorType] || !PNG_DEPTHS[colorType].includes(depth) || ihdr.compression !== 0 || ihdr.filter !== 0 || ihdr.interlace > 1) {
        return { ok: false, reason: 'bad_header', width, height };
    }
    if (!idat.length) return { ok: false, reason: 'no_idat', width, height };
    if (!sawIend) return { ok: false, reason: 'no_iend', width, height };

    const bitsPerPixel = PNG_CHANNELS[colorType] * depth;
    const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
    // flatness is measured on non-interlaced, byte-aligned frames (ComfyUI SaveImage:
    // 8-bit RGB/RGBA, no interlace); other layouts are checked structurally only
    const flatCheckable = ihdr.interlace === 0 && depth >= 8 && width * height <= PNG_MAX_DECODE_PIXELS;
    if (!flatCheckable) return { ok: true, width, height, lumaStddev: null, flat_check: 'skipped' };
    let raw;
    try {
        raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (rowBytes + 1) * height + 1 });
    } catch (_) {
        return { ok: false, reason: 'corrupt_data', width, height };
    }
    if (raw.length !== (rowBytes + 1) * height) return { ok: false, reason: 'corrupt_data', width, height };
    const rows = unfilter(raw, width, height, Math.max(1, bitsPerPixel >> 3), rowBytes);
    if (!rows) return { ok: false, reason: 'corrupt_data', width, height };
    const std = lumaStddev(rows, width, height, colorType, depth, rowBytes, palette);
    if (!(std >= minStd)) return { ok: false, reason: 'blank_frame', width, height, lumaStddev: std };
    return { ok: true, width, height, lumaStddev: std, flat_check: 'done' };
}

/**
 * @param {{minLumaStddev?:number}} [opts]
 * @returns {(tmpPath:string)=>Promise<object>} the iu_image validator (inspectPng of the file)
 */
function createPngValidator(opts = {}) {
    return async function validatePngFile(tmpPath) {
        return inspectPng(await fs.promises.readFile(tmpPath), opts);
    };
}

async function readHead(filePath, n) {
    const fh = await fs.promises.open(filePath, 'r');
    try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await fh.read(buf, 0, n, 0);
        return buf.subarray(0, bytesRead);
    } finally { await fh.close(); }
}

/** Full PNG check with the default threshold (1.0.0 checked the signature only). */
const validatePng = createPngValidator();

async function validateMp4(tmpPath) {
    const head = await readHead(tmpPath, 12);
    return head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp' ? { ok: true } : { ok: false, reason: 'not_mp4' };
}

/**
 * Default validateResult port: dispatches by job.kind.
 * @param {object} [opts] forwarded to createAudioValidator; opts.minLumaStddev → createPngValidator
 */
function createDefaultValidateResult(opts = {}) {
    const audio = createAudioValidator(opts);
    const png = createPngValidator({ minLumaStddev: opts.minLumaStddev });
    return async function validateResult(job, tmpPath) {
        switch (job && job.kind) {
            case 'audio_chunk':
            case 'audio_merge': return audio(tmpPath);
            case 'iu_image': return png(tmpPath);
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
    inspectPng,
    createPngValidator,
    DEFAULT_MIN_LUMA_STDDEV,
};
