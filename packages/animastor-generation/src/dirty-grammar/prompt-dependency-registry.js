// ======================================================
// Prompt Dependency Registry — @animastor/generation/dirty-grammar
// ======================================================
// Central registry of all data sources used by image prompt building
// (buildImagePrompt / buildCharacters on the host) and by the book-diff
// scene comparison.
//
// Every field that contributes to the Final Image Prompt is annotated here
// with:
//   scope   — how to find affected scenes (scene|cross)
//   layers  — which generation layers become dirty
//   extract — how to get the value for comparison
//
// This is the SINGLE SOURCE OF TRUTH for what changes trigger
// regeneration. If a prompt builder starts reading a new field, add it
// here — diffScene and computeBookDiff will pick it up automatically.
//
// Physical home (post-reconnaissance adoption, 2026-09-25): moved verbatim
// from backend/src/services/prompt-dependency-registry.js into the
// Generation package — next to the sceneState FSM and mediaRegistry it
// drives. Zero requires — pure. Reachable through the package root
// (generation.dirtyGrammar) or the ./dirty-grammar subpath export.
//
// ======================================================

// ── Deep equality helper (not using lodash to keep it zero-dep) ──
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

// ======================================================
// REGISTRY: Scene-level fields
// ======================================================
// These fields live inside a scene payload (oldScene vs newScene).
// diffScene() iterates over this list to determine dirty layers.
// ======================================================

const SCENE_FIELDS = [
    // ── Audio ─────────────────────────────────────
    // full_text is the SceneText. When it changes, ALL layers are dirty
    // because the visual context (derived from SceneText) also changed.
    {
        key: 'audio.full_text',
        layers: ['audio'],
        // SceneText changed → visual content also needs regeneration
        cascadingLayers: ['image', 'video'],
        extract: (scene) => scene?.audio?.full_text,
        label: 'Full scene text (TTS source)',
        usedBy: 'buildImagePrompt → audio.full_text',
    },
    // voice change affects ONLY audio — video is mute, no dependency
    {
        key: 'audio.voice',
        layers: ['audio'],
        extract: (scene) => scene?.audio?.voice,
        label: 'Voice settings (model, pitch, speed)',
        usedBy: 'buildImagePrompt → audio.voice',
    },

    // ── Scene-level visual style ──────────────────
    // scene.visual.style is used as a global style fallback
    // for all units when unit.image.style is not set
    {
        key: 'scene.visual.style',
        layers: ['image', 'video'],
        extract: (scene) => scene?.visual?.style,
        label: 'Scene-level visual style fallback',
        usedBy: 'buildImagePrompt → scene.visual.style',
    },
    {
        key: 'scene.visual.lighting',
        layers: ['image', 'video'],
        extract: (scene) => scene?.visual?.lighting,
        label: 'Scene-level lighting instruction',
        usedBy: 'buildImagePrompt → scene.visual.lighting',
    },
    {
        key: 'scene.visual.quality',
        layers: ['image', 'video'],
        extract: (scene) => scene?.visual?.quality,
        label: 'Scene-level image quality',
        usedBy: 'buildImagePrompt → scene.visual.quality',
    },
    {
        key: 'scene.visual.render',
        layers: ['image', 'video'],
        extract: (scene) => scene?.visual?.render,
        label: 'Scene-level render mode override',
        usedBy: 'buildImagePrompt → renderMode',
    },

    // ── Scene location & participants ─────────────
    // location.id determines which bible.locations entry is used
    // participants determines which character passports are injected
    {
        key: 'scene.location',
        layers: ['image', 'video'],
        extract: (scene) => scene?.location,
        label: 'Scene location reference (→ bible.json)',
        usedBy: 'buildImagePrompt → bible.locations[locationId]',
    },
    {
        key: 'scene.participants',
        layers: ['image', 'video'],
        extract: (scene) => scene?.participants,
        label: 'Scene-level character participants',
        usedBy: 'buildCharacters → resolveHeroLook(book, chapter, scene, id)',
    },

    // ── Scene style ───────────────────────────────
    {
        key: 'scene.style',
        layers: ['image', 'video'],
        extract: (scene) => scene?.style,
        label: 'Scene narrative style',
        usedBy: 'buildImagePrompt → scene.style',
    },

    // ── Scene character state ─────────────────────
    // scene.state[charId] is used as character state override
    // in buildCharacters() — affects the passport text
    {
        key: 'scene.state',
        layers: ['image', 'video'],
        extract: (scene) => scene?.state,
        label: 'Per-scene character state overrides',
        usedBy: 'buildCharacters → resolveState()',
    },

    // ── Resolved looks of the participants (VBook 4, VBOOK_FORMAT_V4 §4a.5) ──
    // A DERIVED key: for every participant with a passport, the look the
    // generation will actually use — resolveHeroLook(book, chapter, scene, id)
    // → { appearance, clothes, video_tokens }. It replaces scene.passport and
    // the book-wide characters.passport: the RESULT is compared, not the
    // sources, so exactly the scenes whose resolved look changed get dirty —
    // a look field edit marks the scenes where that look acts, a chapter
    // assignment the chapter's scenes without their own reference, a base
    // field edit only the scenes where no look overrides it; label, notes,
    // image_ref and an unassigned look change nothing. Audio is never marked.
    // Needs the context of the scene: extract(scene, { book, chapter,
    // resolveHeroLook }) — the resolver is injected by the host (this module
    // stays pure); without a book in the context the key is absent.
    {
        key: 'scene.resolved_looks',
        layers: ['image', 'video'],
        extract: (scene, ctx) => resolvedLooks(scene, ctx),
        label: 'Resolved looks of the participants (passport ← look ← look_patch)',
        usedBy: 'buildCharacters → resolveHeroLook, video-workflows buildCharLines → resolveHeroLook',
    },
];

