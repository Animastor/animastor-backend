// ======================================================
// Editor boundary — facade over the Canonical Book Model (Phase 6)
// ======================================================
// The Editor (book content editing routes) must work with the canonical
// book model through this seam only, with the three edit phases explicit:
//
//   1. READ    — read(bookId, { mode }): loads the model via the Canonical
//                Book Model facade ('full' by default; 'lazy' for draft/
//                in-progress books). null when the book does not exist.
//   2. MODIFY  — NOT a facade operation: route handlers transform the plain
//                model object they received from read(). The model is a
//                plain JSON-shaped structure; modification stays explicit
//                at the call site instead of being hidden in the seam.
//   3. COMMIT  — commit(book, files): persists the model through the ONE
//                canonical bundle writer (book.saveBookBundle), injected at
//                the composition root. No parallel storage path, no new
//                format, no new DB.
//
// ── Allowed dependencies ────────────────────────────────────────────────
//   - Canonical Book Model facade (@animastor/vbook-runtime/book-model.cjs
//     — the host book shim re-exports it; same dependency the Player
//     facade in @animastor/player uses)
//   - node builtins
// Everything else (orchestration, runtime, Redis, PG/storage, providers,
// services) is FORBIDDEN — enforced by
// tests/architecture/phase6-editor-player.test.js.

const bookModel = require('@animastor/vbook-runtime/book-model.cjs');
// Hero files (VBOOK_FORMAT_V4 §10.1): point writes of ONE hero go through the
// character store of the runtime — the only writer of characters/<id>.json —
// never through a rewrite of the whole book.
const characterStore = require('@animastor/vbook-runtime/character-store.cjs');
const { getBookDir } = require('@animastor/vbook-runtime/lazy-book/paths');

/**
 * Create the Editor model facade.
 * @param {{ bookModel?: object, persistBook: (book: object, files?: object|null) => object }} deps
 *        persistBook — the canonical bundle writer (book.saveBookBundle).
 */
function createEditorModel(deps = {}) {
    const model = deps.bookModel || bookModel;
    const persist = deps.persistBook;
    if (typeof persist !== 'function') {
        throw new Error('createEditorModel requires persistBook (the canonical bundle writer)');
    }
    const store = deps.characterStore || characterStore;
    const bookDirOf = deps.getBookDir || getBookDir;

    return {
        read(bookId, options) {
            return model.loadBook(bookId, options);
        },
        // VBook 4 saves the book object only (the raw-files mode is gone).
        commit(book) {
            return persist(book);
        },
        /**
         * COMMIT of one hero file (MODIFY happens in the caller's mutator):
         * every function is synchronous — read, change, validate and the
         * atomic write run without an await in between, so two requests for
         * two different heroes never overwrite each other (§10.1).
         */
        heroes(bookId) {
            const dir = bookDirOf(bookId);
            return {
                inspect: (heroId) => store.inspectCharacter(dir, heroId),
                read: (heroId) => store.readCharacter(dir, heroId),
                create: (hero) => store.writeCharacter(dir, hero),
                update: (heroId, mutate) => store.updateCharacter(dir, heroId, mutate),
                remove: (heroId, options) => store.removeCharacter(dir, heroId, options),
                removeEntry: (name) => store.removeCharacterEntry(dir, name),
            };
        },
    };
}

module.exports = { createEditorModel };
