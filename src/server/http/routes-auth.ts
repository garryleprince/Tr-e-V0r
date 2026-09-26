import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { hashPassword, passwordProblems, verifyPassword } from '../auth/password';
import {
  createOwner,
  createSession,
  deleteAllSessions,
  deleteSession,
  findUserByEmail,
  grantStepUp,
  ipHash,
  listSessions,
  ownerExists,
  recordAttempt,
  recordFailedLogin,
  recordSuccessfulLogin,
  SESSION_TTL_MS,
  tooManyAttempts,
} from '../auth/sessions';
import { addEvent } from '../db/core';
import { timingSafeEqual } from '../util';
import { HttpError, ok, requireUser, type AppContext, type AppEnv } from './context';
import { SESSION_COOKIE_NAME } from './middleware';

/**
 * Authentication routes. One owner account per deployment, created once with
 * the SETUP_TOKEN secret (docs/RISQUE_ET_SECURITE.md §B.2).
 */

const EmailSchema = z.string().trim().toLowerCase().email().max(200);
const SetupSchema = z.strictObject({
  setupToken: z.string().min(1).max(500),
  email: EmailSchema,
  password: z.string().min(1).max(256),
});
const LoginSchema = z.strictObject({ email: EmailSchema, password: z.string().min(1).max(256) });
const StepUpSchema = z.strictObject({ password: z.string().min(1).max(256) });

export const authRoutes = new Hono<AppEnv>();

authRoutes.get('/status', async (c) => {
  const user = c.get('user');
  return ok(c, {
    installed: await ownerExists(c.env.DB),
    setupAvailable: c.get('config').setupToken !== null,
    authenticated: user !== null,
    user: user ? { email: user.email } : null,
    stepUpUntil: c.get('session')?.stepUpUntil ?? 0,
  });
});

authRoutes.post('/setup', async (c) => {
  const body = await parse(c, SetupSchema);
  const config = c.get('config');
  if (!config.setupToken) {
    throw new HttpError(403, 'SETUP_DISABLED', 'Installation désactivée : le secret SETUP_TOKEN n’est pas configuré.');
  }
  const now = Date.now();
  const ip = await ipHash(clientIp(c), config.sessionPepper);
  if (await tooManyAttempts(c.env.DB, ip, now)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Trop de tentatives. Réessayez dans 15 minutes.');
  if (!timingSafeEqual(body.setupToken, config.setupToken)) {
    await recordAttempt(c.env.DB, ip, now, false);
    throw new HttpError(403, 'BAD_SETUP_TOKEN', 'Jeton d’installation invalide.');
  }
  const problems = passwordProblems(body.password);
  if (problems.length > 0) throw new HttpError(422, 'WEAK_PASSWORD', `Mot de passe : ${problems.join(', ')}.`);
  const userId = await createOwner(c.env.DB, body.email, await hashPassword(body.password), now);
  if (!userId) throw new HttpError(409, 'ALREADY_INSTALLED', 'Le compte propriétaire existe déjà.');
  await recordAttempt(c.env.DB, ip, now, true);
  await addEvent(c.env.DB, { ts: now, type: 'setup', severity: 'info', actor: 'user', title: 'Compte propriétaire créé' });
  await startSession(c, userId, true);
  return ok(c, { email: body.email }, 201);
});

authRoutes.post('/login', async (c) => {
  const body = await parse(c, LoginSchema);
  const config = c.get('config');
  const now = Date.now();
  const ip = await ipHash(clientIp(c), config.sessionPepper);
  if (await tooManyAttempts(c.env.DB, ip, now)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Trop de tentatives. Réessayez dans 15 minutes.');
  const user = await findUserByEmail(c.env.DB, body.email);
  if (user && user.lockedUntil !== null && user.lockedUntil > now) {
    throw new HttpError(429, 'LOCKED', 'Compte temporairement verrouillé après plusieurs échecs. Réessayez dans 15 minutes.');
  }
  // Always hash, even for an unknown e-mail, so timing does not reveal accounts.
  const valid = user ? await verifyPassword(body.password, user.passwordHash) : (await hashPassword(body.password), false);
  await recordAttempt(c.env.DB, ip, now, valid);
  if (!user || !valid) {
    if (user) await recordFailedLogin(c.env.DB, user, now);
    await addEvent(c.env.DB, { ts: now, type: 'login_failed', severity: 'warning', actor: 'user', title: 'Échec de connexion' });
    throw new HttpError(401, 'BAD_CREDENTIALS', 'E-mail ou mot de passe incorrect.');
  }
  await recordSuccessfulLogin(c.env.DB, user.id);
  await addEvent(c.env.DB, { ts: now, type: 'login', severity: 'info', actor: 'user', title: 'Connexion' });
  await startSession(c, user.id, true);
  return ok(c, { email: user.email });
});

authRoutes.post('/logout', async (c) => {
  const session = c.get('session');
  if (session) await deleteSession(c.env.DB, session.tokenHash);
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/', secure: true, prefix: 'host' });
  return ok(c, { loggedOut: true });
});

authRoutes.post('/logout-all', async (c) => {
  const { user } = requireUser(c);
  const n = await deleteAllSessions(c.env.DB, user.id);
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/', secure: true, prefix: 'host' });
  await addEvent(c.env.DB, { ts: Date.now(), type: 'logout_all', severity: 'warning', actor: 'user', title: `Toutes les sessions fermées (${n})` });
  return ok(c, { closed: n });
});

authRoutes.post('/step-up', async (c) => {
  const { user, session } = requireUser(c);
  const body = await parse(c, StepUpSchema);
  const now = Date.now();
  const ip = await ipHash(clientIp(c), c.get('config').sessionPepper);
  if (await tooManyAttempts(c.env.DB, ip, now)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Trop de tentatives.');
  const valid = await verifyPassword(body.password, user.passwordHash);
  await recordAttempt(c.env.DB, ip, now, valid);
  if (!valid) {
    await recordFailedLogin(c.env.DB, user, now);
    throw new HttpError(401, 'BAD_CREDENTIALS', 'Mot de passe incorrect.');
  }
  const until = await grantStepUp(c.env.DB, session.tokenHash, now);
  return ok(c, { stepUpUntil: until });
});

authRoutes.get('/sessions', async (c) => {
  const { user } = requireUser(c);
  return ok(c, await listSessions(c.env.DB, user.id));
});

async function startSession(c: AppContext, userId: string, stepUp: boolean) {
  const token = await createSession(c.env.DB, userId, Date.now(), c.req.header('User-Agent') ?? null, stepUp);
  setCookie(c, SESSION_COOKIE_NAME, token, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    prefix: 'host',
  });
}

export function clientIp(c: AppContext): string {
  return c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? '0.0.0.0';
}

export async function parse<T>(c: AppContext, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'Corps de requête JSON invalide.');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(
      422,
      'VALIDATION',
      'Données invalides.',
      parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return parsed.data;
}
