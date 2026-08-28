import crypto from 'node:crypto';
import { q, insertId, nowIso } from './db.js';
import { SESSION_TTL_MS } from './config.js';

const COOKIE_NAME = 'emr_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * SCRYPT.N * SCRYPT.r * 2,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 128 * Number(N) * Number(r) * 2,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function userCount() {
  return q('SELECT COUNT(*) AS n FROM users').get().n;
}

export function adminCount() {
  return q("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}

export function createUser({ username, password, fullName, role = 'user' }) {
  const res = q(
    `INSERT INTO users (username, full_name, password_hash, role, password_changed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(username, fullName || '', hashPassword(password), role, nowIso(), nowIso());
  return insertId(res);
}

export function findUser(username) {
  return q('SELECT * FROM users WHERE username = ?').get(username) ?? null;
}

export function findUserById(id) {
  return q('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function listUsers() {
  return q(
    `SELECT id, username, full_name, role, password_changed_at, created_at
       FROM users ORDER BY id`
  ).all();
}

export function setPassword(userId, newPassword) {
  q('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(
    hashPassword(newPassword),
    nowIso(),
    userId
  );
}

export function setRole(userId, role) {
  q('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
}

export function setFullName(userId, fullName) {
  q('UPDATE users SET full_name = ? WHERE id = ?').run(fullName, userId);
}

export function deleteUser(userId) {
  q('DELETE FROM users WHERE id = ?').run(userId);
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  q('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token,
    userId,
    nowIso(),
    expires
  );
  return { token, expires };
}

export function destroySession(token) {
  if (token) q('DELETE FROM sessions WHERE token = ?').run(token);
}

/**
 * Signs a user out everywhere. Called on every password change: if the reason for
 * changing is that someone else may have got in, leaving their 12-hour session
 * alive would defeat the entire point. The person who made the change is handed a
 * fresh cookie immediately, so only other devices actually notice.
 */
export function destroyUserSessions(userId) {
  q('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function purgeExpiredSessions() {
  q('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE_NAME] ?? null;
}

/** Resolves the signed-in user for a request, or null. Expired tokens are cleaned up on sight. */
export function currentUser(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const row = q(
    `SELECT u.id, u.username, u.full_name, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`
  ).get(token);
  if (!row) return null;
  if (row.expires_at < nowIso()) {
    destroySession(token);
    return null;
  }
  return { id: row.id, username: row.username, fullName: row.full_name, role: row.role };
}

export function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name ?? row.fullName ?? '',
    role: row.role,
    passwordChangedAt: row.password_changed_at ?? null,
    createdAt: row.created_at ?? null,
  };
}

export function sessionCookie(token, expiresIso) {
  return [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresIso).toUTCString()}`,
  ].join('; ');
}

export function clearedCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Throttles password guessing per username+IP. In-memory on purpose: a restart
 * clearing the counters is acceptable, an extra dependency is not.
 */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function loginBlocked(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

export function noteFailedLogin(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) {
    attempts.set(key, { first: Date.now(), count: 1 });
  } else {
    entry.count += 1;
  }
}

export function clearLoginAttempts(key) {
  attempts.delete(key);
}
