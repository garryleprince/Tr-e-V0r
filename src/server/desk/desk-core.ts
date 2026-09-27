import { DEFAULT_ACCOUNT_CURRENCY, type AccountCurrency } from '../../core/domain/fx';
import type { Candle, Instrument } from '../../core/domain/market';
import { PAPER_STARTING_CASH, type Settings } from '../../core/domain/settings';
import { utcDayStart } from '../../core/domain/time';
import type { ClosedTrade, Mode, OpenPosition, OrderIntent, TradingState } from '../../core/domain/trading';
import { applyBuy, applySell, entryFx } from '../../core/portfolio/ledger';
import { evaluateIntent, requiredStateFromHealth, type MarketFacts, type RiskVerdict } from '../../core/risk/engine';
import { evaluateBarriers } from '../../core/sim/exchange';
import { eventStatement, getInstrument, getSettings, latestFxRates, openingFx, valuationFx } from '../db/core';
import {
  closePosition,
  countNewOrdersSince,
  getAccount,
  getDeskState,
  insertEquitySnapshot,
  insertFill,
  insertOrder,
  insertTrade,
  insertVerdict,
  openPositions,
  putAccount,
  putDeskState,
  touchPosition,
  upsertOpenPosition,
  type AccountRow,
  type DeskStateRow,
} from '../db/trading';
import type { RuntimeConfig } from '../env';
import { PaperVenue } from '../execution/venue';
import { newId } from '../util';

/**
 * TradingDesk logic. The Durable Object wraps this class and calls it one
 * request at a time (see desk.ts): it is the single writer of the desk state,
 * accounts, orders and positions.
 *
 * Every submission goes: effective state → account snapshot → Risk Engine →
 * (paper) execution → one atomic batch of writes. Nothing reaches a venue
 * without a verdict, and every verdict is stored — approvals and refusals alike.
 */

export class LiveNotAvailableError extends Error {
  constructor() {
    super('Le mode réel n’est pas disponible dans cette version (V0.1).');
  }
}

export class StepUpRequiredError extends Error {
  constructor(action: string) {
    super(`Ré-authentification requise pour : ${action}`);
  }
}

export interface DeskView {
  readonly mode: Mode;
  /** Stored state. */
  readonly tradingState: TradingState;
  /** State actually enforced (a deployment-level halt overrides the stored one). */
  readonly effectiveState: TradingState;
  readonly forcedByDeployment: boolean;
  readonly reason: string | null;
  readonly updatedAt: number;
  readonly liveAvailable: boolean;
}

export interface SubmitRequest {
  readonly intent: OrderIntent;
  /** The desk resolves the instrument and the currency conversion itself. */
  readonly market: Omit<MarketFacts, 'instrument' | 'fx'>;
  readonly correlations: Readonly<Record<string, number>>;
}

export interface SubmitResult {
  readonly verdict: RiskVerdict;
  readonly verdictId: string;
  readonly executed: boolean;
  readonly note: string;
  readonly fillPrice: number | null;
  readonly positionId: string | null;
  readonly mode: Mode;
}

export interface MonitorInput {
  readonly positionId: string;
  /** Bars that closed since the last check, oldest first. */
  readonly bars: readonly Candle[];
  readonly barMs: number;
  readonly mark: { readonly price: number; readonly bid: number | null; readonly ask: number | null; readonly ts: number } | null;
}

export interface MonitorResult {
  readonly exits: { readonly positionId: string; readonly reason: string; readonly price: number; readonly pnl: number }[];
  readonly equity: number;
  readonly tradingState: TradingState;
  readonly transitions: string[];
}

export class DeskCore {
  constructor(
    private readonly db: D1Database,
    private readonly config: RuntimeConfig,
    private readonly now: () => number,
  ) {}

  // -------------------------------------------------------------- state

  async view(): Promise<DeskView> {
    const s = await this.ensureState();
    return this.toView(s);
  }

