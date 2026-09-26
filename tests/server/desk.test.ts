import { DEFAULT_SETTINGS } from '../../src/core/domain/settings';
import { DAY_MS, utcDayStart } from '../../src/core/domain/time';
import type { Candle } from '../../src/core/domain/market';
import { CandleService } from '../../src/server/data/candle-service';
import { getInstrument, putSetting } from '../../src/server/db/core';
import { listDecisions } from '../../src/server/db/runs';
import { getAccount, listTrades, openPositions } from '../../src/server/db/trading';
import { runAnalysis } from '../../src/server/jobs/analysis';
import { runMonitor } from '../../src/server/jobs/monitor';
import { syntheticCandles } from '../helpers/candles';
import { TestD1 } from '../helpers/d1';
import { clock, DEV_CONFIG, fakeDeskNamespace, FakeProvider } from '../helpers/server';

/**
 * End-to-end server flows on the real schema, without network:
 * analysis → agents (rules: no LLM key) → Portfolio Manager → desk (risk, paper
 * execution) → journal; then monitoring, kill switch and modes.
 */

const T0 = Date.UTC(2026, 8, 10, 0, 7);

/**
 * An up-trend followed by a short pullback (RSI back under 70): the situation in
 * which the rule-based trader buys. Seeds chosen so that it does; the last bar
 * closes at 00:00 UTC on the test day.
 */
function upTrend(seed = 5): Candle[] {
  const pullback = seed === 5 ? 8 : 6;
  const n = 250 + pullback;
  const start = utcDayStart(T0) - n * DAY_MS;
  const up = syntheticCandles({ n: 250, start, drift: 0.004, vol: 0.012, seed, startPrice: 20_000, volume: 5_000 });
  const last = up[up.length - 1]!;
  const dip = syntheticCandles({ n: pullback, start: last.t + DAY_MS, drift: -0.004, vol: 0.008, seed: seed + 100, startPrice: last.c, volume: 5_000 });
  return [...up, ...dip];
}

async function setup(opts: { research?: boolean } = {}) {
  const t = new TestD1();
  const db = t.asD1();
  const c = clock(T0);
  const provider = new FakeProvider('coinbase', {
    'coinbase:BTC-USD': upTrend(5),
    'coinbase:ETH-USD': upTrend(7),
  });
  const candles = new CandleService(db, [provider], c.now);
  const { stub } = fakeDeskNamespace(db, DEV_CONFIG, c.now);
  const deps = { db, config: DEV_CONFIG, candles, desk: stub, now: c.now };
  if (opts.research) await stub.setMode('RESEARCH' as never, true);
  return { t, db, c, provider, candles, desk: stub, deps };
}

