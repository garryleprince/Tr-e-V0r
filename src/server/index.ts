import { CandleService } from './data/candle-service';
import { buildProviders } from './data/registry';
import { beat, getSettings } from './db/core';
import { deskStub } from './desk/stub';
import { readConfig, type Env } from './env';
import { createApp } from './http/app';
import { runWatchlistCycle } from './jobs/analysis';
import { runMonitor } from './jobs/monitor';
import { errorMessage, log } from './util';

export { TradingDesk } from './desk/desk';

/**
 * Worker entry point.
 * - fetch: /api/* → Hono app; everything else → static assets (the PWA).
 * - scheduled: the autonomous loop (docs/ARCHITECTURE.md §3).
 */

const app = createApp();

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return app.fetch(request, env, ctx);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const config = readConfig(env);
    const now = () => Date.now();
    const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
    const candles = new CandleService(env.DB, buildProviders(config, fetcher, now, env.DB), now);
    const desk = deskStub(env);

    const task = async () => {
      if (event.cron !== '*/15 * * * *') {
        const settings = await getSettings(env.DB);
        if (settings.schedule.analysisEnabled) {
          try {
            const outcomes = await runWatchlistCycle({ db: env.DB, config, candles, desk, now }, 'schedule');
            await beat(env.DB, 'analysis', now(), 'ok', outcomes.map((o) => `${o.status}:${o.decisionStatus ?? '-'}`).join(', '));
          } catch (err) {
            await beat(env.DB, 'analysis', now(), 'error', errorMessage(err));
            log('error', 'analysis cycle failed', { error: errorMessage(err) });
          }
        } else {
          await beat(env.DB, 'analysis', now(), 'disabled', 'cycle d’analyse désactivé dans les réglages');
        }
      }
      try {
        await runMonitor({ db: env.DB, candles, desk, now });
      } catch (err) {
        await beat(env.DB, 'monitor', now(), 'error', errorMessage(err));
        log('error', 'monitor failed', { error: errorMessage(err) });
      }
    };
    ctx.waitUntil(task());
  },
} satisfies ExportedHandler<Env>;
