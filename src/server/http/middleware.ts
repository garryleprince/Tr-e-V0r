import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { findUserById, resolveSession } from '../auth/sessions';
import { ConfigError, readConfig } from '../env';
import { errorMessage, log } from '../util';
import { HttpError, type AppEnv } from './context';

export const SESSION_COOKIE_NAME = 'trevor_session';

/** Security headers on every API response (static assets get them from public/_headers). */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cache-Control', 'no-store');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  c.header('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
};

/** Reads and validates configuration once per request. */
export const withConfig: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    c.set('config', readConfig(c.env));
  } catch (err) {
    if (err instanceof ConfigError) throw new HttpError(503, 'MISCONFIGURED', err.message);
    throw err;
  }
  await next();
};

/**
 * CSRF defence in depth: SameSite=Strict cookies, plus a custom header that a
 * cross-site form cannot set, plus an Origin check when the browser sends one.
 */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    if (c.req.header('X-Trevor-Client') !== '1') {
      throw new HttpError(403, 'CSRF', 'En-tête client manquant');
    }
    const origin = c.req.header('Origin');
    if (origin) {
      const expected = new URL(c.req.url).origin;
      if (origin !== expected) throw new HttpError(403, 'CSRF', 'Origine non autorisée');
    }
  }
  await next();
};

/** Attaches the session and user when a valid session cookie is present. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('session', null);
  c.set('user', null);
  c.set('sessionToken', null);
  const token = getCookie(c, SESSION_COOKIE_NAME, 'host');
  if (token) {
    const session = await resolveSession(c.env.DB, token, Date.now());
    if (session) {
      const user = await findUserById(c.env.DB, session.userId);
      if (user) {
        c.set('session', session);
        c.set('user', user);
        c.set('sessionToken', token);
      }
    }
  }
  await next();
};

export function errorResponse(err: unknown, requestId: string) {
  if (err instanceof HttpError) {
    return {
      status: err.status,
      body: { ok: false as const, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
    };
  }
  log('error', 'unhandled error', { requestId, error: errorMessage(err), stack: err instanceof Error ? err.stack : undefined });
  return {
    status: 500 as const,
    body: { ok: false as const, error: { code: 'INTERNAL', message: 'Erreur interne. Consultez les journaux du Worker.', requestId } },
  };
}
