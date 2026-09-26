import { Hono } from 'hono';
import { z } from 'zod';
import { computeMetrics, drawdownSeries } from '../../core/backtest/metrics';
import {
  CostSettingsSchema,
  LlmSettingsSchema,
  ScheduleSettingsSchema,
  WatchlistSettingsSchema,
  type Settings,
} from '../../core/domain/settings';
import { barsPerYear, TimeframeSchema, utcDayStart, type Timeframe } from '../../core/domain/time';
import { ModeSchema, TradingStateSchema } from '../../core/domain/trading';
import { bollinger, sma } from '../../core/quant/indicators';
import { computeSnapshot, MIN_BARS_FOR_SNAPSHOT } from '../../core/quant/features';
import { looseningChanges, RiskLimitsSchema, RISK_LIMIT_LABELS } from '../../core/risk/limits';
import { FIXTURE_NOTICE } from '../data/fixture';
import {
  acknowledgeEvent,
  addEvent,
  countUnacknowledged,
  getInstrument,
  getSettings,
  heartbeats,
  listEvents,
  listInstruments,
  putSetting,
} from '../db/core';
import { getRunDetail, listDecisions, listRuns, llmSpendSince } from '../db/runs';
import { equityCurve, getAccount, listOrders, listTrades, openPositions } from '../db/trading';
import { LiveNotAvailableError, StepUpRequiredError } from '../desk/desk-core';
import { runAnalysis } from '../jobs/analysis';
import { buildLlmProvider } from '../llm/gateway';
import { errorMessage } from '../util';
import { HttpError, hasStepUp, ok, requireUser, services, type AppContext, type AppEnv } from './context';
import { parse } from './routes-auth';

/**
 * Application routes. All of them require an authenticated session (enforced
 * by the `use` below). Trading state changes go through the TradingDesk.
 */

export const appRoutes = new Hono<AppEnv>();

appRoutes.use('*', async (c, next) => {
  requireUser(c);
  await next();
});

// ---------------------------------------------------------------- dashboard

appRoutes.get('/dashboard', async (c) => {
  const s = services(c);
  const settings = await getSettings(s.db);
  const [desk, watchlist, portfolio, decisions, events, unread, llm] = await Promise.all([
    s.desk.view(),
    watchlistSummaries(c, settings),
    portfolioSummary(c, settings),
    listDecisions(s.db, { limit: 5 }),
    listEvents(s.db, { limit: 8 }),
    countUnacknowledged(s.db),
    llmStatus(c, settings),
  ]);
  return ok(c, {
    desk,
    watchlist,
    portfolio,
    latestDecision: decisions[0] ?? null,
    recentDecisions: decisions,
    activity: events,
    unreadAlerts: unread,
    llm,
    dataMode: s.config.marketDataMode,
    dataNotice: s.config.marketDataMode === 'fixture' ? FIXTURE_NOTICE : null,
    now: Date.now(),
  });
});

// ------------------------------------------------------------------- market

appRoutes.get('/market/instruments', async (c) => ok(c, await listInstruments(services(c).db)));

appRoutes.get('/market/watchlist', async (c) => {
  const settings = await getSettings(services(c).db);
  return ok(c, await watchlistSummaries(c, settings));
});

appRoutes.get('/market/:id/candles', async (c) => {
  const s = services(c);
  const instrument = await getInstrument(s.db, c.req.param('id'));
  if (!instrument) throw new HttpError(404, 'NOT_FOUND', 'Instrument inconnu');
  const settings = await getSettings(s.db);
  const tfParsed = TimeframeSchema.safeParse(c.req.query('tf') ?? settings.watchlist.timeframe);
  if (!tfParsed.success) throw new HttpError(422, 'VALIDATION', 'Unité de temps invalide');
  const tf = tfParsed.data;
  const data = await s.candles.getClosedCandles(instrument, tf, 300);
  const closes = data.candles.map((k) => k.c);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const bb = bollinger(closes, 20, 2);
  const snapshot = data.candles.length >= MIN_BARS_FOR_SNAPSHOT ? computeSnapshot(instrument.id, tf, data.candles) : null;
  const positions = (await openPositions(s.db, 'PAPER')).filter((p) => p.instrumentId === instrument.id);
  const [latest] = await listDecisions(s.db, { limit: 1, instrumentId: instrument.id });
  return ok(c, {
    instrument,
    timeframe: tf,
    candles: data.candles,
    indicators: {
      sma50: series(data.candles, sma50),
      sma200: series(data.candles, sma200),
      bbUpper: series(data.candles, bb.upper),
      bbLower: series(data.candles, bb.lower),
    },
    snapshot,
    source: data.source,
    fromCache: data.fromCache,
    warnings: data.warnings,
    asOf: data.asOf,
    positions,
    latestDecision: latest ?? null,
  });
});

