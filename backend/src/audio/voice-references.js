// ======================================================
// audio/voice-references — character voice references (VOICE_REFERENCES.md)
// ======================================================
// A character's voice is created ONCE (explicit user command), verified,
// stored as a WAV in the content folder and every chunk is cloned from it:
//
//   build_<book_id>/voices/<character_id>/<candidate_id>.wav   canonical WAV
//   build_<book_id>/voices/<character_id>/<candidate_id>.json  candidate metadata
//   build_<book_id>/voices/<character_id>/uploads/<candidate_id>.<ext>  user upload (source)
//
// The .vbook keeps only the text link + metadata (voices.json[id].reference,
// through the @animastor/vbook-runtime voice port). sha256 is computed HERE,
// over the stored file — exactly the bytes LoadAudio receives on the worker.
//
// Pure helpers (no I/O) are exported for tests: normaliseTranscript,
// compareTranscript, parseWavMeta, canonicalWav, …

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const voicePort = require('@animastor/vbook-runtime/voice');
const { inspectWav } = require('@animastor/orchestration').gen.media;

const PHRASES_PATH = path.resolve(__dirname, '../../ai/voice-reference-phrases.json');
const COMPARISON_POLICY_VERSION = 1;
const DEFAULT_CANDIDATES = 3;
const MAX_CANDIDATES = 5;
const MIN_DURATION_SEC = 4;
const MAX_DURATION_SEC = 20;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const VOICES_CHAPTER = '_voices';          // gen_jobs.chapter_id of voice_reference jobs
const UPLOAD_EXT = Object.freeze({ 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac' });
const DESIGN_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
const CLONE_MODEL = 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';

class VoiceReferenceError extends Error {
    constructor(code, status, message, details = {}) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

// ── template phrases ─────────────────────────────────────────────────────
let phrasesCache = null;
function loadPhrases() {
    if (!phrasesCache) phrasesCache = JSON.parse(fs.readFileSync(PHRASES_PATH, 'utf8'));
    return phrasesCache;
}

/** ISO code of the book language ('ru' | 'en' | 'de' …) → phrases block, or null */
function phrasesFor(isoLang) {
    const p = loadPhrases();
    const key = String(isoLang || '').toLowerCase().slice(0, 2);
    return key && p[key] && typeof p[key] === 'object' && p[key].language ? { iso: key, ...p[key] } : null;
}

function bookLanguage(loadedBook) {
    return (loadedBook && loadedBook.book && loadedBook.book.language) || null;
}

/**
 * The Qwen language name + phrase for a voice. Narrator → narrative phrase,
 * characters → conversational phrase.
 * @throws VoiceReferenceError 409 voice_reference_language_unsupported
 */
function phraseForVoice(loadedBook, voiceId) {
    const lang = bookLanguage(loadedBook);
    const block = phrasesFor(lang);
    if (!block) {
        throw new VoiceReferenceError('voice_reference_language_unsupported', 409,
            `no template phrase for book language ${JSON.stringify(lang)} (supported: ${Object.keys(loadPhrases()).filter((k) => !k.startsWith('_')).join(', ')})`,
            { language: lang });
    }
    const style = voiceId === voicePort.NARRATOR_ID ? 'narrative' : 'conversational';
    return { iso: block.iso, language: block.language, style, ...block[style] };
}

/** Qwen language name of the book (VoiceClone target_language, ASR language). */
function qwenLanguage(loadedBook) {
    const block = phrasesFor(bookLanguage(loadedBook));
    return block ? block.language : null;
}

// ── strict transcript comparison (COMPARISON_POLICY_VERSION 1) ───────────
/**
 * NFC → casefold (lower + ß→ss) → ё→е → punctuation / symbols → space →
 * collapsed whitespace. Digits are NOT spelled out: template phrases contain none.
 */
function normaliseTranscript(text) {
    return String(text || '')
        .normalize('NFC')
        .toLowerCase()
        .replace(/ß/g, 'ss')
        .replace(/ё/g, 'е')
        .replace(/[\p{P}\p{S}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

/** Strict: equal after normalisation. A wrong ref_text spoils the clone. */
function compareTranscript(expected, actual) {
    const e = normaliseTranscript(expected);
    const a = normaliseTranscript(actual);
    return { passed: e.length > 0 && e === a, expected_normalised: e, actual_normalised: a, policy_version: COMPARISON_POLICY_VERSION };
}

// ── WAV: RIFF JSON metadata + canonical form ────────────────────────────
/** JSON written by SaveAudioAnimastorReference into LIST/INFO/ICMT, or null. */
function parseWavMeta(buf) {
    const w = inspectWav(buf);
    if (!w.ok) return null;
    for (const c of w.chunks) {
        if (c.id !== 'LIST' || c.size < 4 || buf.toString('latin1', c.offset, c.offset + 4) !== 'INFO') continue;
        let pos = c.offset + 4;
        const end = c.offset + c.size;
        while (pos + 8 <= end) {
            const id = buf.toString('latin1', pos, pos + 4);
            const size = buf.readUInt32LE(pos + 4);
            if (id === 'ICMT') {
                const raw = buf.toString('utf8', pos + 8, pos + 8 + size).replace(/\u0000+$/u, '');
                try { return JSON.parse(raw); } catch (_) { return null; }
            }
            pos += 8 + size + (size & 1);
        }
    }
    return null;
}

/**
 * The canonical stored form: RIFF/WAVE with ONLY `fmt ` and `data`. The LIST
 * chunk is cut so that (1) LoadAudio reads a plain PCM file and (2) sha256
 * depends on the audio only. @throws on a non-PCM-s16 file.
 */
function canonicalWav(buf) {
    const w = inspectWav(buf);
    if (!w.ok) throw new VoiceReferenceError('bad_wav', 422, `not a PCM WAV: ${w.reason}`);
    const fmtC = w.chunks.find((c) => c.id === 'fmt ');
    const part = (id, c) => {
        const head = Buffer.alloc(8);
        head.write(id, 0, 'latin1');
        head.writeUInt32LE(c.size, 4);
        const body = buf.subarray(c.offset, c.offset + c.size);
        return Buffer.concat([head, body, c.size & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), part('fmt ', fmtC), part('data', w.data)]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'latin1');
    riff.writeUInt32LE(body.length, 4);
    return { buffer: Buffer.concat([riff, body]), fmt: w.fmt, durationSec: w.durationSec };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function sha256File(p) { return sha256(fs.readFileSync(p)); }

// ── paths ────────────────────────────────────────────────────────────────
function assertSafeId(id, what) {
    if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) throw new VoiceReferenceError('bad_request', 400, `${what}: invalid id ${JSON.stringify(id)}`);
    return id;
}

function createPaths(outputDir) {
    const voicesDir = (buildId) => path.join(outputDir, assertSafeId(buildId, 'build_id'), 'voices');
    const voiceDir = (buildId, voiceId) => path.join(voicesDir(buildId), assertSafeId(voiceId, 'character_id'));
    return {
        voicesDir,
        voiceDir,
        candidateWav: (buildId, voiceId, candId) => path.join(voiceDir(buildId, voiceId), `${assertSafeId(candId, 'candidate_id')}.wav`),
        candidateJson: (buildId, voiceId, candId) => path.join(voiceDir(buildId, voiceId), `${assertSafeId(candId, 'candidate_id')}.json`),
        uploadDir: (buildId, voiceId) => path.join(voiceDir(buildId, voiceId), 'uploads'),
        /** voices/<id>/<cand>.wav — the link stored in voices.json (relative to the build folder) */
        relativeFile: (voiceId, candId) => `voices/${assertSafeId(voiceId, 'character_id')}/${assertSafeId(candId, 'candidate_id')}.wav`,
        /** absolute path of a reference link (rejects anything outside voices/) */
        resolveLink: (buildId, link) => {
            if (typeof link !== 'string' || !/^voices\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}\.wav$/.test(link)) {
                throw new VoiceReferenceError('bad_reference', 409, `bad reference link ${JSON.stringify(link)}`);
            }
            return path.join(outputDir, assertSafeId(buildId, 'build_id'), link);
        },
    };
}

function newCandidateId() {
    return `c${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

/** worker-side input name of a reference: content-addressed, LoadAudio-safe */
function inputNameFor(sha) { return `vref_${String(sha).slice(0, 32)}.wav`; }

// ── service ──────────────────────────────────────────────────────────────
function createVoiceReferences({ outputDir, log = () => {} } = {}) {
    if (!outputDir) throw new Error('voice-references: outputDir required');
    const paths = createPaths(outputDir);

    function buildIdOf(loadedBook) {
        const b = loadedBook && loadedBook.manifest && loadedBook.manifest.build_id;
        if (!b) throw new VoiceReferenceError('book_without_build', 409, 'book has no manifest.build_id');
        return b;
    }

    /**
     * Status of the locked reference of a voice (pure check + disk):
     * ok | missing_voice | missing | malformed | unlocked | not_verified | file_missing | sha_mismatch
     */
    function referenceStatus(loadedBook, voiceId) {
        const v = voicePort.getCharacterVoice(loadedBook, voiceId);
        if (!v) return { status: 'missing_voice' };
        if (v.reference_problem) return { status: 'malformed', problem: v.reference_problem };
        const r = v.reference;
        if (!r) return { status: 'missing' };
        if (!r.locked) return { status: 'unlocked', reference: r };
        if (r.verification !== 'passed') return { status: 'not_verified', reference: r };
        const file = paths.resolveLink(buildIdOf(loadedBook), r.file);
        if (!fs.existsSync(file)) return { status: 'file_missing', reference: r, path: file };
        const bytes = fs.readFileSync(file);
        if (sha256(bytes) !== r.sha256) return { status: 'sha_mismatch', reference: r, path: file };
        return { status: 'ok', reference: r, path: file, bytes: bytes.length };
    }

    /**
     * The worker input + ref_text of a voice's locked reference.
     * @throws VoiceReferenceError 409 voice_reference_required {character_ids:[id], reasons}
     */
    function referenceInput(loadedBook, voiceId) {
        const st = referenceStatus(loadedBook, voiceId);
        if (st.status !== 'ok') {
            throw new VoiceReferenceError('voice_reference_required', 409, `voice ${voiceId}: reference ${st.status}`,
                { character_ids: [voiceId], reasons: { [voiceId]: st.status } });
        }
        return {
            voice_id: voiceId,
            name: inputNameFor(st.reference.sha256),
            path: st.path,
            sha256: st.reference.sha256,
            bytes: st.bytes,
            ref_text: st.reference.ref_text,
        };
    }

    /** Every voice id in `ids` without a usable locked reference → one 409 listing them all. */
    function requireReferences(loadedBook, ids) {
        const reasons = {};
        for (const id of [...new Set(ids)]) {
            const st = referenceStatus(loadedBook, id);
            if (st.status !== 'ok') reasons[id] = st.status;
        }
        const missing = Object.keys(reasons);
        if (missing.length) {
            throw new VoiceReferenceError('voice_reference_required', 409,
                `voice reference required for: ${missing.join(', ')}`, { character_ids: missing, reasons });
        }
    }

    // ── candidates on disk ──
    function readCandidate(buildId, voiceId, candId) {
        try { return JSON.parse(fs.readFileSync(paths.candidateJson(buildId, voiceId, candId), 'utf8')); } catch (_) { return null; }
    }

    function writeCandidate(buildId, voiceId, meta) {
        const p = paths.candidateJson(buildId, voiceId, meta.candidate_id);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const tmp = `${p}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
        fs.renameSync(tmp, p);
        return meta;
    }

    function listCandidates(loadedBook, voiceId) {
        const buildId = buildIdOf(loadedBook);
        const dir = paths.voiceDir(buildId, voiceId);
        let names = [];
        try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
        const v = voicePort.getCharacterVoice(loadedBook, voiceId);
        const lockedId = v && v.reference ? v.reference.candidate_id : null;
        return names
            .map((n) => readCandidate(buildId, voiceId, n.slice(0, -5)))
            .filter(Boolean)
            .map((c) => ({ ...c, selected: c.candidate_id === lockedId, words: undefined }))
            .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }

    /**
     * Plan the units of a voice_reference command (scope.voice):
     *   {mode:'design', character_ids:[…], count}  → `count` candidates per voice, distinct seeds
     *   {mode:'upload', character_id, candidate_id, upload:{file, sha256, bytes, ext}} → one transcribe job
     * Each candidate gets a 'pending' metadata file at once (the UI lists it).
     */
    function planCandidates(loadedBook, bookId, voiceScope, provider) {
        const buildId = buildIdOf(loadedBook);
        const language = qwenLanguage(loadedBook);
        const units = [];
        if (voiceScope.mode === 'upload') {
            const id = assertSafeId(voiceScope.character_id, 'character_id');
            const candId = assertSafeId(voiceScope.candidate_id, 'candidate_id');
            const up = voiceScope.upload || {};
            const inputName = `vupl_${String(up.sha256).slice(0, 32)}.${up.ext}`;
            const wf = provider.assembleVoiceTranscribeWorkflow({ inputFile: inputName, language: language || 'auto', filenamePrefix: `voices/${id}/${candId}` });
            units.push(unit(buildId, id, candId, wf, provider.WORKFLOW_NAMES.voiceTranscribe, {
                mode: 'upload',
                input_files: [{ name: inputName, rel: up.file, sha256: up.sha256, bytes: up.bytes }],
            }));
            writeCandidate(buildId, id, {
                candidate_id: candId, character_id: id, book_id: bookId, source: 'uploaded', status: 'pending',
                created_at: new Date().toISOString(), upload: { file: up.file, sha256: up.sha256, bytes: up.bytes },
            });
            return units;
        }
        const count = Math.min(MAX_CANDIDATES, Math.max(1, Number(voiceScope.count) || DEFAULT_CANDIDATES));
        for (const id of voiceScope.character_ids || []) {
            assertSafeId(id, 'character_id');
            const v = voicePort.getCharacterVoice(loadedBook, id);
            if (!v) throw new VoiceReferenceError('voice_not_found', 404, `voice ${id} not found`);
            const description = voicePort.voiceDesignDescription(v);
            if (!description) throw new VoiceReferenceError('voice_description_empty', 409, `voice ${id}: timbre is empty — describe the voice first`, { character_ids: [id] });
            const phrase = phraseForVoice(loadedBook, id);
            for (let i = 0; i < count; i++) {
                const candId = newCandidateId() + i;
                const seed = crypto.randomBytes(6).readUIntBE(0, 6);      // < 2^48, safe integer
                const wf = provider.assembleVoiceReferenceWorkflow({
                    description, phrase: phrase.text, language: phrase.language, seed,
                    filenamePrefix: `voices/${id}/${candId}`,
                });
                units.push(unit(buildId, id, candId, wf, provider.WORKFLOW_NAMES.voiceReference, { mode: 'design' }));
                writeCandidate(buildId, id, {
                    candidate_id: candId, character_id: id, book_id: bookId, source: 'designed', status: 'pending',
                    created_at: new Date().toISOString(),
                    description, description_kind: id === voicePort.NARRATOR_ID ? 'timbre+manner' : 'timbre',
                    model: DESIGN_MODEL, seed,
                    language: phrase.language, phrase_id: phrase.id, phrase_version: phrase.version, ref_text: phrase.text,
                    comparison_policy_version: COMPARISON_POLICY_VERSION,
                });
            }
        }
        return units;
    }

    function unit(buildId, voiceId, candId, workflow, workflowName, extra) {
        return {
            chapter_id: VOICES_CHAPTER, scene_id: voiceId, kind: 'voice_reference', unit_key: candId, build_id: buildId,
            input: { workflow_json: JSON.stringify(workflow), workflow_name: workflowName, candidate_id: candId, voice_id: voiceId, ...extra },
        };
    }

    /** Input files of a voice_reference job (uploaded sample) — absolute paths for the claim port. */
    function jobInputFiles(job) {
        const list = (job.input && job.input.input_files) || [];
        return list.map((f) => ({ name: f.name, path: path.join(outputDir, job.build_id, f.rel), sha256: f.sha256, bytes: f.bytes }));
    }

    /**
     * Acceptance hook (inside the acceptance tx, after the rename to finalPath):
     * parse the RIFF JSON, store the canonical WAV in place, sha256 over the
     * stored bytes, strict transcript check (designed), metadata JSON.
     */
    function onCandidatePlaced(job, finalPath) {
        const voiceId = job.scene_id;
        const candId = job.unit_key;
        const buildId = job.build_id;
        const raw = fs.readFileSync(finalPath);
        const meta = parseWavMeta(raw) || {};
        const canon = canonicalWav(raw);
        const tmp = `${finalPath}.${process.pid}.canon`;
        fs.writeFileSync(tmp, canon.buffer);
        fs.renameSync(tmp, finalPath);
        const prev = readCandidate(buildId, voiceId, candId) || { candidate_id: candId, character_id: voiceId };
        const duration = canon.durationSec;
        const out = {
            ...prev,
            status: 'ready',
            file: paths.relativeFile(voiceId, candId),
            sha256: sha256(canon.buffer),
            bytes: canon.buffer.length,
            duration_sec: Math.round(duration * 1000) / 1000,
            format: `wav pcm_s16le ${canon.fmt.channels === 1 ? 'mono' : canon.fmt.channels + 'ch'} ${canon.fmt.sampleRate}hz`,
            asr_transcript: typeof meta.asr_transcript === 'string' ? meta.asr_transcript : null,
            asr_language: meta.asr_language || null,
            words: Array.isArray(meta.words) ? meta.words : [],
            verification_model: meta.verification_model || null,
            whisper_device: meta.whisper_device || null,
            whisper_compute_type: meta.compute_type || null,
            faster_whisper_version: meta.faster_whisper_version || null,
            comparison_policy_version: COMPARISON_POLICY_VERSION,
            job_id: job.job_id,
            finished_at: new Date().toISOString(),
        };
        const problems = [];
        if (canon.fmt.sampleRate !== 24000 || canon.fmt.channels !== 1) problems.push('format');
        if (duration < MIN_DURATION_SEC) problems.push('too_short');
        if (duration > MAX_DURATION_SEC) problems.push('too_long');
        if (out.asr_transcript === null) problems.push('no_transcript');
        if (prev.source === 'designed') {
            const cmp = compareTranscript(prev.ref_text, out.asr_transcript);
            out.transcript_match = cmp.passed;
            if (!cmp.passed) problems.push('transcript_mismatch');
        } else {
            // uploaded: Whisper proposes ref_text; the user confirms / edits it when locking
            out.ref_text = out.asr_transcript || '';
            out.ref_text_source = 'asr';
        }
        out.verification = problems.length ? 'failed' : 'passed';
        out.verification_problems = problems;
        writeCandidate(buildId, voiceId, out);
        log(`[VOICE-REF] ${job.book_id}/${voiceId}/${candId}: ${out.verification}${problems.length ? ' (' + problems.join(',') + ')' : ''} ${out.duration_sec}s sha=${out.sha256.slice(0, 12)}`);
        return out;
    }

    /** A failed / cancelled job leaves a candidate in 'failed' (UI shows it, can delete). */
    function markCandidateFailed(buildId, voiceId, candId, reason) {
        const prev = readCandidate(buildId, voiceId, candId);
        if (!prev || prev.status === 'ready') return;
        writeCandidate(buildId, voiceId, { ...prev, status: 'failed', error: String(reason || 'failed').slice(0, 300) });
    }

    /**
     * Select + lock a candidate as the voice reference (mutates the book object;
     * the caller commits it). Designed: verification must be 'passed'. Uploaded:
     * ref_text = the user's text (or the ASR proposal) — the user confirms it.
     */
    function selectCandidate(loadedBook, voiceId, candId, { refText } = {}) {
        const buildId = buildIdOf(loadedBook);
        const c = readCandidate(buildId, voiceId, assertSafeId(candId, 'candidate_id'));
        if (!c) throw new VoiceReferenceError('candidate_not_found', 404, `candidate ${candId} not found`);
        if (c.status !== 'ready') throw new VoiceReferenceError('candidate_not_ready', 409, `candidate ${candId} is ${c.status}`);
        const file = paths.candidateWav(buildId, voiceId, candId);
        if (!fs.existsSync(file) || sha256File(file) !== c.sha256) throw new VoiceReferenceError('candidate_file_changed', 409, `candidate ${candId}: file missing or sha256 mismatch`);
        let refTextFinal = c.ref_text;
        if (c.source === 'uploaded') {
            const t = typeof refText === 'string' && refText.trim() ? refText.trim() : (c.ref_text || '').trim();
            if (!t) throw new VoiceReferenceError('ref_text_required', 409, 'uploaded sample: ref_text is empty — type what is said in the sample');
            const problems = (c.verification_problems || []).filter((p) => p !== 'no_transcript');
            if (problems.length) throw new VoiceReferenceError('candidate_not_verified', 409, `candidate ${candId}: ${problems.join(', ')}`);
            refTextFinal = t;
            if (t !== c.ref_text) writeCandidate(buildId, voiceId, { ...c, ref_text: t, ref_text_source: 'user' });
        } else if (c.verification !== 'passed') {
            throw new VoiceReferenceError('candidate_not_verified', 409, `candidate ${candId}: verification ${c.verification} (${(c.verification_problems || []).join(', ')})`);
        }
        const reference = {
            file: paths.relativeFile(voiceId, candId),
            ref_text: refTextFinal,
            source: c.source,
            model: c.source === 'designed' ? c.model : null,
            seed: c.source === 'designed' ? c.seed : null,
            sha256: c.sha256,
            verification: 'passed',
            locked: true,
            candidate_id: candId,
            language: c.language || qwenLanguage(loadedBook),
        };
        return voicePort.setCharacterVoiceReference(loadedBook, voiceId, reference);
    }

    function deleteCandidate(loadedBook, voiceId, candId) {
        const buildId = buildIdOf(loadedBook);
        const v = voicePort.getCharacterVoice(loadedBook, voiceId);
        if (v && v.reference && v.reference.candidate_id === candId) {
            throw new VoiceReferenceError('candidate_locked', 409, `candidate ${candId} is the locked reference — unlock it first`);
        }
        const c = readCandidate(buildId, voiceId, assertSafeId(candId, 'candidate_id'));
        if (!c) throw new VoiceReferenceError('candidate_not_found', 404, `candidate ${candId} not found`);
        if (c.status === 'pending') throw new VoiceReferenceError('candidate_pending', 409, `candidate ${candId} is still being generated`);
        for (const p of [paths.candidateWav(buildId, voiceId, candId), paths.candidateJson(buildId, voiceId, candId)]) {
            try { fs.unlinkSync(p); } catch (_) { /* absent */ }
        }
        if (c.upload && c.upload.file) {
            try { fs.unlinkSync(path.join(outputDir, buildId, c.upload.file)); } catch (_) { /* absent */ }
        }
        return true;
    }

    /** Store an uploaded sample (raw bytes) — returns the scope.voice of the transcribe command. */
    function storeUpload(loadedBook, voiceId, buf, contentType) {
        const buildId = buildIdOf(loadedBook);
        assertSafeId(voiceId, 'character_id');
        if (!voicePort.getCharacterVoice(loadedBook, voiceId)) throw new VoiceReferenceError('voice_not_found', 404, `voice ${voiceId} not found`);
        const ext = UPLOAD_EXT[String(contentType || '').split(';')[0].trim().toLowerCase()];
        if (!ext) throw new VoiceReferenceError('bad_media_type', 415, `unsupported audio type ${contentType} (wav, mp3, ogg, flac)`);
        if (!Buffer.isBuffer(buf) || buf.length === 0) throw new VoiceReferenceError('bad_request', 400, 'empty upload');
        if (buf.length > MAX_UPLOAD_BYTES) throw new VoiceReferenceError('too_large', 413, `upload larger than ${MAX_UPLOAD_BYTES} bytes`);
        const candId = newCandidateId();
        const dir = paths.uploadDir(buildId, voiceId);
        fs.mkdirSync(dir, { recursive: true });
        const abs = path.join(dir, `${candId}.${ext}`);
        fs.writeFileSync(abs, buf);
        return {
            mode: 'upload', character_id: voiceId, candidate_id: candId,
            upload: { file: path.relative(path.join(outputDir, buildId), abs).split(path.sep).join('/'), sha256: sha256(buf), bytes: buf.length, ext },
        };
    }

    return {
        paths,
        referenceStatus,
        referenceInput,
        requireReferences,
        listCandidates,
        planCandidates,
        jobInputFiles,
        onCandidatePlaced,
        markCandidateFailed,
        selectCandidate,
        deleteCandidate,
        storeUpload,
        buildIdOf,
    };
}

module.exports = {
    createVoiceReferences,
    VoiceReferenceError,
    normaliseTranscript,
    compareTranscript,
    parseWavMeta,
    canonicalWav,
    phraseForVoice,
    qwenLanguage,
    inputNameFor,
    createPaths,
    sha256,
    COMPARISON_POLICY_VERSION,
    DEFAULT_CANDIDATES,
    MIN_DURATION_SEC,
    MAX_DURATION_SEC,
    VOICES_CHAPTER,
    CLONE_MODEL,
};
