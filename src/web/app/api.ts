import { StepUpCancelled, useApp } from './store';
import type { ApiErrorBody, AuthStatus } from './types';

/**
 * The only door to the server. Every request carries the `X-Trevor-Client`
 * header the CSRF middleware expects; the session travels in an HttpOnly
 * cookie the page cannot read. No key, token or secret ever reaches this code.
 *
 * When the server answers STEP_UP_REQUIRED, the owner is asked for the password
 * again and the request is replayed once — the server still decides.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Method = 'GET' | 'POST' | 'PUT';
type Envelope<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody };

async function raw<T>(method: Method, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Trevor-Client': '1',
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'Serveur injoignable. Vérifiez la connexion.');
  }
  const payload = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (payload && payload.ok) return payload.data;
  const error = payload && !payload.ok ? payload.error : { code: 'HTTP_' + res.status, message: `Erreur ${res.status}` };
  throw new ApiError(res.status, error.code, error.message, error.details);
}

export async function api<T>(method: Method, path: string, body?: unknown, opts: { signal?: AbortSignal; stepUpReason?: string } = {}): Promise<T> {
  try {
    return await raw<T>(method, path, body, opts.signal);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'UNAUTHENTICATED') {
      const auth = useApp.getState().auth;
      if (auth) useApp.getState().setAuth({ ...auth, authenticated: false, user: null, stepUpUntil: 0 });
    }
    if (err instanceof ApiError && err.code === 'STEP_UP_REQUIRED' && method !== 'GET') {
      await useApp.getState().requestStepUp(opts.stepUpReason ?? err.message);
      return raw<T>(method, path, body, opts.signal);
    }
    throw err;
  }
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>('GET', path, undefined, signal ? { signal } : {});
export const post = <T>(path: string, body: unknown = {}, stepUpReason?: string) =>
  api<T>('POST', path, body, stepUpReason ? { stepUpReason } : {});
export const put = <T>(path: string, body: unknown, stepUpReason?: string) => api<T>('PUT', path, body, stepUpReason ? { stepUpReason } : {});

export async function refreshAuth(): Promise<AuthStatus> {
  const status = await raw<AuthStatus>('GET', '/auth/status');
  useApp.getState().setAuth(status);
  return status;
}

/** Human message for any thrown value; a cancelled step-up is not an error. */
export function errorText(err: unknown): string | null {
  if (err instanceof StepUpCancelled) return null;
  if (err instanceof DOMException && err.name === 'AbortError') return null;
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Erreur inattendue';
}

/** Runs a mutation, reports its outcome as a toast and refreshes screens. */
export async function mutate<T>(fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | null> {
  const app = useApp.getState();
  try {
    const result = await fn();
    if (success) app.toast('success', typeof success === 'function' ? success(result) : success);
    app.bump();
    return result;
  } catch (err) {
    const text = errorText(err);
    if (text) app.toast('error', text);
    return null;
  }
}
