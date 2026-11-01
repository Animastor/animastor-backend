// ======================================================
// Image Preview Thumbnails
// ======================================================

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const config = require('../config/runtime-config');
const helpers = require('./helpers');
const { makeIUImageFilename, makePreviewFilename } = require('../storage/filesystem-store');

// A preview request for an IU that has not been generated yet is a normal
// state (the UI asks for every visible unit), not an anomaly. Log it once per
// IU and at info level: a warn line on every poll is pure noise, and the route
// still answers 404 exactly as before.
const missingPreviewLogged = new Set();
const MISSING_PREVIEW_LOG_MAX = 2000;

function logMissingPreviewOnce(sourceName) {
    if (missingPreviewLogged.has(sourceName)) return;
    if (missingPreviewLogged.size >= MISSING_PREVIEW_LOG_MAX) missingPreviewLogged.clear();
    missingPreviewLogged.add(sourceName);
    helpers.log(`preview source not found for ${sourceName} in any build dir (logged once per IU)`);
}

async function getOrCreatePreview(bookId, chapterId, sceneId, iuId, buildId) {
    const strippedId = iuId.replace(/^iu/, '');
    const sourceName = makeIUImageFilename(bookId, chapterId, sceneId, strippedId);
    const previewName = makePreviewFilename(bookId, chapterId, sceneId, strippedId);

    const outputDir = config.OUTPUT_DIR;

    // ── Stage 143a (phase 2c · consumer 3, FIX) — the published pointer is the
    // AUTHORITY for the requested build while the flag is ON. The legacy disk
    // walk below consults old canonical files (and old previews from OTHER
    // builds); after an IU is regenerated in versioned mode that would rebuild
    // the thumbnail from a stale source, which also makes the task-handler
    // preview invalidation pointless. So the pointer is consulted FIRST:
    //   ok      → serve the canonical preview of THIS build if it still exists
    //             (the publication path deletes it on every new publication, so
    //             a present one belongs to the current generation); otherwise
    //             build it from the immutable versioned file and cache it under
    //             the canonical preview name,
    //   missing → a PUBLISHED pointer whose target is unsafe/absent: return
    //             null (404). Never fall back to a possibly stale legacy
    //             source/preview — the pointer is the authority and it is broken,
    //   absent  → nothing published for this build → legacy walk unchanged,
    //   flag OFF→ the facade returns null with ZERO PostgreSQL calls → the
    //             legacy walk runs and behavior is byte-identical.
    // A pointer-store ERROR is NOT swallowed: it propagates to the route
    // (500). An outage must never be rendered as "no image" (404) for an image
    // that is actually published.
    let published = null;
    try {
        published = await require('./registry').resolveIuImagePath(
            outputDir, buildId, bookId, chapterId, sceneId, iuId);
    } catch (pgErr) {
        helpers.error(`preview pointer lookup failed for ${sourceName}: ${pgErr.message}`);
        throw pgErr;
    }

    if (published && published.status === 'ok') {
        const versionedPreviewDir = path.join(outputDir, buildId);
        const versionedPreviewPath = path.join(versionedPreviewDir, previewName);
        if (fs.existsSync(versionedPreviewPath)) {
            return { path: versionedPreviewPath, created: false };
        }
        try {
            fs.mkdirSync(versionedPreviewDir, { recursive: true });
            await sharp(published.path)
                .resize({ width: helpers.PREVIEW_WIDTH, withoutEnlargement: true })
                .png()
                .toFile(versionedPreviewPath);
            helpers.log(`preview created from published source: ${previewName}`);
            return { path: versionedPreviewPath, created: true };
        } catch (err) {
            helpers.error(`versioned preview generation failed for ${sourceName}: ${err.message}`);
            return null;
        }
    }

    if (published && published.status === 'missing') {
        helpers.warn(`preview source publication broken for ${sourceName} (${published.reason}) — not falling back to legacy`);
        return null;
    }

    // ── Legacy path (flag OFF, or nothing published for this build) ────────
    const dirs = [];
    const requestedDir = path.join(outputDir, buildId);
    if (fs.existsSync(requestedDir)) {
        dirs.push(requestedDir);
    }
    try {
        const allDirs = fs.readdirSync(outputDir)
            .filter(d => d !== buildId)
            .map(d => path.join(outputDir, d))
            .filter(d => fs.statSync(d).isDirectory());
        dirs.push(...allDirs);
    } catch (_) {}

    for (const dir of dirs) {
        const previewPath = path.join(dir, previewName);
        if (fs.existsSync(previewPath)) {
            return { path: previewPath, created: false };
        }
        const sourcePath = path.join(dir, sourceName);
        if (fs.existsSync(sourcePath)) {
            try {
                await sharp(sourcePath)
                    .resize({ width: helpers.PREVIEW_WIDTH, withoutEnlargement: true })
                    .png()
                    .toFile(previewPath);
                helpers.log(`preview created: ${previewName} (in ${path.basename(dir)})`);
                return { path: previewPath, created: true };
            } catch (err) {
                helpers.error(`preview generation failed for ${sourceName}: ${err.message}`);
                return null;
            }
        }
    }

    logMissingPreviewOnce(sourceName);
    return null;
}

/**
 * Get image metadata (dimensions) using sharp.
 */
const getImageMetadata = async (imagePath) => {
    try {
        if (!fs.existsSync(imagePath)) {
            return null;
        }
        const stats = fs.statSync(imagePath);
        const metadata = await sharp(imagePath).metadata();
        return {
            exists: true,
            size: stats.size,
            width: metadata.width || null,
            height: metadata.height || null,
            format: metadata.format || null,
        };
    } catch {
        return null;
    }
};

module.exports = {
    getOrCreatePreview,
    getImageMetadata,
};
