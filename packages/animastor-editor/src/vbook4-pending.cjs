// ======================================================
// VBook 4 — what the editor does until its own step lands
// ======================================================
// @animastor/vbook-runtime 0.5.0 (VBOOK_FORMAT_V4 §12, step 1) removed the 3.1
// maps book.characters / book.voices / book.behaviors and behavior-schema.cjs.
// The hero API of the editor (POST/PATCH/DELETE /heroes, rules, looks,
// GET/PATCH /behaviour — §8.2) is STEP 4 and is not written yet.
//
// Until then the editor must neither crash on load nor pretend: the routes
// that edited the 3.1 maps answer 409 `vbook_v4_pending` instead of writing a
// map the format no longer has. Step 4 deletes this file together with those
// routes.

'use strict';

const LEGACY_BODY_KEYS = Object.freeze(['characters', 'voices', 'behaviors', 'behavior_rules', 'mentions']);

function pendingBody(what) {
    return {
        error: 'vbook_v4_pending',
        message: `${what} belongs to VBook 3.1. In VBook 4 heroes are edited through /heroes (VBOOK_FORMAT_V4 §8.2), which is not available yet.`,
    };
}

/**
 * Route-level gate, registered as the FIRST handler of each of the nine 3.1
 * routes (POST /<entity>, PATCH|DELETE /<entity>/<id> for characters, voices,
 * behaviors): answers 409 and never calls the 3.1 handler behind it.
 * The voice-reference API (/voices/references, /voices/<id>/reference…) is a
 * different set of routes and is not gated.
 */
function legacyEntityGate(req, res) {
    const entity = /\/(characters|voices|behaviors)(\/|$)/.exec((req && (req.path || req.url)) || '');
    return res.status(409).json(pendingBody(`/${entity ? entity[1] : 'characters'}`));
}

/** Keys of a PUT /book body that VBook 4 does not have. */
function legacyBodyKeys(body) {
    if (!body || typeof body !== 'object') return [];
    return LEGACY_BODY_KEYS.filter((key) => body[key] !== undefined);
}

function unreachable() {
    throw new Error('vbook_v4_pending: this 3.1 code path is gated and must not run');
}

module.exports = {
    legacyEntityGate,
    legacyBodyKeys,
    pendingBody,
    // stand-ins for the removed behavior-schema.cjs helpers; only gated code calls them
    behaviorCharacters: unreachable,
    removeCharacterBehaviors: unreachable,
};