// ======================================================
// REGISTRY: Unit-level fields with an explicit layer set
// ======================================================
// unit.audio / unit.type / unit.image / unit.video are handled inline in
// computeBookDiff (audio; image → image+video; video → video). The fields
// below would otherwise hit the "unknown field → all layers" catch-all.
// Behaviour (animastor-docs architecture/VBOOK_BEHAVIOUR.md):
//   behaviour        — applied rule snapshot; its phrases are appended to the
//                      video storyboard line only → video
//   state            — per-IU emotions, matcher INPUT; never sent to a GPU → none
//   behaviour_locked — author lock, matcher input → none
// ======================================================

const UNIT_FIELD_LAYERS = Object.freeze({
    behaviour: Object.freeze(['video']),
    state: Object.freeze([]),
    behaviour_locked: Object.freeze([]),
});

// ======================================================
// REGISTRY: Cross-cutting fields
// ======================================================
// These fields live outside individual scenes (characters/<id>.json,
// bible.json) and affect ALL scenes that reference the entity.
// computeBookDiff() uses this list for entity-level comparison.
// ======================================================

const CROSS_FIELDS = [
    // ── Hero passport / looks ──────────────────────
    // VBook 4: covered by the derived scene key scene.resolved_looks (every
    // scene is compared with its book and chapter), so there is no
    // entity-level passport entry — it marked every scene of the hero, even
    // the ones where a look overrides the edited field.
    //
    // ── Hero voice (VBook 4: the voice lives in characters/<id>.json) ──
    // VOICE_REFERENCES.md (0.2.0, kept): every chunk is cloned from the LOCKED
    // reference (file sha256 + ref_text) — so only a change of that locked
    // reference makes audio dirty; timbre / manner only drive the creation of
    // reference candidates and change no chunk. (VBOOK_FORMAT_V4 §8.2 also
    // lists timbre / manner → audio — an open question to the owner, see the
    // step 3 report.) Video is mute; nothing else of a hero (name, role,
    // aliases, notes, image_refs, behaviour, looks) touches audio. The
    // narrator's voice is used by every scene; another hero's — by the scenes
    // where it takes part or speaks (unit.audio.speaker = its id).
    {
        key: 'heroes.voice',
        layers: ['audio'],
        entitySource: (book) => (Array.isArray(book?.heroes) ? book.heroes : []).filter((h) => h && typeof h.id === 'string'),
        entityId: (hero) => hero.id,
        isChanged: (oldEntity, newEntity) => voiceKey(oldEntity) !== voiceKey(newEntity),
        findAffectedScenes: (allScenes, entityId) => (entityId === NARRATOR_ID
            ? allScenes
            : allScenes.filter((s) => sceneReferencesCharacter(s, entityId) || sceneHasSpeaker(s, entityId))),
        label: 'Locked voice reference of a hero (voice.reference sha256 / ref_text)',
        usedBy: 'audio/generation → reference of the voice (LoadAudio + VoiceClonePrompt); voiceInstruct',
    },
    // Note: no catch-all for heroes — looks are the derived scene key,
    // the voice is the entry above; other hero fields don't affect generation.
    // ── Location from bible.json ──────────────────
    // bible.locations[locId].description + environment template
    // are injected into the final prompt
    {
        key: 'bible.locations',
        layers: ['image', 'video'],
        entitySource: (book) => {
            const locs = book?.locations || {};
            return Object.entries(locs).map(([id, data]) => ({ id, ...data }));
        },
        entityId: (loc) => loc.id,
        isChanged: (oldEntity, newEntity) => !isEqual(oldEntity, newEntity),
        findAffectedScenes: (allScenes, entityId) => {
            return allScenes.filter(s => s.location && s.location.id === entityId);
        },
        label: 'Location description + environment template (bible.json)',
        usedBy: 'buildImagePrompt → bible.locations[locationId]',
    },
];

