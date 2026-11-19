// ======================================================
// Auth Context Middleware — HTTP adapter (Extraction Phase 1)
// ======================================================
// Identity resolution for every request (Auth MVP + Guest Workspace MVP):
//
//   request → cookies → identity → req.auth.kind = 'user' | 'guest' | 'none'
//
//   user  : `animastor_sid` → sessions → users      → req.user + req.workspace
//   guest : `animastor_gid` → guests  → workspaces  → req.guest + req.workspace
//                                                     (type 'temporary')
//   none  : no cookie at all — pre-auth reads keep the historical "everyone
//           sees everything" behaviour. A guest identity is provisioned only
//           on content-generating WRITE requests (POST/PUT/PATCH under
//           /api/v1, never on /auth) so work persists server-side the moment
//           it is created, yet plain browsing never scatters throwaway
//           workspaces. Everything outside /api/v1 stays unauthenticated.
//
// The guest is NEVER a fake user: req.user stays null, the identity lives on
// req.guest, and ownership resolution (guards) treats the guest's temporary
// workspace exactly like a personal one — same ownership chain
// `identity → workspace → book`, no second ownership system.
//
// EXTRACTION PHASE 1 (audit §8): this module is now a thin HTTP ADAPTER —
// it holds NO authorization logic of its own. Every decision delegates to
// the canonical layer (auth/book-access.js via the wired authService);
// this file only:
//   - reads identity from req (cookies), calls the domain, maps results to
//     HTTP statuses/bodies (401/403/410 semantics FROZEN);
//   - keeps the host-side policies that are path/transport-shaped: guest
//     auto-provision with its route exemptions (/auth, /worker,
//     /ai-connector, /admin) and the Secure-flag detection;
//   - requireAdmin / requireWorkspaceMembership are admin/workspace-surface
//     policies (host-owned per audit §4.2), kept here unchanged.
// ======================================================

const authService = require('../auth/auth-service');

/** True when the request carries ANY recognized identity (user or guest). */
function hasIdentity(req) {
    return !!(req && (req.user || req.guest));
}

/** Identity projection the domain layer consumes (plain objects, no req). */
function identityOf(req) {
    if (!req) return null;
    if (req.user) return { user: req.user, workspace: req.workspace };
    if (req.guest) return { guest: req.guest, workspace: req.workspace };
    return null;
}

/**
 * Authentication context middleware.
 * Resolution order: authenticated session → guest identity (an EXISTING
 * guest cookie only). Any lookup failure degrades downward instead of
 * 500-ing every request during a transient PG outage.
 *
 * Owner's decision 18.11 (VBook v4 step 5): a guest identity is never minted
 * on any route. An anonymous write — and any anonymous request to
 * /api/v1/book/* — answers 401 login_required (requireIdentityForWrites);
 * the fronts open the sign-in window on 401. Guests created before keep
 * resolving until their workspace expires (register still converts them).
 */
/** Every value of a cookie name, in header order (compat: single-value parser). */
function readAllCookies(req, name) {
    if (authService.parseCookieHeaders) {
        return authService.parseCookieHeaders(req.headers && req.headers.cookie, name);
    }
    const one = authService.readCookie ? authService.readCookie(req, name) : null;
    return one ? [one] : [];
}

async function authContext(req, res, next) {
    req.user = null;
    req.guest = null;
    req.workspace = null;
    req.auth = { kind: 'none' };
    try {
        const sessionTokens = readAllCookies(req, authService.SESSION_COOKIE_NAME);
        const guestTokens = readAllCookies(req, authService.GUEST_COOKIE_NAME);
        // RFC 6265: a host-only cookie and a Domain= cookie with the same name
        // are separate records and both arrive in one Cookie header. The first
        // value may be a stale/revoked session (leftover from before
        // COOKIE_DOMAIN), so try every duplicate and take the first LIVE one.
        // One warning per request — a log line per duplicate would flood.
        if (sessionTokens.length > 1 || guestTokens.length > 1) {
            console.warn(`[AUTH-CONTEXT] duplicate session cookies (sid=${sessionTokens.length}, gid=${guestTokens.length}) — using the first valid one`);
        }
        let session = null;
        for (const token of sessionTokens) {
            session = await authService.resolveSession(token);
            if (session) break;
        }
        if (session) {
            req.user = session.user;
            req.workspace = session.workspace;
            req.auth = { kind: 'user' };
            return next();
        }

        let guest = null;
        for (const token of guestTokens) {
            guest = await authService.resolveGuest(token);
            if (guest) break;
        }
        if (guest) {
            const resolved = guest;
            if (resolved) {
                req.guest = resolved.guest;
                req.workspace = resolved.workspace; // includes status/expiresAt
                req.auth = { kind: 'guest' };
                // Activity-based retention: every request bumps the deadline.
                if (resolved.workspace.status === 'active') {
                    await authService.touchGuestWorkspace(resolved.workspace.id);
                }
                return next();
            }
        }

    } catch (err) {
        console.error('[AUTH-CONTEXT] identity resolution failed (anonymous for this request):', err.message);
    }
    next();
}