  private toView(s: DeskStateRow): DeskView {
    const forced = this.config.killSwitchForced;
    return {
      mode: s.mode,
      tradingState: s.tradingState,
      effectiveState: forced ? 'HALTED' : s.tradingState,
      forcedByDeployment: forced,
      reason: forced ? 'Arrêt d’urgence imposé par la configuration de déploiement (KILL_SWITCH=halt)' : s.reason,
      updatedAt: s.updatedAt,
      liveAvailable: false,
    };
  }

  /** First use initialises the desk: its state row and the paper account. */
  private async ensureState(): Promise<DeskStateRow> {
    const existing = await getDeskState(this.db);
    if (existing) return existing;
    const initial: DeskStateRow = { mode: 'PAPER', tradingState: 'ACTIVE', reason: null, updatedAt: this.now() };
    await putDeskState(this.db, initial).run();
    await this.account('PAPER');
    return initial;
  }

  async setTradingState(target: TradingState, opts: { reason: string; actor: 'user' | 'risk' | 'system'; stepUp: boolean }): Promise<DeskView> {
    const current = await this.ensureState();
    if (target === 'ACTIVE' && current.tradingState !== 'ACTIVE' && opts.actor === 'user' && !opts.stepUp) {
      // Stopping is immediate; resuming needs a fresh re-authentication.
      throw new StepUpRequiredError('reprendre le trading');
    }
    if (target === current.tradingState) return this.toView(current);
    const next: DeskStateRow = { ...current, tradingState: target, reason: opts.reason, updatedAt: this.now() };
    await this.db.batch([
      putDeskState(this.db, next),
      eventStatement(this.db, {
        ts: next.updatedAt,
        type: 'kill_switch',
        severity: target === 'ACTIVE' ? 'info' : target === 'REDUCING' ? 'warning' : 'critical',
        actor: opts.actor,
        title:
          target === 'ACTIVE'
            ? 'Trading repris'
            : target === 'REDUCING'
              ? 'Mode réduction : aucune nouvelle position'
              : 'Kill switch : trading arrêté',
        data: { from: current.tradingState, to: target, reason: opts.reason },
      }),
    ]);
    return this.toView(next);
  }

  async setMode(target: Mode, opts: { actor: 'user'; stepUp: boolean }): Promise<DeskView> {
    if (target === 'LIVE') {
      // V0.1 contains no live venue. The route answers 403 with the conditions.
      throw new LiveNotAvailableError();
    }
    const current = await this.ensureState();
    if (target === current.mode) return this.toView(current);
    if (!opts.stepUp) throw new StepUpRequiredError('changer de mode');
    const next: DeskStateRow = { ...current, mode: target, updatedAt: this.now() };
    await this.db.batch([
      putDeskState(this.db, next),
      eventStatement(this.db, {
        ts: next.updatedAt,
        type: 'mode_change',
        severity: 'warning',
        actor: opts.actor,
        title: `Mode : ${current.mode} → ${target}`,
        data: { from: current.mode, to: target },
      }),
    ]);
    return this.toView(next);
  }

  // ------------------------------------------------------------ account

  async account(mode: Mode = 'PAPER'): Promise<AccountRow> {
    const now = this.now();
    const existing = await getAccount(this.db, mode);
    if (existing) return existing;
    const created: AccountRow = {
      mode,
      currency: DEFAULT_ACCOUNT_CURRENCY,
      startingCash: PAPER_STARTING_CASH,
      cash: PAPER_STARTING_CASH,
      peakEquity: PAPER_STARTING_CASH,
      dayStartEquity: PAPER_STARTING_CASH,
      day: utcDayStart(now),
      consecutiveLosses: 0,
      lastLossAt: null,
      createdAt: now,
      resetAt: now,
    };
    await this.db.batch([
      putAccount(this.db, created),
      insertEquitySnapshot(this.db, mode, { ts: now, cash: created.cash, equity: created.cash, exposure: 0, drawdown: 0, openPositions: 0 }),
    ]);
    return created;
  }

