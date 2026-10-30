'use strict';

/**
 * Interactive terminal for the installer prompts.
 *
 * The canonical way to run the installer is `curl -fsSL "<url>" | bash`:
 * there stdin is the script pipe, NOT the keyboard. Every question (including
 * the hidden Worker Key input) is therefore read from the controlling
 * terminal /dev/tty, never from stdin. Without any terminal the installer
 * fails with a clear message instead of silently reading the script as
 * answers.
 *
 * Prompt rules (one question = one prompt, printed once):
 *   - no readline: every answer is read by one small raw-mode line editor
 *     (readline re-renders multi-line prompts and, with several interfaces
 *     on one input, echoes keystrokes twice — the old "double menu");
 *   - the question text is written ONCE, the prompt itself is one line;
 *   - CR, LF and CRLF end a line; type-ahead is kept for the next question;
 *   - hidden input uses the same editor without echo; pasted chunks are
 *     processed character by character.
 */

const fs = require('fs');
const tty = require('tty');

class NoTerminalError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NoTerminalError';
        this.code = 'NO_TTY';
    }
}

const NO_TTY_MESSAGE = [
    'No interactive terminal: the installer needs one to ask questions and the Worker Key (hidden input).',
    'Run the install command in an SSH session or a local terminal (curl -fsSL "<url>" | bash reads answers from /dev/tty),',
    'or add --yes when the Worker Key is already in the worker .env.',
].join('\n');

/**
 * Open the prompt streams: stdin/stdout when stdin is a TTY, else
 * /dev/tty (piped `curl | bash`). Returns null when no terminal exists.
 * Injectable for tests.
 */
function openTerminal({ stdin = process.stdin, stdout = process.stdout, fsMod = fs, ttyMod = tty, devTty = '/dev/tty' } = {}) {
    if (stdin && stdin.isTTY) {
        return { input: stdin, output: stdout, owned: false };
    }
    let inFd = null;
    let outFd = null;
    try {
        inFd = fsMod.openSync(devTty, 'r');
        outFd = fsMod.openSync(devTty, 'w');
        const input = new ttyMod.ReadStream(inFd);
        const output = stdout && stdout.isTTY ? stdout : new ttyMod.WriteStream(outFd);
        return { input, output, owned: true, fds: [inFd, outFd] };
    } catch (_) {
        for (const fd of [inFd, outFd]) {
            if (fd !== null) { try { fsMod.closeSync(fd); } catch (__) { /* ignore */ } }
        }
        return null;
    }
}

/**
 * Line editor state machine for raw-mode input — pure (unit-tested).
 * Feeds characters into `st` until a line is complete; characters after the
 * end of the line stay in `st.rest` (type-ahead for the NEXT question — never
 * lost, never mistaken for this answer). CR, LF and CRLF all end a line; the
 * LF of a CRLF pair is swallowed.
 * Returns the text to echo (nothing for hidden input).
 */
function feedLine(st, chunk, { hidden = false } = {}) {
    let echo = '';
    const chars = Array.from(String(chunk));
    let i = 0;
    for (; i < chars.length && !st.done; i++) {
        const c = chars[i];
        if (st.skipLf) {
            st.skipLf = false;
            if (c === '\n') continue;
        }
        if (c === '\r' || c === '\n') { st.done = true; st.endedWithCr = c === '\r'; break; }
        if (c === '\u0003') { st.cancelled = true; st.done = true; break; } // Ctrl+C
        if (c === '\u0004') { if (!st.value) st.eof = true; st.done = true; break; } // Ctrl+D
        if (c === '\u007F' || c === '\b') {
            if (st.value.length > 0) {
                st.value = st.value.slice(0, -1);
                if (!hidden) echo += '\b \b';
            }
            continue;
        }
        if (c === '\u001b') { st.inEscape = true; continue; } // arrow keys etc.: ignored
        if (st.inEscape) { if (/[A-Za-z~]/.test(c)) st.inEscape = false; continue; }
        if (c < ' ') continue; // other control chars
        st.value += c;
        if (!hidden) echo += c;
    }
    st.rest = chars.slice(i + 1).join('');
    return echo;
}