// Machine surfaces with their own credentials (wrk.* worker tokens, llmc.*
// connector tokens) and the sign-in routes themselves: they decide on their
// own, the cookie identity does not apply.
const ANONYMOUS_WRITE_PREFIXES = ['/api/v1/auth/', '/api/v1/worker/', '/api/v1/ai-connector/'];
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Is this /api/v1 request one an anonymous caller may make (no 401 here)? */
function anonymousAllowed(req) {
    const p = req.path || '';
    if (!p.startsWith('/api/v1/')) return true; // /health, /metrics, /gpu/*, /internal/* — own auth
    if (p === '/api/v1/book' || p.startsWith('/api/v1/book/')) return false; // every method
    if (!WRITE_METHODS.has(req.method)) return true;
    return ANONYMOUS_WRITE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Anonymous write → 401 (owner's decision 18.11). Mounted right after
 * authContext: no route handler runs, no row of users / workspaces / guests
 * is created. A guest or a user passes; their rights are checked further on.
 */
function requireIdentityForWrites(req, res, next) {
    if (hasIdentity(req) || anonymousAllowed(req)) return next();
    return res.status(401).json({ error: 'Authentication required', code: 'login_required' });
}

/** Production/HTTPS detection (transport concern — stays host-side). */
function isHttpsRequest(req) {
    if (process.env.NODE_ENV === 'production') return true;
    const proto = (req.headers && req.headers['x-forwarded-proto']) || '';
    return proto.split(',')[0].trim() === 'https';
}

/**
 * Require authentication middleware.
 * Returns 401 if no user is authenticated.
 * Use this for endpoints that require login.
 */
function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
}

/**
 * Require admin middleware (System AI Control / Admin Foundation).
 * Grants access when the authenticated user has role='admin' OR their
 * username is listed in the ADMIN_USERNAMES env allowlist (comma-separated,
 * case-insensitive). Guests and regular users get 403; anonymous gets 401.
 * The allowlist exists so an operator can grant admin before a password
 * login exists for the seeded account (the seeded 'developer' user has no
 * password and cannot log in yet).
 */
/** Platform admin: role='admin' OR the ADMIN_USERNAMES allowlist (the one predicate). */
function isAdminUser(user) {
    if (!user) return false;
    if (user.role === 'admin') return true;
    const allowlist = (process.env.ADMIN_USERNAMES || '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
    return allowlist.includes(String(user.username || '').toLowerCase());
}

function requireAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    if (!isAdminUser(req.user)) {
        return res.status(403).json({ error: 'Admin access required', code: 'admin_required' });
    }
    next();
}

/**
 * Require workspace membership middleware.
 * Checks that the authenticated user is a member of the workspace.
 * Use this for workspace-scoped endpoints.
 */
function requireWorkspaceMembership(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    const workspaceId = req.workspace?.id || req.params.workspaceId;
    if (!workspaceId) {
        return res.status(400).json({ error: 'Workspace ID required' });
    }

    next();
}

/**
 * Book access authorization helper — adapter over the canonical decision
 * layer. Same contract as the historical implementation: workspace|null,
 * throws WorkspaceExpiredError (410) for an expired guest workspace.
 * Reads identity from req and delegates; NO decision logic here.
 *
 * @returns {Promise<object|null>} Workspace if authorized, null otherwise
 */
async function checkBookAccess(req, bookId) {
    return authService.accessibleBookWorkspace(identityOf(req), bookId);
}

/**
 * Require book access middleware factory.
 * Sets req.bookWorkspace when authorized.
 * 403 on ownership mismatch, 410 for an expired guest workspace.
 *
 * @param {string} bookIdParam - Parameter name containing bookId (default: 'bookId')
 */
function requireBookAccess(bookIdParam = 'bookId') {
    return async (req, res, next) => {
        const bookId = req.params[bookIdParam];
        if (!bookId) {
            return res.status(400).json({ error: 'Book ID required' });
        }
        if (!hasIdentity(req)) {
            return res.status(401).json({ error: 'Authentication required', code: 'login_required' });
        }

        let workspace = null;
        try {
            workspace = await checkBookAccess(req, bookId);
        } catch (err) {
            if (err instanceof authService.WorkspaceExpiredError) {
                return res.status(410).json({ error: 'Guest workspace expired', code: 'workspace_expired' });
            }
            console.error(`[AUTH-CONTEXT] checkBookAccess(${bookId}) failed:`, err.message);
            return res.status(403).json({ error: 'Book ownership could not be verified' }); // fail closed
        }
        if (!workspace) {
            return res.status(403).json({ error: 'Access denied: not a member of the book\'s workspace' });
        }

        req.bookWorkspace = workspace;
        next();
    };
}

/**
 * Async-resolving book guard for non-Express app shapes: resolves the
 * workspace the current user may access `bookId` through (or null).
 * On ownership DB failure the guard DISALLOWS for authenticated users
 * (fail closed), while pre-auth requests keep flowing.
 */
async function getAccessibleBookWorkspace(req, bookId) {
    if (!hasIdentity(req)) return { ok: false, status: 401, workspace: null, mode: 'none' };
    try {
        const ws = await checkBookAccess(req, bookId);
        return ws
            ? { ok: true, workspace: ws, mode: req.guest ? 'guest' : 'auth' }
            : { ok: false, workspace: null, mode: req.guest ? 'guest' : 'auth' };
    } catch (err) {
        if (err instanceof authService.WorkspaceExpiredError) {
            return { ok: false, status: 410, workspace: null, mode: 'expired' };
        }
        console.error(`[AUTH-CONTEXT] getAccessibleBookWorkspace(${bookId}) failed:`, err.message);
        return { ok: false, workspace: null, mode: req.guest ? 'guest' : 'auth' }; // fail closed
    }
}

/**
 * Hash-dedup tenant guard for authenticated imports: re-importing the same
 * source file may only return a book the caller owns. Applies to users AND
 * guests — an identity must never receive another identity's book through
 * dedup. Pre-auth (no identity) keeps the historical dedup behaviour.
 * @param {object} req
 * @param {string} candidateBookId
 * @returns {Promise<boolean>} true when the caller may reuse that book
 */
async function dedupOwnedByCaller(req, candidateBookId) {
    if (!hasIdentity(req)) return true;
    try {
        const ws = await checkBookAccess(req, candidateBookId);
        return !!ws;
    } catch (err) {
        if (err instanceof authService.WorkspaceExpiredError) return false;
        console.error(`[AUTH-CONTEXT] dedupOwnedByCaller(${candidateBookId}) failed:`, err.message);
        return false; // fail closed
    }
}

/**
 * Book-creation authorization for authenticated imports (vbook bundles).
 * The bundle book_id is client-controlled: an authenticated (user OR guest)
 * re-import must never touch, overwrite or reveal a book owned by a foreign
 * workspace. Adapter over the canonical decision layer + the foreign-book
 * workspace lookup (workspaces port).
 * @param {object} req
 * @param {string} bookId
 * @param {object} [opts]
 * @param {boolean} [opts.diskCopyExists] - caller already knows a disk copy
 * @returns {Promise<{allowed:boolean, status?:number, error?:string}>}
 */
async function importBookAllowed(req, bookId, { diskCopyExists = false } = {}) {
    if (!hasIdentity(req)) return { allowed: false, status: 401, error: 'Sign in required' };
    if (!bookId) return { allowed: false, status: 400, error: 'invalid book id' };

    if (req.guest && req.workspace && req.workspace.status === 'expired') {
        return { allowed: false, status: 410, error: 'Guest workspace expired' };
    }
    try {
        const owned = await checkBookAccess(req, bookId);
        if (owned) return { allowed: true };
        const foreignWs = await authService.getWorkspaceIdForBook(bookId);
        if (foreignWs) {
            return { allowed: false, status: 403, error: 'Book belongs to another workspace' };
        }
        if (diskCopyExists) {
            // Copy on disk but no ownership row (PG outage / legacy gap):
            // cannot prove the caller may touch it — fail closed.
            return { allowed: false, status: 403, error: 'Book ownership could not be verified' };
        }
        return { allowed: true };
    } catch (err) {
        if (err instanceof authService.WorkspaceExpiredError) {
            return { allowed: false, status: 410, error: 'Guest workspace expired' };
        }
        console.error(`[AUTH-CONTEXT] importBookAllowed(${bookId}) failed:`, err.message);
        return { allowed: false, status: 403, error: 'Book ownership could not be verified' };
    }
}

/**
 * Get the current user from request context.
 * @param {object} req
 * @returns {object|null} User object or null
 */
function getCurrentUser(req) {
    return req.user || null;
}

/**
 * Get the current workspace from request context.
 * @param {object} req
 * @returns {object|null} Workspace object or null
 */
function getCurrentWorkspace(req) {
    return req.workspace || null;
}

module.exports = {
    authContext,
    requireIdentityForWrites,
    anonymousAllowed,
    requireAuth,
    requireAdmin,
    isAdminUser,
    requireWorkspaceMembership,
    checkBookAccess,
    requireBookAccess,
    getAccessibleBookWorkspace,
    dedupOwnedByCaller,
    importBookAllowed,
    hasIdentity,
    WorkspaceExpiredError: authService.WorkspaceExpiredError,
    getCurrentUser,
    getCurrentWorkspace,
};
