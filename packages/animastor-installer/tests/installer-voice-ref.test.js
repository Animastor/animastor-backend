'use strict';

// 0.2.11 — custom node from a repository SUBDIRECTORY (animastor-voice-ref,
// animastor-docs architecture/VOICE_REFERENCES.md)

const { expect } = require('chai');
const { createMemoryFs } = require('../src/installer/engine/io');
const { installCustomNode } = require('../src/installer/engine/nodes');
const probe = require('../src/installer/engine/probe');
const manifest = require('../ai/install-manifests/audio/qwen-tts.json');

const DEP = manifest.dependencies.find((d) => d.id === 'custom-node:animastor-voice-ref');
const SRC = DEP.install.source;
const STAGING = '/comfy/.animastor-node-sources/animastor-voice-ref';

function mockIo({ cloneMakesSubdir = true, copyOk = true } = {}) {
    const fs = createMemoryFs({ '/comfy/main.py': '' });
    fs.mkdirSync('/comfy/custom_nodes', { recursive: true });
    const calls = [];
    const io = {
        fs,
        exec(cmd, args = []) {
            calls.push(`${cmd} ${args.join(' ')}`);
            if (cmd === 'git' && args[0] === 'clone') {
                fs.mkdirSync(args[2], { recursive: true });
                if (cloneMakesSubdir) {
                    fs.mkdirSync(`${args[2]}/${SRC.subdirectory}`, { recursive: true });
                    fs.writeFileSync(`${args[2]}/${SRC.subdirectory}/__init__.py`, '# node');
                }
            }
            if (cmd === 'cp') {
                if (!copyOk) return { code: 1, stdout: '', stderr: 'cp failed' };
                fs.mkdirSync(args[2], { recursive: true });
                fs.writeFileSync(`${args[2]}/__init__.py`, '# node');
            }
            return { code: 0, stdout: '', stderr: '' };
        },
    };
    return { io, fs, calls };
}

describe('installer 0.2.11 — custom node from a repository subdirectory', () => {
    it('the manifest pins animastor-voice-ref to a full commit + subdirectory', () => {
        expect(SRC.repository).to.equal('https://github.com/Animastor/animastor-worker');
        expect(SRC.commit).to.match(/^[0-9a-f]{40}$/);
        expect(SRC.subdirectory).to.equal('comfyui-nodes/animastor-voice-ref');
        expect(DEP.provides_classes).to.deep.equal(['SaveAudioAnimastorReference']);
    });

    it('clones OUTSIDE custom_nodes, checks out the pin, copies the subdirectory, writes the source marker, removes staging', () => {
        const { io, fs, calls } = mockIo();
        const r = installCustomNode(io, { root: '/comfy', dep: DEP });
        expect(r.status).to.equal('installed');
        expect(calls).to.include(`git clone ${SRC.repository} ${STAGING}`);
        expect(calls).to.include(`git -C ${STAGING} checkout ${SRC.commit}`);
        expect(calls).to.include(`cp -a ${STAGING}/${SRC.subdirectory} /comfy/custom_nodes/animastor-voice-ref`);
        expect(fs.existsSync(STAGING)).to.equal(false);
        const marker = JSON.parse(fs.readFileSync('/comfy/custom_nodes/animastor-voice-ref/.animastor-source.json', 'utf8'));
        expect(marker).to.deep.equal({ repository: SRC.repository, commit: SRC.commit, subdirectory: SRC.subdirectory });
    });

    it('the probe reports the pinned commit from the marker (no .git in the node folder)', () => {
        const { io } = mockIo();
        installCustomNode(io, { root: '/comfy', dep: DEP });
        const node = probe.probeCustomNodes(io, '/comfy').find((n) => n.directory === 'animastor-voice-ref');
        expect(node).to.include({ repository: SRC.repository, commit: SRC.commit, is_git: true });
    });

    it('a missing subdirectory or a failed copy fails without leaving staging', () => {
        let m = mockIo({ cloneMakesSubdir: false });
        expect(installCustomNode(m.io, { root: '/comfy', dep: DEP }).status).to.equal('failed');
        expect(m.fs.existsSync(STAGING)).to.equal(false);
        m = mockIo({ copyOk: false });
        expect(installCustomNode(m.io, { root: '/comfy', dep: DEP }).status).to.equal('failed');
        expect(m.fs.existsSync(STAGING)).to.equal(false);
    });

    it('a subdirectory without a pinned commit, or escaping the repository, is blocked', () => {
        const { io } = mockIo();
        const dep = (src) => ({ ...DEP, install: { ...DEP.install, source: { ...SRC, ...src } } });
        expect(installCustomNode(io, { root: '/comfy', dep: dep({ commit: null }) }).status).to.equal('blocked');
        expect(installCustomNode(io, { root: '/comfy', dep: dep({ subdirectory: '../x' }) }).status).to.equal('blocked');
    });
});
