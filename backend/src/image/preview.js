// ======================================================
// Image Preview Thumbnails
// ======================================================

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const config = require('../config/runtime-config');
const helpers = require('./helpers');
const { makeIUImageFilename, makePreviewFilename } = require('../storage/filesystem-store');

async function getOrCreatePreview(bookId, chapterId, sceneId, iuId, buildId) {
    const strippedId = iuId.replace(/^iu/, '');
    const sourceName = makeIUImageFilename(bookId, chapterId, sceneId, strippedId);
    const previewName = makePreviewFilename(bookId, chapterId, sceneId, strippedId);

    const outputDir = config.OUTPUT_DIR;
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

    // ── Stage 143a (phase 2c · consumer 3) — versioned source ────────────
    // The legacy walk above ran FIRST and returned if it found anything. Only
    // when it came up EMPTY do we consult the published pointer through the
    // image facade (flag-gated: at flag OFF it returns null immediately with
    // ZERO PostgreSQL calls, so behavior is byte-identical).
    //
    // Three verdicts, matching the /iu-image route:
    //   ok      → build the thumbnail from the immutable versioned file and
    //             write it under the CANONICAL preview name in this build dir
    //             (the preview is a derived cache — its name is stable, only
    //             its bytes change with the publication),
    //   missing → a PUBLISHED pointer whose target is unsafe/absent: return
    //             null (the route answers 404). We must NOT fall back to a
    //             possibly stale legacy source — the pointer is the authority
    //             and it is broken,
    //   absent  → nothing published here → the pre-existing verdict (null).
    //
    // A pointer-store ERROR is NOT swallowed: it propagates to the route,
    // which answers 500. That is the documented acceptable behavior for this
    // read endpoint — an outage must never be rendered as "no image" (404)
    // for an image that is actually published.
    let published = null;
    try {
        published = await require('./registry').resolveIuImagePath(
            outputDir, buildId, bookId, chapterId, sceneId, iuId);
    } catch (pgErr) {
        helpers.error(`preview pointer lookup failed for ${sourceName}: ${pgErr.message}`);
        throw pgErr;
    }
    if (published && published.status === 'ok') {
        const previewDir = path.join(outputDir, buildId);
        const previewPath = path.join(previewDir, previewName);
        try {
            fs.mkdirSync(previewDir, { recursive: true });
            await sharp(published.path)
                .resize({ width: helpers.PREVIEW_WIDTH, withoutEnlargement: true })
                .png()
                .toFile(previewPath);
            helpers.log(`preview created from published source: ${previewName}`);
            return { path: previewPath, created: true };
        } catch (err) {
            helpers.error(`versioned preview generation failed for ${sourceName}: ${err.message}`);
            return null;
        }
    }
    if (published && published.status === 'missing') {
        helpers.warn(`preview source publication broken for ${sourceName} (${published.reason}) — not falling back to legacy`);
        return null;
    }

    helpers.warn(`preview source not found for ${sourceName} in any build dir`);
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