  async resetPaper(startingCash: number, stepUp: boolean, currency?: AccountCurrency): Promise<AccountRow> {
    if (!stepUp) throw new StepUpRequiredError('réinitialiser le compte de simulation');
    if (!(startingCash >= 100 && startingCash <= 10_000_000)) throw new RangeError('capital initial hors bornes (100 à 10 000 000)');
    const open = await openPositions(this.db, 'PAPER');
    if (open.length > 0) throw new Error('Clôturez les positions ouvertes avant de réinitialiser le compte.');
    const now = this.now();
    const current = await this.account('PAPER');
    const reset: AccountRow = {
      ...current,
      currency: currency ?? current.currency,
      startingCash,
      cash: startingCash,
      peakEquity: startingCash,
      dayStartEquity: startingCash,
      day: utcDayStart(now),
      consecutiveLosses: 0,
      lastLossAt: null,
      resetAt: now,
    };
    await this.db.batch([
      putAccount(this.db, reset),
      insertEquitySnapshot(this.db, 'PAPER', { ts: now, cash: startingCash, equity: startingCash, exposure: 0, drawdown: 0, openPositions: 0 }),
      eventStatement(this.db, {
        ts: now,
        type: 'paper_reset',
        severity: 'warning',
        actor: 'user',
        title: `Compte de simulation réinitialisé (${startingCash} ${currency ?? current.currency})`,
      }),
    ]);
    return reset;
  }

  // ------------------------------------------------------------- submit

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    const now = this.now();
    const desk = this.toView(await this.ensureState());
    const settings = await getSettings(this.db);
    const instrument = await getInstrument(this.db, req.intent.instrumentId);
    if (!instrument) throw new Error(`instrument inconnu : ${req.intent.instrumentId}`);
    const bookMode: Mode = desk.mode === 'LIVE' ? 'LIVE' : 'PAPER';
    const book = await this.book(bookMode, settings, { [instrument.id]: req.market.referencePrice });
    const currency = book.account.currency;
    // Openings need a fresh rate (fail-closed); a sale uses the last known rate,
    // or the position's own entry rate, so that a brake is never blocked.
    const fxOpen = openingFx(book.fx, instrument.quoteCurrency, currency);
    const held0 = book.positions.find((p) => p.instrumentId === instrument.id) ?? null;
    const fxSell = valuationFx(book.fx, instrument.quoteCurrency, currency) ?? (held0 ? entryFx(held0) : null);

    const { verdict, order } = evaluateIntent(req.intent, {
      now,
      mode: desk.mode,
      tradingState: desk.effectiveState,
      limits: settings.risk,
      equity: book.equity,
      cash: book.account.cash,
      peakEquity: Math.max(book.account.peakEquity, book.equity),
      dayStartEquity: book.account.dayStartEquity,
      positions: book.rows.map((r) => ({ instrumentId: r.position.instrumentId, quantity: r.position.quantity, markPrice: r.mark, fx: r.fx })),
      consecutiveLosses: book.account.consecutiveLosses,
      lastLossAt: book.account.lastLossAt,
      newOrdersToday: await countNewOrdersSince(this.db, bookMode, utcDayStart(now)),
      correlations: req.correlations,
      feeBps: settings.costs.feeBps,
      market: { ...req.market, instrument, fx: req.intent.reduceOnly ? fxSell : fxOpen },
    });

    const verdictId = newId();
    const writes: D1PreparedStatement[] = [
      insertVerdict(this.db, {
        id: verdictId,
        decisionId: req.intent.decisionId,
        origin: req.intent.origin,
        outcome: verdict.outcome,
        requestedQty: verdict.requestedQuantity,
        approvedQty: verdict.approvedQuantity,
        checks: verdict.checks,
        limits: settings.risk,
        tradingState: desk.effectiveState,
        summary: verdict.summary,
        createdAt: now,
      }),
    ];

    // Automatic kill switch (drawdown → HALTED, daily loss → REDUCING).
    if (verdict.requiredTradingState && rank(verdict.requiredTradingState) > rank(desk.tradingState)) {
      await this.setTradingState(verdict.requiredTradingState, {
        reason: `auto:${verdict.requiredTradingState === 'HALTED' ? 'drawdown' : 'daily_loss'}`,
        actor: 'risk',
        stepUp: false,
      });
    }