// ======================================================
// HELPERS
// ======================================================

const NARRATOR_ID = 'narrator';

const strOf = (v) => (typeof v === 'string' ? v : '');

/** What of a hero's voice reaches the audio layer: the LOCKED reference only. */
function voiceKey(hero) {
    const v = hero && hero.voice && typeof hero.voice === 'object' && !Array.isArray(hero.voice) ? hero.voice : null;
    const r = v && v.reference && typeof v.reference === 'object' && v.reference.locked === true ? v.reference : null;
    return r ? `${strOf(r.sha256)}\u0000${strOf(r.ref_text)}` : '';
}

/** Does any unit of the scene have this speaker? */
function sceneHasSpeaker(sceneEntry, heroId) {
    const scene = sceneEntry && (sceneEntry.scene || sceneEntry.payload);
    if (!scene) return false;
    const units = (Array.isArray(scene.units) ? scene.units : [])
        .concat((Array.isArray(scene.dialogue_blocks) ? scene.dialogue_blocks : []).flatMap((b) => (b && Array.isArray(b.units) ? b.units : [])));
    return units.some((u) => u && u.audio && u.audio.speaker === heroId);
}

/**
 * The derived key scene.resolved_looks: participant id → resolved look.
 * undefined without a book / resolver in the context (key absent).
 */
function resolvedLooks(scene, ctx) {
    if (!ctx || !ctx.book || typeof ctx.resolveHeroLook !== 'function') return undefined;
    const out = {};
    const ids = Array.isArray(scene?.participants) ? scene.participants : [];
    for (const id of ids) {
        if (typeof id !== 'string' || Object.prototype.hasOwnProperty.call(out, id)) continue;
        const look = ctx.resolveHeroLook(ctx.book, ctx.chapter || null, scene || null, id);
        if (!look) continue;
        out[id] = { appearance: look.appearance, clothes: look.clothes, video_tokens: look.video_tokens };
    }
    return out;
}


/**
 * Check if a scene entry references a character at scene or unit level.
 * @param {Object} sceneEntry - Runtime scene entry from collectScenes()
 * @param {string} characterId
 * @returns {boolean}
 */
function sceneReferencesCharacter(sceneEntry, characterId) {
    if (!sceneEntry) return false;
    // unit.participants removed — only scene-level participants are used
    if (sceneEntry.participants && sceneEntry.participants.includes(characterId)) return true;
    return false;
}

// ======================================================
// PUBLIC API
// ======================================================

/**
 * Compute dirty layers by comparing old and new scene payloads.
 * Iterates over all SCENE_FIELDS and returns the merged set of
 * dirty layers, plus a changes map.
 *
 * @param {Object} oldScene - Old scene payload
 * @param {Object} newScene - New scene payload
 * @param {{ old?: {book, chapter}, new?: {book, chapter}, resolveHeroLook?: Function }} [context]
 *   the book and chapter of each side and the look resolver — needed by the
 *   derived key scene.resolved_looks (VBook 4); without it that key is absent
 * @returns {{ dirtyLayers: string[], changes: Object }}
 */
