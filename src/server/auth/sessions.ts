import { bytesToBase64Url, newId, sha256Hex } from '../util';

/**
 * Owner account and sessions.
 *
 * The session token is 256 random bits, sent in an HttpOnly/Secure/SameSite=Strict
 * `__Host-` cookie. Only its SHA-256 hash is stored: a copy of the database does
 * not give access to a live session.
 */

export const SESSION_COOKIE = '__Host-trevor_session';
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
export const SESSION_IDLE_MS = 14 * 24 * 3_600_000;
export const STEP_UP_WINDOW_MS = 10 * 60_000;
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60_000;
export const IP_WINDOW_MS = 15 * 60_000;
export const IP_MAX_ATTEMPTS = 10;

type Row = Record<string, unknown>;

export interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string;
  readonly failedLogins: number;
  readonly lockedUntil: number | null;
  readonly createdAt: number;
}

function mapUser(r: Row): UserRow {
  return {
    id: String(r.id),
    email: String(r.email),
    passwordHash: String(r.password_hash),
    failedLogins: Number(r.failed_logins),
    lockedUntil: r.locked_until === null ? null : Number(r.locked_until),
    createdAt: Number(r.created_at),
  };
}

export async function ownerExists(db: D1Database): Promise<boolean> {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM users').first<Row>();
  return Number(r?.n ?? 0) > 0;
}

export async function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  const r = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first<Row>();
  return r ? mapUser(r) : null;
}

export async function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  const r = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Row>();
  return r ? mapUser(r) : null;
}

/**
 * Creates the owner only if no user exists yet — the check and the insert are one
 * statement, so two concurrent setup requests cannot both succeed.
 */
export async function createOwner(db: D1Database, email: string, passwordHash: string, now: number): Promise<string | null> {
  const id = newId();
  const res = await db
    .prepare(
      `INSERT INTO users (id, email, password_hash, created_at, password_changed_at)
       SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(id, email.toLowerCase(), passwordHash, now, now)
    .run();
  return (res.meta?.changes ?? 0) > 0 ? id : null;
}

export async function recordFailedLogin(db: D1Database, user: UserRow, now: number): Promise<void> {
  const failed = user.failedLogins + 1;
  const lockedUntil = failed >= LOCKOUT_THRESHOLD ? now + LOCKOUT_MS : user.lockedUntil;
  await db
    .prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
    .bind(failed >= LOCKOUT_THRESHOLD ? 0 : failed, lockedUntil, user.id)
    .run();
}

export async function recordSuccessfulLogin(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').bind(userId).run();
}

// ------------------------------------------------------------------ throttle

export async function ipHash(ip: string, pepper: string): Promise<string> {
  return sha256Hex(`${pepper}:${ip}`);
}

export async function tooManyAttempts(db: D1Database, ipHashValue: string, now: number): Promise<boolean> {
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip_hash = ? AND ts >= ? AND success = 0')
    .bind(ipHashValue, now - IP_WINDOW_MS)
    .first<Row>();
  return Number(r?.n ?? 0) >= IP_MAX_ATTEMPTS;
}

export async function recordAttempt(db: D1Database, ipHashValue: string, now: number, success: boolean): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO login_attempts (ip_hash, ts, success) VALUES (?, ?, ?)').bind(ipHashValue, now, success ? 1 : 0),
    db.prepare('DELETE FROM login_attempts WHERE ts < ?').bind(now - 24 * 3_600_000),
  ]);
}

// ------------------------------------------------------------------ sessions

export interface SessionRow {
  readonly tokenHash: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly lastSeenAt: number;
  readonly stepUpUntil: number;
}

export async function createSession(
  db: D1Database,
  userId: string,
  now: number,
  userAgent: string | null,
  stepUp: boolean,
): Promise<string> {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, step_up_until, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS, now, stepUp ? now + STEP_UP_WINDOW_MS : 0, userAgent?.slice(0, 200) ?? null)
    .run();
  return token;
}

/** Returns the session if the token is valid, unexpired and not idle; refreshes last-seen. */
export async function resolveSession(db: D1Database, token: string, now: number): Promise<SessionRow | null> {
  const hash = await sha256Hex(token);
  const r = await db.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(hash).first<Row>();
  if (!r) return null;
  const s: SessionRow = {
    tokenHash: hash,
    userId: String(r.user_id),
    createdAt: Number(r.created_at),
    expiresAt: Number(r.expires_at),
    lastSeenAt: Number(r.last_seen_at),
    stepUpUntil: Number(r.step_up_until),
  };
  if (s.expiresAt <= now || now - s.lastSeenAt > SESSION_IDLE_MS) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }
  if (now - s.lastSeenAt > 60_000) {
    await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').bind(now, hash).run();
  }
  return s;
}

export async function grantStepUp(db: D1Database, tokenHash: string, now: number): Promise<number> {
  const until = now + STEP_UP_WINDOW_MS;
  await db.prepare('UPDATE sessions SET step_up_until = ? WHERE token_hash = ?').bind(until, tokenHash).run();
  return until;
}

export async function deleteSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

export async function deleteAllSessions(db: D1Database, userId: string): Promise<number> {
  const res = await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  return res.meta?.changes ?? 0;
}

export async function listSessions(db: D1Database, userId: string) {
  const { results } = await db
    .prepare('SELECT token_hash, created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
    .bind(userId)
    .all<Row>();
  return results.map((r) => ({
    id: String(r.token_hash).slice(0, 12),
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    expiresAt: Number(r.expires_at),
    userAgent: r.user_agent === null ? null : String(r.user_agent),
  }));
}