    if (!order) {
      writes.push(
        eventStatement(this.db, {
          ts: now,
          type: 'risk_rejection',
          severity: req.intent.origin === 'ai' ? 'info' : 'warning',
          actor: 'risk',
          title: `Ordre refusé par le risque — ${instrument.displayName}`,
          data: { decisionId: req.intent.decisionId, summary: verdict.summary },
        }),
      );
      await this.db.batch(writes);
      return { verdict, verdictId, executed: false, note: verdict.summary, fillPrice: null, positionId: null, mode: desk.mode };
    }

    // Research mode never executes an AI decision. Manual and protective exits
    // still manage the simulated book: they are brakes, not new bets.
    if (desk.mode === 'RESEARCH' && req.intent.origin === 'ai') {
      await this.db.batch(writes);
      return {
        verdict,
        verdictId,
        executed: false,
        note: 'Mode recherche : ordre évalué, non exécuté',
        fillPrice: null,
        positionId: null,
        mode: desk.mode,
      };
    }
    if (desk.mode === 'LIVE') {
      // Unreachable in V0.1 (setMode refuses LIVE); kept as a hard stop.
      throw new LiveNotAvailableError();
    }

    const venue = new PaperVenue(settings.costs);
    const report = await venue.execute(order, {
      referencePrice: req.market.referencePrice,
      bid: req.market.bid,
      ask: req.market.ask,
      ts: now,
    });
    const orderId = newId();
    if (report.status !== 'FILLED') {
      writes.push(
        insertOrder(this.db, orderRecord(orderId, order, instrument, verdictId, 'REJECTED', report.reason, now)),
      );
      await this.db.batch(writes);
      return { verdict, verdictId, executed: false, note: report.reason, fillPrice: null, positionId: null, mode: desk.mode };
    }