// ----------------------------------------------------------------- analysis

const RunSchema = z.strictObject({ instrumentId: z.string().min(3) });

appRoutes.post('/analysis/run', async (c) => {
  const { instrumentId } = await parse(c, RunSchema);
  const s = services(c);
  const outcome = await runAnalysis({ db: s.db, config: s.config, candles: s.candles, desk: s.desk, now: s.now }, instrumentId, 'manual');
  return ok(c, outcome, 201);
});

appRoutes.get('/analysis/runs', async (c) => {
  const s = services(c);
  const before = numberQuery(c, 'before');
  return ok(c, await listRuns(s.db, { limit: clampLimit(c), ...(before ? { before } : {}), ...(c.req.query('instrumentId') ? { instrumentId: c.req.query('instrumentId')! } : {}) }));
});

appRoutes.get('/analysis/runs/:id', async (c) => {
  const detail = await getRunDetail(services(c).db, c.req.param('id'));
  if (!detail) throw new HttpError(404, 'NOT_FOUND', 'Analyse introuvable');
  return ok(c, detail);
});

appRoutes.get('/decisions', async (c) => {
  const s = services(c);
  const before = numberQuery(c, 'before');
  return ok(
    c,
    await listDecisions(s.db, {
      limit: clampLimit(c),
      ...(before ? { before } : {}),
      ...(c.req.query('instrumentId') ? { instrumentId: c.req.query('instrumentId')! } : {}),
      ...(c.req.query('status') ? { status: c.req.query('status')! } : {}),
    }),
  );
});

// ---------------------------------------------------------------- portfolio

appRoutes.get('/portfolio', async (c) => {
  const settings = await getSettings(services(c).db);
  return ok(c, await portfolioSummary(c, settings));
});

appRoutes.get('/portfolio/equity', async (c) => {
  const s = services(c);
  const account = await getAccount(s.db, 'PAPER');
  const curve = account ? await equityCurve(s.db, 'PAPER', account.resetAt) : [];
  return ok(c, { curve, drawdown: drawdownSeries(curve) });
});

appRoutes.get('/portfolio/trades', async (c) => {
  const s = services(c);
  const account = await getAccount(s.db, 'PAPER');
  return ok(c, {
    trades: account ? await listTrades(s.db, 'PAPER', account.resetAt) : [],
    orders: await listOrders(s.db, 'PAPER', 50),
  });
});

const CloseSchema = z.strictObject({ confirm: z.literal(true) });

appRoutes.post('/portfolio/positions/:id/close', async (c) => {
  await parse(c, CloseSchema);
  const s = services(c);
  const position = (await openPositions(s.db, 'PAPER')).find((p) => p.id === c.req.param('id'));
  if (!position) throw new HttpError(404, 'NOT_FOUND', 'Position introuvable');
  const instrument = await getInstrument(s.db, position.instrumentId);
  if (!instrument) throw new HttpError(404, 'NOT_FOUND', 'Instrument introuvable');
  const quote = await s.candles.getQuote(instrument);
  const { candles } = await s.candles.getClosedCandles(instrument, '1d', 2);
  const price = quote?.last ?? candles[candles.length - 1]?.c;
  if (!price) throw new HttpError(503, 'NO_PRICE', 'Aucun prix disponible pour clôturer');
  const result = await s.desk.closeManually(position.id, { price, bid: quote?.bid ?? null, ask: quote?.ask ?? null });
  return ok(c, result);
});

