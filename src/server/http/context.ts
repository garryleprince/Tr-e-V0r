import type { Context } from 'hono';
import { CandleService } from '../data/candle-service';
import { buildProviders } from '../data/registry';
import { deskStub } from '../desk/stub';
import type { Env, RuntimeConfig } from '../env';
import type { SessionRow, UserRow } from '../auth/sessions';

/**
 * Per-request context: configuration, authenticated session, and the services
 * routes need. Built lazily so public routes do not pay for them.
 */

export interface AppVariables {
  config: RuntimeConfig;
  session: SessionRow | null;
  user: UserRow | null;
  sessionToken: string | null;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
export type AppContext = Context<AppEnv>;

export function services(c: AppContext) {
  const db = c.env.DB;
  const config = c.get('config');
  const now = () => Date.now();
  const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
  return {
    db,
    config,
    now,
    candles: new CandleService(db, buildProviders(config, fetcher, now), now),
    desk: deskStub(c.env),
  };
}

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function ok<T>(c: AppContext, data: T, status: 200 | 201 = 200) {
  return c.json({ ok: true as const, data }, status);
}

export function requireUser(c: AppContext): { user: UserRow; session: SessionRow } {
  const user = c.get('user');
  const session = c.get('session');
  if (!user || !session) throw new HttpError(401, 'UNAUTHENTICATED', 'Connexion requise');
  return { user, session };
}

export function hasStepUp(c: AppContext): boolean {
  const session = c.get('session');
  return session !== null && session.stepUpUntil > Date.now();
}