/** Backwards-compatible helper for hidden input chunks (pure). */
function applySecretChunk(state, chunk) {
    feedLine(state, chunk, { hidden: true });
    return { value: state.value, done: state.done, cancelled: !!state.cancelled };
}

/** Parse a Yes/No answer; empty → `def` (null = ask again). */
function parseYesNo(answer, def = null) {
    const a = String(answer || '').trim();
    if (!a) return def;
    if (/^(y|yes|д|да)$/i.test(a)) return true;
    if (/^(n|no|н|нет)$/i.test(a)) return false;
    return null;
}

/**
 * Create the prompt API on top of a terminal (openTerminal()). With
 * `term === null` every question throws NoTerminalError.
 */
function createPrompt(term = openTerminal()) {
    let pending = ''; // type-ahead carried over between questions
    let carrySkipLf = false;
    const need = () => {
        if (!term) throw new NoTerminalError(NO_TTY_MESSAGE);
        return term;
    };
    /** Read one line in raw mode (echo unless hidden). null on Ctrl+D. */
    const readLine = (promptText, { hidden = false } = {}) => new Promise((resolve) => {
        const t = need();
        const input = t.input;
        if (!input.isTTY || typeof input.setRawMode !== 'function') {
            throw new NoTerminalError(NO_TTY_MESSAGE);
        }
        t.output.write(promptText);
        const st = { value: '', done: false, skipLf: carrySkipLf, rest: '' };
        const finish = () => {
            input.removeListener('data', onData);
            input.setRawMode(false);
            input.pause();
            pending = st.rest;
            carrySkipLf = !!st.endedWithCr && st.rest === '';
            t.output.write('\n');
            if (st.cancelled) {
                // Ctrl+C keeps its meaning: interrupt the installer (the
                // engine's SIGINT guard saves resumable state).
                process.kill(process.pid, 'SIGINT');
                resolve(null);
                return;
            }
            resolve(st.eof ? null : st.value);
        };
        const onData = (chunk) => {
            const echo = feedLine(st, chunk, { hidden });
            if (echo) t.output.write(echo);
            if (st.done) finish();
        };
        if (pending) {
            const carried = pending;
            pending = '';
            const echo = feedLine(st, carried, { hidden });
            if (echo) t.output.write(echo);
            if (st.done) { finish(); return; }
        }
        input.setRawMode(true);
        input.on('data', onData);
        input.resume();
    });
    return {
        available: !!term,
        /**
         * Yes/No question. `defaultYes`: Enter alone means Yes ([Y/n]).
         * Unrecognized answers re-ask (at most 3 times, then No).
         */
        async confirm(question, { defaultYes = false } = {}) {
            const t = need();
            const lines = String(question).split('\n');
            const last = lines.pop();
            if (lines.length > 0) t.output.write(`${lines.join('\n')}\n`);
            for (let i = 0; i < 3; i++) {
                const answer = await readLine(`${last} ${defaultYes ? '[Y/n]' : '[y/N]'} `);
                if (answer === null) return false; // input closed (Ctrl+D)
                const v = parseYesNo(answer, defaultYes);
                if (v !== null) return v;
            }
            return false;
        },
        /** Numbered menu: printed once, then a single-line "> " prompt. */
        async select(question, options) {
            const t = need();
            t.output.write(`${question}\n${options.map((o, i) => `  [${i + 1}] ${o}`).join('\n')}\n`);
            const answer = await readLine('> ');
            const n = parseInt(answer, 10);
            return options[(n - 1)] || options[0];
        },
        /**
         * Hidden input (raw mode, no echo). The value is never echoed, logged,
         * stored in state or passed via argv.
         */
        async secret(question) {
            const value = await readLine(`${question}: `, { hidden: true });
            return value && value.trim() ? value.trim() : null;
        },
        close() {
            if (term && term.owned) {
                try { term.input.destroy(); } catch (_) { /* ignore */ }
                if (term.output !== process.stdout) { try { term.output.destroy(); } catch (_) { /* ignore */ } }
            }
        },
    };
}

module.exports = { openTerminal, createPrompt, feedLine, applySecretChunk, parseYesNo, NoTerminalError, NO_TTY_MESSAGE };