    const held = held0;
    const fillFx = order.side === 'BUY' ? fxOpen : fxSell;
    if (fillFx === null) throw new Error('taux de change indisponible pour convertir l’exécution'); // unreachable: the Risk Engine blocks it
    writes.push(insertOrder(this.db, orderRecord(orderId, order, instrument, verdictId, 'FILLED', req.intent.reason, now)));
    writes.push(insertFill(this.db, orderId, report.fill, fillFx));
    let account = book.account;
    let positionId: string | null = null;
    if (order.side === 'BUY') {
      const next = applyBuy({ cash: account.cash, position: held }, report.fill, {
        id: held?.id ?? newId(),
        instrumentId: instrument.id,
        mode: bookMode,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        expiresAt: order.expiresAt,
        decisionId: order.decisionId,
      }, fillFx);
      account = { ...account, cash: next.cash };
      positionId = next.position!.id;
      writes.push(upsertOpenPosition(this.db, next.position!, now));
    } else {
      const res = applySell({ cash: account.cash, position: held }, report.fill, req.intent.origin === 'manual' ? 'manual' : 'signal', fillFx);
      account = afterTrade({ ...account, cash: res.state.cash }, res.trade);
      positionId = held!.id;
      writes.push(...this.closeWrites(held!, res.state.position, res.trade, bookMode, now, currency));
    }
    writes.push(
      eventStatement(this.db, {
        ts: now,
        type: 'order_filled',
        severity: 'info',
        actor: req.intent.origin === 'ai' ? 'agent' : 'user',
        title: `${order.side === 'BUY' ? 'Achat' : 'Vente'} ${instrument.displayName} — ${round(report.fill.quantity)} @ ${round(report.fill.price)}`,
        data: { orderId, decisionId: order.decisionId, fee: report.fill.fee, slippageBps: report.fill.slippageBps, fx: fillFx, quoteCurrency: instrument.quoteCurrency },
      }),
    );
    writes.push(putAccount(this.db, account));
    await this.db.batch(writes);
    await this.snapshotEquity(bookMode, settings);
    return {
      verdict,
      verdictId,
      executed: true,
      note: `${order.side === 'BUY' ? 'Achat' : 'Vente'} simulé exécuté`,
      fillPrice: report.fill.price,
      positionId,
      mode: desk.mode,
    };
  }

  // ------------------------------------------------------------ monitor

  async monitor(inputs: readonly MonitorInput[]): Promise<MonitorResult> {
    const now = this.now();
    const settings = await getSettings(this.db);
    const desk = this.toView(await this.ensureState());
    const positions = await openPositions(this.db, 'PAPER');
    const exits: MonitorResult['exits'] = [];
    const transitions: string[] = [];
    let account = await this.rollDay(await this.account('PAPER'), 'PAPER', settings, transitions);
    const fxView = await latestFxRates(this.db, now);

    for (const input of inputs) {
      const position = positions.find((p) => p.id === input.positionId);
      if (!position) continue;
      const exit = evaluateBarriers(position, input.bars, input.barMs);
      if (!exit) {
        await touchPosition(this.db, position.id, now).run();
        continue;
      }
      const instrument = await getInstrument(this.db, position.instrumentId);
      if (!instrument) continue;
      const exitFx = valuationFx(fxView, instrument.quoteCurrency, account.currency) ?? entryFx(position);
      // A protective exit is a brake: it goes through the Risk Engine like
      // everything else, which lets it pass even when trading is HALTED.
      const { verdict, order } = evaluateIntent(
        {
          instrumentId: position.instrumentId,
          side: 'SELL',
          quantity: position.quantity,
          referencePrice: exit.price,
          entryPrice: exit.price,
          stopLoss: null,
          takeProfit: null,
          expiresAt: null,
          confidence: 1,
          reduceOnly: true,
          origin: 'protective',
          decisionId: position.decisionId,
          reason: `Sortie automatique (${exit.reason})`,
        },
        {
          now,
          mode: desk.mode,
          tradingState: desk.effectiveState,
          limits: settings.risk,
          equity: account.cash,
          cash: account.cash,
          peakEquity: account.peakEquity,
          dayStartEquity: account.dayStartEquity,
          positions: [{ instrumentId: position.instrumentId, quantity: position.quantity, markPrice: exit.price, fx: exitFx }],
          consecutiveLosses: account.consecutiveLosses,
          lastLossAt: account.lastLossAt,
          newOrdersToday: 0,
          correlations: {},
          feeBps: settings.costs.feeBps,
          market: {
            instrument,
            referencePrice: exit.price,
            dataAsOf: exit.ts,
            maxDataAgeMs: Number.MAX_SAFE_INTEGER,
            atr: null,
            avgDollarVolume: null,
            bid: null,
            ask: null,
            fx: exitFx,
          },
        },
      );
      if (!order) continue;
      const report = await new PaperVenue(settings.costs).execute(order, { referencePrice: exit.price, bid: null, ask: null, ts: Math.max(exit.ts, position.openedAt) });
      if (report.status !== 'FILLED') continue;
      const res = applySell({ cash: account.cash, position }, report.fill, exit.reason, exitFx);
      account = afterTrade({ ...account, cash: res.state.cash }, res.trade);
      const orderId = newId();
      const verdictId = newId();
      await this.db.batch([
        insertVerdict(this.db, {
          id: verdictId,
          decisionId: position.decisionId,
          origin: 'protective',
          outcome: verdict.outcome,
          requestedQty: verdict.requestedQuantity,
          approvedQty: verdict.approvedQuantity,
          checks: verdict.checks,
          limits: settings.risk,
          tradingState: desk.effectiveState,
          summary: verdict.summary,
          createdAt: now,
        }),
        insertOrder(this.db, orderRecord(orderId, order, instrument, verdictId, 'FILLED', `Sortie ${exit.reason}`, now)),
        insertFill(this.db, orderId, report.fill, exitFx),
        ...this.closeWrites(position, res.state.position, res.trade, 'PAPER', now, account.currency),
        putAccount(this.db, account),
        eventStatement(this.db, {
          ts: now,
          type: 'position_exit',
          severity: res.trade.pnl < 0 ? 'warning' : 'info',
          actor: 'system',
          title: `${EXIT_TITLES[exit.reason]} — ${instrument.displayName} (${res.trade.pnl >= 0 ? '+' : ''}${round(res.trade.pnl)} ${account.currency})`,
          data: { positionId: position.id, reason: exit.reason, price: report.fill.price, pnl: res.trade.pnl },
        }),
      ]);
      exits.push({ positionId: position.id, reason: exit.reason, price: report.fill.price, pnl: res.trade.pnl });
    }

    const marks: Record<string, number> = {};
    for (const input of inputs) {
      const p = positions.find((x) => x.id === input.positionId);
      if (p && input.mark) marks[p.instrumentId] = input.mark.price;
    }
    const equity = await this.snapshotEquity('PAPER', settings, marks);
    const fresh = (await getAccount(this.db, 'PAPER'))!;
    const health = requiredStateFromHealth(settings.risk, equity, Math.max(fresh.peakEquity, equity), fresh.dayStartEquity);
    let state = desk.tradingState;
    if (health.state && rank(health.state) > rank(state)) {
      await this.setTradingState(health.state, {
        reason: `auto:${health.state === 'HALTED' ? 'drawdown' : 'daily_loss'} — ${health.reason}`,
        actor: 'risk',
        stepUp: false,
      });
      transitions.push(`${state} → ${health.state} (${health.reason})`);
      state = health.state;
    }
    return { exits, equity, tradingState: this.config.killSwitchForced ? 'HALTED' : state, transitions };
  }

  /** Manual close, from the user. A brake: allowed in every trading state. */
  async closeManually(positionId: string, market: { price: number; bid: number | null; ask: number | null }): Promise<SubmitResult> {
    const positions = await openPositions(this.db, 'PAPER');
    const p = positions.find((x) => x.id === positionId);
    if (!p) throw new Error('position introuvable ou déjà clôturée');
    return this.submit({
      intent: {
        instrumentId: p.instrumentId,
        side: 'SELL',
        quantity: p.quantity,
        referencePrice: market.price,
        entryPrice: market.price,
        stopLoss: null,
        takeProfit: null,
        expiresAt: null,
        confidence: 1,
        reduceOnly: true,
        origin: 'manual',
        decisionId: p.decisionId,
        reason: 'Clôture manuelle',
      },
      market: {
        referencePrice: market.price,
        dataAsOf: this.now(),
        maxDataAgeMs: Number.MAX_SAFE_INTEGER,
        atr: null,
        avgDollarVolume: null,
        bid: market.bid,
        ask: market.ask,
      },
      correlations: {},
    });
  }

  // ----------------------------------------------------------- internals

  private async book(mode: Mode, settings: Settings, marks: Record<string, number>) {
    const transitions: string[] = [];
    const account = await this.rollDay(await this.account(mode), mode, settings, transitions);
    const v = await this.valuation(mode, account.currency, marks);
    return { account, positions: v.positions, rows: v.rows, fx: v.fx, equity: account.cash + v.value };
  }

  /**
   * Open positions valued in the account currency: last price (quote currency)
   * × last known rate, or the position's entry rate when no rate is known.
   */
  private async valuation(mode: Mode, currency: string, marks: Record<string, number> = {}) {
    const positions = await openPositions(this.db, mode);
    const fx = await latestFxRates(this.db, this.now());
    const prices = { ...(await this.lastPrices(positions.map((p) => p.instrumentId))), ...marks };
    const rows: { position: (typeof positions)[number]; mark: number; fx: number; value: number }[] = [];
    for (const position of positions) {
      const instrument = await getInstrument(this.db, position.instrumentId);
      const rate = valuationFx(fx, instrument?.quoteCurrency ?? currency, currency) ?? entryFx(position);
      const mark = prices[position.instrumentId] ?? position.avgPrice;
      rows.push({ position, mark, fx: rate, value: position.quantity * mark * rate });
    }
    return { positions, rows, fx, value: rows.reduce((a, r) => a + r.value, 0) };
  }

  /** New UTC day: reset the day's reference equity; lift an automatic daily-loss pause. */
  private async rollDay(account: AccountRow, mode: Mode, settings: Settings, transitions: string[]): Promise<AccountRow> {
    const today = utcDayStart(this.now());
    if (account.day === today) return account;
    const equity = account.cash + (await this.valuation(mode, account.currency)).value;
    const next = { ...account, day: today, dayStartEquity: equity };
    await putAccount(this.db, next).run();
    const state = await this.ensureState();
    if (state.tradingState === 'REDUCING' && (state.reason ?? '').startsWith('auto:daily_loss')) {
      await this.setTradingState('ACTIVE', { reason: 'Nouvelle journée : fin de la pause automatique', actor: 'system', stepUp: true });
      transitions.push('REDUCING → ACTIVE (nouvelle journée)');
    }
    void settings;
    return next;
  }

  private async lastPrices(ids: readonly string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const id of new Set(ids)) {
      const q = await this.db.prepare('SELECT last, fetched_at FROM quotes WHERE instrument_id = ?').bind(id).first<Record<string, unknown>>();
      if (q && this.now() - Number(q.fetched_at) < 24 * 3_600_000) {
        out[id] = Number(q.last);
        continue;
      }
      const c = await this.db
        .prepare('SELECT c FROM candles WHERE instrument_id = ? ORDER BY t DESC LIMIT 1')
        .bind(id)
        .first<Record<string, unknown>>();
      if (c) out[id] = Number(c.c);
    }
    return out;
  }

  private closeWrites(
    before: OpenPosition,
    after: OpenPosition | null,
    trade: ClosedTrade,
    mode: Mode,
    now: number,
    currency: string,
  ): D1PreparedStatement[] {
    const writes = [insertTrade(this.db, mode, before.id, before.decisionId, trade, currency)];
    if (after) writes.push(upsertOpenPosition(this.db, after, now));
    else writes.push(closePosition(this.db, before.id, trade.closedAt, trade.exitPrice, trade.pnl, trade.exitReason));
    return writes;
  }

  private async snapshotEquity(mode: Mode, settings: Settings, marks: Record<string, number> = {}): Promise<number> {
    const now = this.now();
    const account = (await getAccount(this.db, mode))!;
    const { positions, value } = await this.valuation(mode, account.currency, marks);
    const equity = account.cash + value;
    const peak = Math.max(account.peakEquity, equity);
    await this.db.batch([
      insertEquitySnapshot(this.db, mode, {
        ts: now,
        cash: account.cash,
        equity,
        exposure: equity > 0 ? value / equity : 0,
        drawdown: peak > 0 ? (peak - equity) / peak : 0,
        openPositions: positions.length,
      }),
      putAccount(this.db, { ...account, peakEquity: peak }),
    ]);
    void settings;
    return equity;
  }
}