describe('cycle d’analyse de bout en bout (sans clé IA : agents à règles)', () => {
  it('analyse, décide, passe le risque, exécute en simulation et journalise tout', async () => {
    const { db, deps, t } = await setup();
    const outcome = await runAnalysis(deps, 'coinbase:BTC-USD', 'manual');
    expect(outcome.status).toBe('completed');
    expect(outcome.decisionStatus).toBe('EXECUTED');

    const [decision] = await listDecisions(db, { limit: 1 });
    expect(decision!.action).toBe('BUY');
    expect(decision!.source).toBe('rules');
    expect(decision!.verdict?.outcome).toMatch(/APPROVED|RESIZED/);
    expect(decision!.verdict!.checks.length).toBeGreaterThan(10);

    // Every agent left a report, including the ones not connected yet.
    const reports = t.raw.prepare('SELECT agent, status FROM agent_reports').all() as { agent: string; status: string }[];
    expect(reports.map((r) => r.agent).sort()).toEqual(['fundamental', 'macro', 'sentiment', 'technical', 'trader']);
    expect(reports.find((r) => r.agent === 'sentiment')!.status).toBe('unavailable');

    // The position respects the risk budget: loss at the stop ≤ 1 % of equity.
    const [position] = await openPositions(db, 'PAPER');
    expect(position).toBeDefined();
    const riskAtStop = (position!.avgPrice - position!.stopLoss!) * position!.quantity;
    expect(riskAtStop).toBeLessThanOrEqual(10_000 * 0.01 * 1.01);
    const account = (await getAccount(db, 'PAPER'))!;
    expect(account.cash).toBeLessThan(10_000);

    // The data available at decision time is stored with the run.
    const run = t.raw.prepare('SELECT snapshot, as_of FROM analysis_runs').get() as { snapshot: string; as_of: number };
    expect(JSON.parse(run.snapshot).lastClose).toBeGreaterThan(0);
    expect(run.as_of).toBeLessThanOrEqual(T0);
  });

  it('mode recherche : la décision est évaluée par le risque mais jamais exécutée', async () => {
    const { db, deps } = await setup({ research: true });
    const outcome = await runAnalysis(deps, 'coinbase:BTC-USD', 'manual');
    expect(outcome.decisionStatus).toBe('NOT_EXECUTED');
    expect(await openPositions(db, 'PAPER')).toHaveLength(0);
    const [d] = await listDecisions(db, { limit: 1 });
    expect(d!.verdict).not.toBeNull();
    expect(d!.executionNote).toMatch(/Mode recherche/);
  });

  it('kill switch HALTED : cycle planifié ignoré sans appel au modèle ; analyse manuelle refusée par le risque', async () => {
    const { db, deps, desk } = await setup();
    await desk.setTradingState('HALTED' as never, 'test', false);
    const scheduled = await runAnalysis(deps, 'coinbase:BTC-USD', 'schedule');
    expect(scheduled.status).toBe('skipped');
    const manual = await runAnalysis(deps, 'coinbase:BTC-USD', 'manual');
    expect(manual.decisionStatus).toBe('REJECTED');
    expect(await openPositions(db, 'PAPER')).toHaveLength(0);
  });

  it('un cycle planifié ne réanalyse pas une bougie déjà analysée (pas de dépense IA en double)', async () => {
    const { deps, c } = await setup({ research: true });
    const first = await runAnalysis(deps, 'coinbase:BTC-USD', 'schedule');
    expect(first.status).toBe('completed');
    c.advance(6 * 3_600_000); // same UTC day: no new daily bar has closed
    const second = await runAnalysis(deps, 'coinbase:BTC-USD', 'schedule');
    expect(second.status).toBe('skipped');
    expect(second.note).toMatch(/nouvelle bougie/);
    // A manual request is always honoured.
    expect((await runAnalysis(deps, 'coinbase:BTC-USD', 'manual')).status).toBe('completed');
  });

  it('reprendre après un kill switch exige une ré-authentification', async () => {
    const { desk } = await setup();
    await desk.setTradingState('HALTED' as never, 'test', false);
    await expect(desk.setTradingState('ACTIVE' as never, 'reprise', false)).rejects.toThrow(/Ré-authentification/);
    expect((await desk.setTradingState('ACTIVE' as never, 'reprise', true)).tradingState).toBe('ACTIVE');
  });

  it('le mode réel est refusé en V0.1', async () => {
    const { desk } = await setup();
    await expect(desk.setMode('LIVE' as never, true)).rejects.toThrow(/mode réel/);
  });

  it('un arrêt d’urgence de déploiement (KILL_SWITCH=halt) prime sur l’état stocké', async () => {
    const t = new TestD1();
    const db = t.asD1();
    const c = clock(T0);
    const { stub } = fakeDeskNamespace(db, { ...DEV_CONFIG, killSwitchForced: true }, c.now);
    const view = await stub.view();
    expect(view.tradingState).toBe('ACTIVE');
    expect(view.effectiveState).toBe('HALTED');
    const provider = new FakeProvider('coinbase', { 'coinbase:BTC-USD': upTrend() });
    const outcome = await runAnalysis(
      { db, config: { ...DEV_CONFIG, killSwitchForced: true }, candles: new CandleService(db, [provider], c.now), desk: stub, now: c.now },
      'coinbase:BTC-USD',
      'manual',
    );
    expect(outcome.decisionStatus).toBe('REJECTED');
  });

  it('données trop anciennes : ouverture refusée (fail-closed)', async () => {
    const { db, deps, c, provider } = await setup();
    const btc = (await getInstrument(db, 'coinbase:BTC-USD'))!;
    await deps.candles.getClosedCandles(btc, '1d', 300); // cache warmed on day 0
    c.advance(5 * DAY_MS);
    provider.failWith = new Error('panne du fournisseur');
    const outcome = await runAnalysis(deps, 'coinbase:BTC-USD', 'manual');
    expect(outcome.status).toBe('completed');
    expect(outcome.decisionStatus).toBe('REJECTED');
    const [d] = await listDecisions(db, { limit: 1 });
    const freshness = (d!.verdict!.checks as { rule: string; passed: boolean }[]).find((x) => x.rule === 'data_freshness');
    expect(freshness!.passed).toBe(false);
    expect(await openPositions(db, 'PAPER')).toHaveLength(0);
  });
});