const ResetSchema = z.strictObject({ startingCash: z.number().min(100).max(10_000_000) });

appRoutes.post('/portfolio/reset', async (c) => {
  const { startingCash } = await parse(c, ResetSchema);
  const s = services(c);
  try {
    return ok(c, await s.desk.resetPaper(startingCash, hasStepUp(c)));
  } catch (err) {
    throw deskError(err);
  }
});

// --------------------------------------------------------------------- desk

appRoutes.get('/desk', async (c) => ok(c, await services(c).desk.view()));

const KillSchema = z.strictObject({ state: TradingStateSchema, reason: z.string().trim().min(1).max(300) });

appRoutes.post('/desk/kill-switch', async (c) => {
  const body = await parse(c, KillSchema);
  try {
    return ok(c, await services(c).desk.setTradingState(body.state, body.reason, hasStepUp(c)));
  } catch (err) {
    throw deskError(err);
  }
});

const ModeBody = z.strictObject({ mode: ModeSchema });

appRoutes.post('/desk/mode', async (c) => {
  const { mode } = await parse(c, ModeBody);
  try {
    return ok(c, await services(c).desk.setMode(mode, hasStepUp(c)));
  } catch (err) {
    throw deskError(err);
  }
});

// ----------------------------------------------------------------- settings

appRoutes.get('/settings', async (c) => {
  const s = services(c);
  const settings = await getSettings(s.db);
  return ok(c, {
    settings,
    labels: { risk: RISK_LIMIT_LABELS },
    instruments: await listInstruments(s.db),
    secrets: {
      anthropic: s.config.keys.anthropic !== null,
      openaiCompatible: s.config.keys.openaiCompatible !== null,
      alphaVantage: s.config.keys.alphaVantage !== null,
    },
  });
});

appRoutes.put('/settings/risk', async (c) => {
  const next = await parse(c, RiskLimitsSchema);
  const s = services(c);
  const current = (await getSettings(s.db)).risk;
  const loosened = looseningChanges(current, next);
  if (loosened.length > 0 && !hasStepUp(c)) {
    throw new HttpError(403, 'STEP_UP_REQUIRED', 'Desserrer une limite exige une ré-authentification.', {
      loosened: loosened.map((k) => RISK_LIMIT_LABELS[k as keyof typeof RISK_LIMIT_LABELS]),
    });
  }
  await putSetting(s.db, 'risk', next, Date.now());
  await addEvent(s.db, {
    ts: Date.now(),
    type: 'settings_risk',
    severity: loosened.length > 0 ? 'warning' : 'info',
    actor: 'user',
    title: loosened.length > 0 ? 'Limites de risque desserrées' : 'Limites de risque modifiées',
    data: { before: current, after: next, loosened },
  });
  return ok(c, next);
});

settingRoute('watchlist', WatchlistSettingsSchema, async (c, value) => {
  const db = services(c).db;
  for (const id of value.instrumentIds) {
    const instrument = await getInstrument(db, id);
    if (!instrument || !instrument.active) throw new HttpError(422, 'VALIDATION', `Instrument inconnu : ${id}`);
  }
});
settingRoute('llm', LlmSettingsSchema, async (_c, value) => {
  if (value.provider === 'openai-compatible' && !value.baseUrl) {
    throw new HttpError(422, 'VALIDATION', 'Une URL est requise pour un fournisseur OpenAI-compatible.');
  }
});
settingRoute('schedule', ScheduleSettingsSchema);
settingRoute('costs', CostSettingsSchema);

function settingRoute<K extends Exclude<keyof Settings, 'risk'>>(
  key: K,
  schema: z.ZodType<Settings[K]>,
  validate?: (c: AppContext, value: Settings[K]) => Promise<void>,
) {
  appRoutes.put(`/settings/${key}`, async (c) => {
    const value = await parse(c, schema);
    if (validate) await validate(c, value);
    const s = services(c);
    await putSetting(s.db, key, value, Date.now());
    await addEvent(s.db, { ts: Date.now(), type: `settings_${key}`, severity: 'info', actor: 'user', title: `Réglages modifiés : ${key}`, data: value });
    return ok(c, value);
  });
}

