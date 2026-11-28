// ======================================================
// ANIMASTOR BACKEND — BOOK DIFF SERVICE
// ======================================================
// Scene comparison and diff computation (+ pure scope filters).

const fs = require('fs');
const path = require('path');
// S-4: filename grammar composed from the canonical owner (bytes unchanged)
const artifactNaming = require('@animastor/generation').artifactNaming;
// Dirty-layer grammar: adopted into @animastor/generation (post-reconnaissance
// adoption, 2026-09-25) — the host consumed it via the package namespace from
// here on (backend/src/services/prompt-dependency-registry.js is DELETED).
const registry = require('@animastor/generation').dirtyGrammar;
// S-2: default dirty layers resolved from media registry
const { listMediaTypes: _mediaTypes } = require('@animastor/generation').mediaRegistry;
// VBook 4 (VBOOK_FORMAT_V4 §4a.5): the derived key scene.resolved_looks of the
// registry needs the book, the chapter and the one look resolver.
const { resolveHeroLook } = require('@animastor/vbook-runtime/looks.cjs');

module.exports = function(redis, config, deps) {
    const { book } = deps;
    const { log, collectScenes } = deps.utils;

    // ── Deep equality check ───────────────────────────
    function isEqual(a, b) {
        if (a === b) return true;
        if (a == null || b == null) return a === b;
        if (typeof a !== typeof b) return false;
        if (typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean') return a === b;
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            for (let i = 0; i < a.length; i++) {
                if (!isEqual(a[i], b[i])) return false;
            }
            return true;
        }
        if (typeof a === 'object') {
            const keysA = Object.keys(a);
            const keysB = Object.keys(b);
            if (keysA.length !== keysB.length) return false;
            for (const key of keysA) {
                if (!isEqual(a[key], b[key])) return false;
            }
            return true;
        }
        return a === b;
    }

    // ── Scene diff ────────────────────────────────────
    function diffScene(oldScene, newScene, context) {
        // Delegated to Prompt Dependency Registry — the single source of truth
        // for which scene-level fields affect which generation layers.
        // See prompt-dependency-registry.js for the full list of fields.
        // context { old: {book, chapter}, new: {book, chapter} } — for the
        // derived key scene.resolved_looks.
        const result = registry.computeSceneDirtyLayers(oldScene, newScene, context ? { ...context, resolveHeroLook } : undefined);
        return {
            dirty_layers: result.dirtyLayers,
            changes: result.changes,
        };
    }

    // ── Merge or add a dirty scene entry ───────────────
    function ensureDirtyScene(dirtyScenes, chapterId, sceneId, reason, dirtyLayers, changes) {
        const existing = dirtyScenes.find(d => d.chapter_id === chapterId && d.scene_id === sceneId);
        if (existing) {
            for (const layer of dirtyLayers) {
                if (!existing.dirty_layers.includes(layer)) {
                    existing.dirty_layers.push(layer);
                }
            }
            if (changes) {
                existing.changes = { ...existing.changes, ...changes };
            }
            // Keep the earliest reason (e.g. 'added' > 'changed' > 'character_changed')
            if (reason === 'added' || reason === 'changed') {
                existing.reason = reason;
            }
            return existing;
        }
        const entry = {
            chapter_id: chapterId,
            scene_id: sceneId,
            reason,
            dirty_layers: [...dirtyLayers],
            changes: changes || null,
        };
        dirtyScenes.push(entry);
        return entry;
    }

    // ── Compute book diff ─────────────────────────────
    function computeBookDiff(oldBook, newBook) {
        const oldScenes = collectScenes(oldBook);
        const newScenes = collectScenes(newBook);

        const oldMap = {};
        for (const s of oldScenes) {
            oldMap[`${s.chapter_id}_${s.scene_id}`] = s;
        }

        const newMap = {};
        for (const s of newScenes) {
            newMap[`${s.chapter_id}_${s.scene_id}`] = s;
        }

        const dirtyScenes = [];
        let reindexNeeded = false;

        // ── Step 1: Scene-level diff (added, removed, changed) ──
        for (const key of Object.keys(newMap)) {
            const newS = newMap[key];
            const oldS = oldMap[key];

            if (!oldS) {
                // New scene
                dirtyScenes.push({
                    chapter_id: newS.chapter_id,
                    scene_id: newS.scene_id,
                    reason: 'added',
                    dirty_layers: _mediaTypes(),
                });
            } else {
                // Check for changes
                const diff = diffScene(oldS.scene, newS.scene, {
                    old: { book: oldBook, chapter: oldS.chapter },
                    new: { book: newBook, chapter: newS.chapter },
                });
                if (diff.dirty_layers.length > 0) {
                    dirtyScenes.push({
                        chapter_id: newS.chapter_id,
                        scene_id: newS.scene_id,
                        reason: 'changed',
                        dirty_layers: diff.dirty_layers,
                        changes: diff.changes,
                    });
                }
                // Check if scene moved (different index)
                if (oldS.scene_order !== newS.scene_order) {
                    reindexNeeded = true;
                }
            }
        }

        // Check for removed scenes
        for (const key of Object.keys(oldMap)) {
            if (!newMap[key]) {
                dirtyScenes.push({
                    chapter_id: oldMap[key].chapter_id,
                    scene_id: oldMap[key].scene_id,
                    reason: 'removed',
                    dirty_layers: _mediaTypes(),
                });
            }
        }

        // ── Step 2: Cross-cutting entity changes ───────────────
        // Use Prompt Dependency Registry to find changed entities
        // (characters, locations) and mark affected scenes.
        const crossFields = registry.getCrossFields();
        const crossChanges = {};  // field.key → count
        for (const field of crossFields) {
            const oldEntities = field.entitySource(oldBook);
            const newEntities = field.entitySource(newBook);

            const oldEntityMap = new Map();
            for (const e of oldEntities) oldEntityMap.set(field.entityId(e), e);
            const newEntityMap = new Map();
            for (const e of newEntities) newEntityMap.set(field.entityId(e), e);

            const changedIds = new Set();

            // Detect changed/added entities
            for (const [id, newEntity] of newEntityMap) {
                const oldEntity = oldEntityMap.get(id);
                if (!oldEntity || field.isChanged(oldEntity, newEntity)) {
                    changedIds.add(id);
                }
            }
            // Detect removed entities
            for (const id of oldEntityMap.keys()) {
                if (!newEntityMap.has(id)) {
                    changedIds.add(id);
                }
            }

            if (changedIds.size > 0) {
                crossChanges[field.key] = changedIds.size;
                log(`📋 ${field.key} changes detected: ${changedIds.size} changed`);
                for (const entityId of changedIds) {
                    const affected = field.findAffectedScenes(newScenes, entityId);
                    for (const s of affected) {
                        const ch = {};
                        ch[field.label] = entityId;
                        ensureDirtyScene(dirtyScenes, s.chapter_id, s.scene_id,
                            field.key.replace(/[.\[\]]/g, '_') + '_changed',
                            field.layers, ch);
                    }
                }
            }
        }

        return {
            dirty_scenes: dirtyScenes,
            changes: {
                added: Object.keys(newMap).filter(k => !oldMap[k]).length,
                removed: Object.keys(oldMap).filter(k => !newMap[k]).length,
                modified: dirtyScenes.filter(d => d.reason === 'changed').length,
                ...crossChanges,
            },
            reindex_needed: reindexNeeded,
        };
    }

    // (2026-11-28, ORCHESTRATION_V2 этап 4: markDirtyScenes — the Redis reset of
    // chunks / per-asset states / active index for the legacy scheduler — is gone
    // with the legacy orchestration; v2 detects stale content by hash.)

    // ── Filter dirty scenes by scope ──────────────────
    function filterDirtyScenesByScope(dirtyScenes, scope, chapterId, sceneId, allScenes) {
        if (!dirtyScenes || dirtyScenes.length === 0) return [];

        switch (scope) {
            case 'whole_book':
                return dirtyScenes;

            case 'current_scene':
                return dirtyScenes.filter(ds =>
                    ds.chapter_id === chapterId && ds.scene_id === sceneId
                );

            case 'current_chapter':
                return dirtyScenes.filter(ds =>
                    ds.chapter_id === chapterId
                );

            case 'from_current_scene':
                if (!allScenes || allScenes.length === 0) return dirtyScenes;
                const currentSceneIndex = allScenes.findIndex(s =>
                    s.chapter_id === chapterId && s.scene_id === sceneId
                );
                if (currentSceneIndex < 0) return dirtyScenes;
                const fromChapter = allScenes[currentSceneIndex].chapter_id;
                return dirtyScenes.filter(ds => {
                    const dsIndex = allScenes.findIndex(s =>
                        s.chapter_id === ds.chapter_id && s.scene_id === ds.scene_id
                    );
                    return dsIndex >= currentSceneIndex || ds.chapter_id === fromChapter;
                });

            default:
                return dirtyScenes;
        }
    }

    // ── Is in scope helper ────────────────────────────
    function isInScope(chunk, scope, chapterId, sceneId) {
        if (scope === 'whole_book') return true;
        if (scope === 'current_scene') {
            return chunk.chapter_id === chapterId && chunk.scene_id === sceneId;
        }
        if (scope === 'current_chapter') {
            return chunk.chapter_id === chapterId;
        }
        return true;
    }

    return {
        isEqual,
        diffScene,
        computeBookDiff,
        filterDirtyScenesByScope,
        isInScope,
    };
};
