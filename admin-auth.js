import crypto from 'crypto';
import { logInfo, logDebug } from './logger.js';

// Hardcoded admin credentials
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = '123000aaa...A';

// Session store: Map<sessionId, { username, createdAt, expiresAt }>
const sessions = new Map();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Cleanup expired sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt < now) {
      sessions.delete(id);
    }
  }
}, 60 * 60 * 1000);

/**
 * Verify admin credentials
 */
export function verifyCredentials(username, password) {
  return username === ADMIN_USERNAME && password === ADMIN_PASSWORD;
}

/**
 * Create a new session and return session ID
 */
export function createSession(username) {
  const sessionId = crypto.randomUUID();
  const now = Date.now();
  sessions.set(sessionId, {
    username,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  });
  logDebug(`Session created for ${username}: ${sessionId}`);
  return sessionId;
}

/**
 * Validate a session ID
 */
export function validateSession(sessionId) {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

/**
 * Destroy a session
 */
export function destroySession(sessionId) {
  sessions.delete(sessionId);
}

/**
 * Parse session ID from cookie header string
 */
function getSessionIdFromCookies(cookieHeader) {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';').map(c => c.trim());
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.split('=');
    if (name.trim() === 'admin_session') {
      return rest.join('=').trim();
    }
  }
  return null;
}

/**
 * Express middleware: require admin authentication
 * Checks cookie for session ID
 */
export function requireAuth(req, res, next) {
  const sessionId = getSessionIdFromCookies(req.headers.cookie);

  if (!validateSession(sessionId)) {
    return res.status(401).json({ error: 'Unauthorized', message: 'Please login first' });
  }

  req.adminSession = sessionId;
  next();
}

/**
 * Express middleware: redirect to login if not authenticated (for page routes)
 */
export function requireAuthPage(req, res, next) {
  const sessionId = getSessionIdFromCookies(req.headers.cookie);

  if (!validateSession(sessionId)) {
    return res.redirect('/admin');
  }

  req.adminSession = sessionId;
  next();
}