// ------------------------------------------------------------------- events

appRoutes.get('/events', async (c) => {
  const severity = c.req.query('severity');
  const before = numberQuery(c, 'before');
  return ok(
    c,
    await listEvents(services(c).db, {
      limit: clampLimit(c),
      ...(before ? { before } : {}),
      ...(severity === 'warning' || severity === 'critical' ? { minSeverity: severity } : {}),
    }),
  );
});

appRoutes.post('/events/:id/ack', async (c) => ok(c, { acknowledged: await acknowledgeEvent(services(c).db, c.req.param('id'), Date.now()) }));

// ------------------------------------------------------------------- system

appRoutes.get('/system', async (c) => {
  const s = services(c);
  const settings = await getSettings(s.db);
  return ok(c, {
    version: '0.1.0',
    environment: s.config.production ? 'production' : 'développement',
    dataMode: s.config.marketDataMode,
    liveTradingEnabled: s.config.liveTradingEnabled,
    killSwitchForced: s.config.killSwitchForced,
    jobs: await heartbeats(s.db),
    llm: await llmStatus(c, settings),
    providers: {
      alphaVantageKey: s.config.keys.alphaVantage !== null,
    },
  });
});

// ------------------------------------------------------------------ helpers

async function watchlistSummaries(c: AppContext, settings: Settings) {
  const s = services(c);
  const tf: Timeframe = settings.watchlist.timeframe;
  return Promise.all(
    settings.watchlist.instrumentIds.map(async (id) => {
      const instrument = await getInstrument(s.db, id);
      if (!instrument) return { instrumentId: id, error: 'instrument inconnu' };
      try {
        const data = await s.candles.getClosedCandles(instrument, tf, 300);
        const snap = data.candles.length >= MIN_BARS_FOR_SNAPSHOT ? computeSnapshot(id, tf, data.candles) : null;
        const quote = instrument.assetClass === 'crypto' ? await s.candles.getQuote(instrument) : null;
        return {
          instrumentId: id,
          instrument,
          last: quote?.last ?? snap?.lastClose ?? null,
          lastClose: snap?.lastClose ?? null,
          change1: snap?.change1 ?? null,
          change20: snap?.change20 ?? null,
          trend: snap?.trend ?? null,
          volatilityRegime: snap?.volatilityRegime ?? null,
          atrPct: snap?.atrPct ?? null,
          realizedVol20: snap?.realizedVol20 ?? null,
          volumeZ20: snap?.volumeZ20 ?? null,
          lastVolume: data.candles[data.candles.length - 1]?.v ?? null,
          technicalScore: snap?.technicalScore ?? null,
          sparkline: data.candles.slice(-30).map((k) => k.c),
          asOf: data.asOf,
          source: data.source,
          quoteSource: quote?.source ?? null,
          quoteTs: quote?.ts ?? null,
          warnings: data.warnings,
        };
      } catch (err) {
        return { instrumentId: id, instrument, error: errorMessage(err) };
      }
    }),
  );
}