function computeSceneDirtyLayers(oldScene, newScene, context = {}) {
    const oldCtx = context && context.old ? { ...context.old, resolveHeroLook: context.resolveHeroLook } : null;
    const newCtx = context && context.new ? { ...context.new, resolveHeroLook: context.resolveHeroLook } : null;
    const dirtyLayers = [];
    const changes = {};

    // ── Units comparison (special: aggregates units + dialogue_blocks) ──
    const oldUnits = (oldScene?.units || []).concat(
        (oldScene?.dialogue_blocks || []).flatMap(db => db.units || [])
    );
    const newUnits = (newScene?.units || []).concat(
        (newScene?.dialogue_blocks || []).flatMap(db => db.units || [])
    );
    if (!isEqual(oldUnits, newUnits)) {
        const unitChanges = { audio: false, image: false, video: false };
        const changedUnitIds = [];

        // Build ID-based maps for field-level comparison
        const oldMap = new Map();
        for (const u of oldUnits) {
            if (u && u.id != null) oldMap.set(String(u.id), u);
        }
        const newMap = new Map();
        for (const u of newUnits) {
            if (u && u.id != null) newMap.set(String(u.id), u);
        }

        // If units are anonymous (no IDs), we can't do field-level matching.
        // Conservatively regenerate all layers.
        const oldHasIds = oldUnits.some(u => u && u.id != null);
        const newHasIds = newUnits.some(u => u && u.id != null);
        if (!oldHasIds || !newHasIds) {
            unitChanges.audio = true;
            unitChanges.image = true;
            unitChanges.video = true;
        } else {
            // Field-level analysis: determine WHICH layers are affected by unit changes.
            // Only mark a layer dirty if its specific fields actually changed.

            // Check unit order changes (sequence matters for both audio and visual context)
            const oldIds = oldUnits.filter(u => u && u.id != null).map(u => String(u.id));
            const newIds = newUnits.filter(u => u && u.id != null).map(u => String(u.id));
            const orderChanged = !isEqual(oldIds, newIds);
            if (orderChanged) {
                unitChanges.audio = true;
                unitChanges.image = true;
                unitChanges.video = true;
            }

            // New units (added) — affect all layers
            for (const u of newUnits) {
                if (u && u.id != null && !oldMap.has(String(u.id))) {
                    unitChanges.audio = true;
                    unitChanges.image = true;
                    unitChanges.video = true;
                    changedUnitIds.push(String(u.id));
                }
            }

            // Removed units — affect all layers
            for (const u of oldUnits) {
                if (u && u.id != null && !newMap.has(String(u.id))) {
                    unitChanges.audio = true;
                    unitChanges.image = true;
                    unitChanges.video = true;
                }
            }

            // Changed units — field-level analysis per unit
            for (const u of newUnits) {
                if (u && u.id != null) {
                    const oldU = oldMap.get(String(u.id));
                    if (!oldU || isEqual(oldU, u)) continue;

                    changedUnitIds.push(String(u.id));

                    // audio changed → audio only
                    if (!isEqual(oldU.audio, u.audio)) {
                        unitChanges.audio = true;
                    }

                    // type changed (narration ↔ dialogue) → audio only
                    if (!isEqual(oldU.type, u.type)) {
                        unitChanges.audio = true;
                    }

                    // image changed → image + video (video depends on images)
                    if (!isEqual(oldU.image, u.image)) {
                        unitChanges.image = true;
                        unitChanges.video = true;
                    }

                    // video.action changed → video only (no image regen needed)
                    if (!isEqual(oldU.video, u.video)) {
                        unitChanges.video = true;
                    }

                    // Explicit unit fields with their own layer set
                    // (UNIT_FIELD_LAYERS): behaviour → video, state /
                    // behaviour_locked → none.
                    for (const [key, layers] of Object.entries(UNIT_FIELD_LAYERS)) {
                        if (isEqual(oldU[key], u[key])) continue;
                        for (const layer of layers) unitChanges[layer] = true;
                    }

                    // Unknown fields — conservative, mark all layers
                    const knownUnitKeys = new Set(['id', 'type', 'audio', 'image', 'video', ...Object.keys(UNIT_FIELD_LAYERS)]);
                    for (const key of Object.keys(u)) {
                        if (knownUnitKeys.has(key)) continue;
                        if (!isEqual(oldU[key], u[key])) {
                            unitChanges.audio = true;
                            unitChanges.image = true;
                            unitChanges.video = true;
                            break;
                        }
                    }
                }
            }
        }

        // Apply collected layer changes
        for (const [layer, dirty] of Object.entries(unitChanges)) {
            if (dirty && !dirtyLayers.includes(layer)) {
                dirtyLayers.push(layer);
            }
        }

        changes.units = {
            old_count: oldUnits.length,
            new_count: newUnits.length,
            unit_ids: changedUnitIds,
        };
    }

    // ── Scene fields comparison ──
    for (const field of SCENE_FIELDS) {
        const oldVal = field.extract(oldScene, oldCtx);
        const newVal = field.extract(newScene, newCtx);
        if (!isEqual(oldVal, newVal)) {
            // Push primary layers
            for (const layer of field.layers) {
                if (!dirtyLayers.includes(layer)) dirtyLayers.push(layer);
            }
            // Push cascading layers (e.g. full_text → image+video)
            if (field.cascadingLayers) {
                for (const layer of field.cascadingLayers) {
                    if (!dirtyLayers.includes(layer)) dirtyLayers.push(layer);
                }
            }
            // Track change details
            const changeKey = field.key.replace(/\./g, '_');
            changes[changeKey] = { changed: true };
        }
    }

    return {
        dirtyLayers: [...new Set(dirtyLayers)],
        changes: Object.keys(changes).length > 0 ? changes : null,
    };
}