describe('sérialisation du desk', () => {
  it('deux propositions simultanées ne peuvent pas dépasser le nombre maximal de positions', async () => {
    const { db, deps } = await setup();
    await putSetting(db, 'risk', { ...DEFAULT_SETTINGS.risk, maxOpenPositions: 1, maxCorrelation: 1 }, T0);
    const [a, b] = await Promise.all([
      runAnalysis(deps, 'coinbase:BTC-USD', 'manual'),
      runAnalysis(deps, 'coinbase:ETH-USD', 'manual'),
    ]);
    const statuses = [a.decisionStatus, b.decisionStatus].sort();
    expect(statuses).toEqual(['EXECUTED', 'REJECTED']);
    expect(await openPositions(db, 'PAPER')).toHaveLength(1);
  });
});

describe('surveillance des positions', () => {
  it('stop-loss touché : sortie de protection, trade journalisé, pertes consécutives', async () => {
    const { db, deps, c, provider } = await setup();
    await runAnalysis(deps, 'coinbase:BTC-USD', 'manual');
    const [position] = await openPositions(db, 'PAPER');
    const stop = position!.stopLoss!;
    // Next 15-minute bars: one plunges through the stop.
    c.advance(60 * 60_000);
    const bars: Candle[] = [0, 1, 2].map((i) => {
      const t = position!.openedAt + (i + 1) * 15 * 60_000 - (position!.openedAt % (15 * 60_000));
      const o = i === 2 ? stop * 1.01 : position!.avgPrice;
      const l = i === 2 ? stop * 0.98 : o * 0.999;
      return { t, o, h: o * 1.001, l, c: i === 2 ? stop * 0.985 : o, v: 10 };
    });
    provider.setData('coinbase:BTC-USD', [...upTrend(5), ...bars]);
    const result = await runMonitor({ db, candles: deps.candles, desk: deps.desk, now: c.now });
    expect(result.exits).toHaveLength(1);
    expect(result.exits[0]!.reason).toBe('stop');
    expect(result.exits[0]!.pnl).toBeLessThan(0);
    expect(await openPositions(db, 'PAPER')).toHaveLength(0);
    const account = (await getAccount(db, 'PAPER'))!;
    expect(account.consecutiveLosses).toBe(1);
    expect(await listTrades(db, 'PAPER', 0)).toHaveLength(1);
  });

  it('drawdown maximal franchi : passage automatique en HALTED', async () => {
    const { db, deps, c, t } = await setup();
    await runAnalysis(deps, 'coinbase:BTC-USD', 'manual');
    // Simulate a large loss by moving cash (as if other positions had lost).
    t.raw.exec("UPDATE accounts SET cash = cash - 2000 WHERE mode = 'PAPER'");
    c.advance(15 * 60_000);
    const result = await runMonitor({ db, candles: deps.candles, desk: deps.desk, now: c.now });
    expect(result.tradingState).toBe('HALTED');
    expect(result.transitions.join()).toMatch(/HALTED/);
    const instrument = await getInstrument(db, 'coinbase:BTC-USD');
    expect(instrument).not.toBeNull();
  });

  it('clôture manuelle autorisée même en HALTED (frein)', async () => {
    const { db, deps, desk } = await setup();
    await runAnalysis(deps, 'coinbase:BTC-USD', 'manual');
    await desk.setTradingState('HALTED' as never, 'test', false);
    const [p] = await openPositions(db, 'PAPER');
    const res = await desk.closeManually(p!.id, { price: p!.avgPrice, bid: null, ask: null } as never);
    expect(res.executed).toBe(true);
    expect(await openPositions(db, 'PAPER')).toHaveLength(0);
  });
});