async function portfolioSummary(c: AppContext, settings: Settings) {
  const s = services(c);
  const account = await getAccount(s.db, 'PAPER');
  if (!account) {
    return { initialized: false as const, riskLimits: settings.risk };
  }
  const positions = await openPositions(s.db, 'PAPER');
  const marked = await Promise.all(
    positions.map(async (p) => {
      const instrument = await getInstrument(s.db, p.instrumentId);
      let mark: number | null = null;
      if (instrument) {
        const quote = instrument.assetClass === 'crypto' ? await s.candles.getQuote(instrument) : null;
        const { candles } = await s.candles.getClosedCandles(instrument, settings.watchlist.timeframe, 2);
        mark = quote?.last ?? candles[candles.length - 1]?.c ?? null;
      }
      const price = mark ?? p.avgPrice;
      return {
        ...p,
        instrument,
        markPrice: mark,
        marketValue: p.quantity * price,
        unrealizedPnl: (price - p.avgPrice) * p.quantity - p.entryFees,
        unrealizedPct: price / p.avgPrice - 1,
      };
    }),
  );
  const exposure = marked.reduce((a, p) => a + p.marketValue, 0);
  const equity = account.cash + exposure;
  const peak = Math.max(account.peakEquity, equity);
  const curve = await equityCurve(s.db, 'PAPER', account.resetAt);
  const trades = await listTrades(s.db, 'PAPER', account.resetAt);
  const metrics = computeMetrics([...curve, { t: Date.now(), equity, exposure: equity > 0 ? exposure / equity : 0 }], trades, barsPerYear('15m'));
  return {
    initialized: true as const,
    currency: account.currency,
    startingCash: account.startingCash,
    cash: account.cash,
    equity,
    exposure,
    exposurePct: equity > 0 ? exposure / equity : 0,
    pnlTotal: equity - account.startingCash,
    pnlTotalPct: equity / account.startingCash - 1,
    pnlDay: equity - account.dayStartEquity,
    pnlDayPct: account.dayStartEquity > 0 ? equity / account.dayStartEquity - 1 : 0,
    drawdownPct: peak > 0 ? (peak - equity) / peak : 0,
    peakEquity: peak,
    consecutiveLosses: account.consecutiveLosses,
    positions: marked,
    metrics,
    riskLimits: settings.risk,
    riskUsage: {
      openPositions: positions.length,
      maxOpenPositions: settings.risk.maxOpenPositions,
      exposurePct: equity > 0 ? exposure / equity : 0,
      maxExposurePct: settings.risk.maxGrossExposurePct / 100,
      drawdownPct: peak > 0 ? (peak - equity) / peak : 0,
      maxDrawdownPct: settings.risk.maxDrawdownPct / 100,
      dayLossPct: account.dayStartEquity > 0 ? Math.max(0, 1 - equity / account.dayStartEquity) : 0,
      maxDayLossPct: settings.risk.maxDailyLossPct / 100,
    },
    resetAt: account.resetAt,
  };
}

async function llmStatus(c: AppContext, settings: Settings) {
  const s = services(c);
  const availability = buildLlmProvider(settings.llm, s.config);
  return {
    provider: settings.llm.provider,
    available: availability.available,
    reason: availability.available ? null : availability.reason,
    deepModel: settings.llm.deepModel,
    quickModel: settings.llm.quickModel,
    spentTodayUsd: await llmSpendSince(s.db, utcDayStart(Date.now())),
    dailyBudgetUsd: settings.llm.dailyBudgetUsd,
  };
}

function series(candles: readonly { t: number }[], values: readonly number[]) {
  const out: { t: number; v: number }[] = [];
  candles.forEach((k, i) => {
    const v = values[i]!;
    if (Number.isFinite(v)) out.push({ t: k.t, v });
  });
  return out;
}

function deskError(err: unknown): unknown {
  if (err instanceof StepUpRequiredError) return new HttpError(403, 'STEP_UP_REQUIRED', err.message);
  if (err instanceof LiveNotAvailableError) {
    return new HttpError(403, 'LIVE_NOT_AVAILABLE', err.message, {
      conditions: [
        'Variable de déploiement LIVE_TRADING_ENABLED=true, posée hors de l’application',
        'Adaptateur de venue réelle configuré avec des clés à permissions minimales (V1)',
        'Critères de validation atteints en simulation (durée, nombre de trades, drawdown)',
        'Ré-authentification et phrase de confirmation',
        'Enregistrement dans le journal d’audit',
      ],
    });
  }
  // Durable Object RPC rethrows errors by message only: map them back.
  const message = errorMessage(err);
  if (message.includes('Ré-authentification requise')) return new HttpError(403, 'STEP_UP_REQUIRED', message);
  if (message.includes('mode réel n’est pas disponible')) return deskError(new LiveNotAvailableError());
  if (message.includes('Clôturez les positions')) return new HttpError(409, 'OPEN_POSITIONS', message);
  return err;
}

function clampLimit(c: AppContext): number {
  const n = Number(c.req.query('limit') ?? 30);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, Math.floor(n))) : 30;
}

function numberQuery(c: AppContext, key: string): number | undefined {
  const v = c.req.query(key);
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}
