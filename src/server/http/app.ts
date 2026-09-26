import { Hono } from 'hono';
import { ownerExists } from '../auth/sessions';
import { newId } from '../util';
import type { AppEnv } from './context';
import { csrf, errorResponse, loadSession, securityHeaders, withConfig } from './middleware';
import { appRoutes } from './routes-app';
import { authRoutes } from './routes-auth';

/**
 * The HTTP API, mounted under /api. Static assets (the PWA) are served by the
 * Workers assets binding before this app is reached.
 */
export function createApp() {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', securityHeaders);
  app.use('*', withConfig);
  app.use('*', csrf);
  app.use('*', loadSession);

  // Public, minimal: tells a load balancer or the user the Worker is up.
  app.get('/health', async (c) => {
    let db = 'ok';
    try {
      await ownerExists(c.env.DB);
    } catch {
      db = 'erreur';
    }
    return c.json({ ok: true, data: { status: db === 'ok' ? 'ok' : 'dégradé', db, version: '0.1.0' } });
  });

  app.route('/auth', authRoutes);
  app.route('/', appRoutes);

  app.notFound((c) => c.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Route inconnue' } }, 404));
  app.onError((err, c) => {
    const { status, body } = errorResponse(err, newId());
    return c.json(body, status);
  });
  return app;
}