const EXIT_TITLES = { stop: 'Stop-loss touché', target: 'Objectif atteint', time: 'Horizon atteint' } as const;

function afterTrade(account: AccountRow, trade: ClosedTrade): AccountRow {
  return trade.pnl < 0
    ? { ...account, consecutiveLosses: account.consecutiveLosses + 1, lastLossAt: trade.closedAt }
    : { ...account, consecutiveLosses: 0 };
}

function orderRecord(
  id: string,
  order: { instrumentId: string; side: 'BUY' | 'SELL'; quantity: number; referencePrice: number; origin: 'ai' | 'protective' | 'manual'; decisionId: string | null },
  instrument: Instrument,
  verdictId: string,
  status: 'FILLED' | 'REJECTED',
  reason: string | null,
  now: number,
) {
  return {
    id,
    clientOrderId: `trevor-${id}`,
    mode: 'PAPER' as const,
    venue: 'paper',
    instrumentId: instrument.id,
    decisionId: order.decisionId,
    verdictId,
    side: order.side,
    quantity: order.quantity,
    referencePrice: order.referencePrice,
    status,
    origin: order.origin,
    reason,
    createdAt: now,
  };
}

function rank(s: TradingState): number {
  return s === 'ACTIVE' ? 0 : s === 'REDUCING' ? 1 : 2;
}

function round(v: number): number {
  return Math.abs(v) >= 100 ? Math.round(v * 100) / 100 : Number(v.toPrecision(6));
}