/**
 * Get all scene-level fields for a given layer.
 * Used by dependency-graph.js to describe layer dependencies.
 *
 * @param {string} layer - 'audio' | 'image' | 'video'
 * @returns {Array} Fields that can make this layer dirty
 */
function getFieldsForLayer(layer) {
    const result = [];
    for (const field of SCENE_FIELDS) {
        if (field.layers.includes(layer) || (field.cascadingLayers && field.cascadingLayers.includes(layer))) {
            result.push(field);
        }
    }
    return result;
}

/**
 * Get cross-cutting fields for entity-level comparison.
 *
 * @returns {Array}
 */
function getCrossFields() {
    return CROSS_FIELDS;
}

/**
 * Get the dependency graph mapping layer → [affected layers].
 * Derived from SCENE_FIELDS + known pipeline (image→video).
 *
 * @returns {Object}
 */
function getLayerDependencies() {
    return {
        image: {
            label: 'Image / IU',
            // Image layer is triggered by scene fields AND
            // causes video regeneration (pipeline dependency)
            regenerate: ['image', 'video'],
            triggeredBy: SCENE_FIELDS
                .filter(f => f.layers.includes('image') || (f.cascadingLayers && f.cascadingLayers.includes('image')))
                .map(f => f.key),
        },
        audio: {
            label: 'Audio',
            regenerate: ['audio'],
            triggeredBy: SCENE_FIELDS
                .filter(f => f.layers.includes('audio'))
                .map(f => f.key),
        },
        video: {
            label: 'Video',
            regenerate: ['video'],
            // Video triggered by image/unit changes, NOT by audio
            triggeredBy: SCENE_FIELDS
                .filter(f => f.layers.includes('video') || (f.cascadingLayers && f.cascadingLayers.includes('video')))
                .filter(f => !f.key.startsWith('audio.'))  // audio changes don't trigger video
                .map(f => f.key),
        },
    };
}

module.exports = {
    // Registry data
    SCENE_FIELDS,
    CROSS_FIELDS,

    // Helpers
    computeSceneDirtyLayers,
    getFieldsForLayer,
    getCrossFields,
    getLayerDependencies,
    sceneReferencesCharacter,
    sceneHasSpeaker,
    resolvedLooks,
    voiceKey,

    // Exposed for testing
    isEqual,
};
