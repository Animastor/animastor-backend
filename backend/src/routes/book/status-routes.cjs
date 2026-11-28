// Book status / state read-only routes.
//
// Split out of book-routes.cjs (Architectural Debt #3, sub-registrar pattern).
//
// ctx fields used here: { genSessionRepo, lazyBook, txtImporter }

module.exports = function registerStatusRoutes(app, ctx) {
    const { genSessionRepo, lazyBook, txtImporter, log } = ctx;

    // GET /api/v1/book/:bookId/generation-state was removed 2026-11-28 (ORCHESTRATION_V2 §11.3).

    // GET /api/v1/book/:bookId/status
    app.get('/api/v1/book/:bookId/status', async (req, res) => {
        try {
            const { bookId } = req.params;
            const status = lazyBook.getBookStatus(bookId);
            if (!status) return res.status(404).json({ error: 'Book not found' });

            // N4: server decides "ready" (bootstrapped/active with parsed content)
            // so the client doesn't match state strings + a parsedChapters threshold.
            const ready = (status.state === lazyBook.BookState.BOOTSTRAPPED ||
                           status.state === lazyBook.BookState.ACTIVE) &&
                          (status.parsedChapters || 0) > 0;

            const genState = await genSessionRepo.getGenerationState(bookId);
            return res.json({
                ...status, ready, generation_status: genState.status,
                last_window_index: genState.last_window_index,
                generation_error: genState.error,
                active_generation: genState.active_status,
            });
        } catch (err) {
            console.error('BOOK STATUS ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    // (GET /api/v1/book/:bookId/source-chapters — removed 2026-11-28,
    // ORCHESTRATION_V2 этап 4: no caller in web / Android.)

    // GET /api/v1/book/:bookId/chapters-summary
    app.get('/api/v1/book/:bookId/chapters-summary', async (req, res) => {
        try {
            const { bookId } = req.params;
            const summary = txtImporter.getParsedChaptersSummary(bookId);
            if (!summary) return res.status(404).json({ error: 'Book not found' });
            return res.json(summary);
        } catch (err) {
            console.error('CHAPTERS SUMMARY ERROR:', err);
            return res.status(400).json({ error: err.message || 'unknown error' });
        }
    });

    log('[ROUTES] Book status routes loaded');
};
