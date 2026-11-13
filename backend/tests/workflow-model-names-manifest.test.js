// ======================================================
// Workflow ↔ install-manifest model-name guarantee
// ======================================================
// The manifests (packages/animastor-installer/ai/install-manifests) are the
// source of truth for which model files a profile installs; the workflows in
// backend/ai/workflows are what the workers actually ask ComfyUI to load.
// If the two disagree the worker loads a file nobody installed (stage166 A).
//
// For every workflow that has a profile in a manifest (provenance.workflows),
// every *_name value that looks like a model FILE must exist among that
// manifest's dependency `filename` fields. Workflows with no manifest (legacy
// old_*) are skipped by name — the list is explicit so a NEW unlisted workflow
// fails the test instead of silently escaping the guarantee.
//
// Known exceptions (stage166 A): empty — image LoRA and the four LTX unet
// names were brought in line with the manifests in this stage.

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, 'backend', 'ai', 'workflows');
const MANIFESTS_DIR = path.join(REPO_ROOT, 'packages', 'animastor-installer', 'ai', 'install-manifests');

// Legacy workflows excluded by the workflow loader: no manifest profile.
// Keep this list exact — see the assertion below.
const WORKFLOWS_WITHOUT_MANIFEST = [
    'old_img-qwen-image',
    'old_video-ltx',
];

// Known exceptions with a TODO: workflow → filenames not yet in the manifest.
// Empty by design in stage166 A. If a mismatch must stay for a while, list it
// HERE (never skip the whole test) together with a TODO and the report path:
//   'video-ltx-1p': ['LTX-2.3-distilled-Q4_K_M.gguf'], // TODO stage166 A, see reports/2026-11-07/stage166-branches.md
const KNOWN_EXCEPTIONS = {};

const MODEL_FILE_RE = /\.(safetensors|gguf|pt|pth|ckpt|bin)$/;

function walkNames(node, out) {
    if (Array.isArray(node)) {
        node.forEach((n) => walkNames(n, out));
        return;
    }
    if (node && typeof node === 'object') {
        Object.entries(node).forEach(([key, value]) => {
            if (key.endsWith('_name') && typeof value === 'string') out.push({ key, value });
            walkNames(value, out);
        });
    }
}

function listWorkflowFiles() {
    return fs.readdirSync(WORKFLOWS_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.basename(f, '.json'))
        .sort();
}

// workflow name → { manifest, filenames:Set<string> } from every manifest
function manifestIndex() {
    const index = new Map();
    const profiles = [];
    for (const sub of fs.readdirSync(MANIFESTS_DIR)) {
        const dir = path.join(MANIFESTS_DIR, sub);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
            const manifest = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
            const rel = path.join(sub, file);
            profiles.push({ rel, workflows: (manifest.provenance && manifest.provenance.workflows) || [] });
            const filenames = new Set(
                (manifest.dependencies || [])
                    .filter((d) => d && typeof d.filename === 'string')
                    .map((d) => d.filename),
            );
            for (const wf of manifest.provenance && manifest.provenance.workflows
                ? manifest.provenance.workflows : []) {
                expect(index.has(wf), `workflow "${wf}" listed in two manifests (${index.get(wf)} / ${rel})`)
                    .to.equal(false);
                index.set(wf, { rel, filenames });
            }
        }
    }
    return { index, profiles };
}

describe('workflow model names match the install manifests (stage166 A)', () => {
    const workflows = listWorkflowFiles();
    const { index: manifestByWorkflow, profiles } = manifestIndex();

    it('every manifest provenance.workflows entry points at a real workflow file', () => {
        for (const { rel, workflows: listed } of profiles) {
            for (const wf of listed) {
                expect(workflows, `manifest ${rel} lists unknown workflow "${wf}"`).to.include(wf);
            }
        }
    });

    it('workflows without a manifest are exactly the declared legacy list', () => {
        const without = workflows.filter((w) => !manifestByWorkflow.has(w));
        expect(without.sort(), 'add new manifest-less workflows to WORKFLOWS_WITHOUT_MANIFEST '
            + '(or add their manifest profile) — no silent escapes').to.deep.equal(
            [...WORKFLOWS_WITHOUT_MANIFEST].sort(),
        );
        // Declared entries must still exist (no stale names in the list).
        for (const wf of WORKFLOWS_WITHOUT_MANIFEST) {
            expect(workflows, `declared legacy workflow "${wf}" is gone — drop it from the list`)
                .to.include(wf);
        }
    });

    it('every model-file *_name in a manifested workflow exists in that manifest', () => {
        const mismatches = [];
        const known = [];
        const checked = [];

        for (const wf of workflows) {
            const entry = manifestByWorkflow.get(wf);
            if (!entry) continue; // legacy, no manifest — declared above
            const json = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, `${wf}.json`), 'utf8'));
            const collected = [];
            walkNames(json, collected);
            const names = collected.filter((n) => MODEL_FILE_RE.test(n.value));
            for (const { key, value } of names) {
                checked.push(`${wf}.${key}=${value}`);
                if (entry.filenames.has(value)) continue;
                const line = `${wf}: ${key} = "${value}" not among ${entry.rel} dependency filenames`;
                if (KNOWN_EXCEPTIONS[wf] && KNOWN_EXCEPTIONS[wf].includes(value)) known.push(line);
                else mismatches.push(line);
            }
        }

        if (known.length) {
            // Known exceptions are reported, never skipped wholesale: TODO + report link.
            // eslint-disable-next-line no-console
            console.warn(`[workflow-model-names] KNOWN EXCEPTION (TODO, reports/2026-11-07/stage166-branches.md):\n  ${known.join('\n  ')}`);
        }
        expect(mismatches, 'workflow model names must be installed by their manifest').to.deep.equal([]);
        expect(checked.length, 'no model-file *_name values found — did the scan break?').to.be.greaterThan(0);
    });
});
