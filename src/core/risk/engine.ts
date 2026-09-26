import type { Instrument } from '../domain/market';
import type { Mode, OrderIntent, TradingState } from '../domain/trading';
import { round } from '../quant/features';
import type { RiskLimits } from './limits';

/**
 * The Risk Engine.
 *
 * Pure and deterministic: no I/O, no clock, no model. It receives an order
 * intent and a complete picture of the account, evaluates every rule, and
 * returns a verdict. It is the ONLY code able to produce an `ApprovedOrder`, the
 * only type the execution layer accepts (NautilusTrader's RiskEngine sitting
 * between strategy and execution; Condor's permission callback).
 *
 * Fail-closed: when a fact needed to judge an OPENING is missing (no ATR, stale
 * data, unknown liquidity) the opening is refused. Orders that only reduce
 * exposure — brakes — are never blocked by missing data (Condor).
 */

declare const approvedBrand: unique symbol;

/** An order that went through the Risk Engine. Cannot be built anywhere else. */
export type ApprovedOrder = {
  readonly instrumentId: string;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly referencePrice: number;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly expiresAt: number | null;
  readonly reduceOnly: boolean;
  readonly origin: OrderIntent['origin'];
  readonly decisionId: string | null;
  readonly [approvedBrand]: true;
};

export interface MarketFacts {
  readonly instrument: Instrument;
  readonly referencePrice: number;
  /** Close time of the last closed bar behind the reference price. */
  readonly dataAsOf: number;
  /** Maximum acceptable age of `dataAsOf`, already resolved for the asset class. */
  readonly maxDataAgeMs: number;
  readonly atr: number | null;
  readonly avgDollarVolume: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
}

export interface HeldPosition {
  readonly instrumentId: string;
  readonly quantity: number;
  readonly markPrice: number;
}

export interface RiskState {
  readonly now: number;
  readonly mode: Mode;
  /** Effective state, after applying any deployment-level override. */
  readonly tradingState: TradingState;
  readonly limits: RiskLimits;
  readonly equity: number;
  readonly cash: number;
  readonly peakEquity: number;
  readonly dayStartEquity: number;
  readonly positions: readonly HeldPosition[];
  readonly consecutiveLosses: number;
  readonly lastLossAt: number | null;
  readonly newOrdersToday: number;
  /** Correlation of the intent's instrument with each held instrument (NaN = unknown). */
  readonly correlations: Readonly<Record<string, number>>;
  readonly feeBps: number;
  readonly market: MarketFacts;
}

export type CheckSeverity = 'block' | 'resize' | 'warn' | 'info';

export interface RiskCheck {
  readonly rule: string;
  readonly label: string;
  readonly passed: boolean;
  readonly severity: CheckSeverity;
  readonly value?: number | string | null;
  readonly limit?: number | string | null;
  readonly message: string;
}

export type RiskOutcome = 'APPROVED' | 'RESIZED' | 'REJECTED';

export interface RiskVerdict {
  readonly outcome: RiskOutcome;
  readonly requestedQuantity: number;
  readonly approvedQuantity: number;
  readonly checks: readonly RiskCheck[];
  /** State the desk must move to because of this evaluation (automatic kill switch). */
  readonly requiredTradingState: TradingState | null;
  readonly summary: string;
}

export interface RiskEvaluation {
  readonly verdict: RiskVerdict;
  readonly order: ApprovedOrder | null;
}

export function evaluateIntent(intent: OrderIntent, state: RiskState): RiskEvaluation {
  return intent.reduceOnly ? evaluateReduction(intent, state) : evaluateOpening(intent, state);
}

// ------------------------------------------------------------------ openings

function evaluateOpening(intent: OrderIntent, s: RiskState): RiskEvaluation {
  const L = s.limits;
  const m = s.market;
  const checks: RiskCheck[] = [];
  const add = (c: RiskCheck) => checks.push(c);
  const entry = intent.entryPrice;
  let requiredTradingState: TradingState | null = null;

  add(modeCheck(s.mode));

  add({
    rule: 'trading_state',
    label: 'Kill switch',
    passed: s.tradingState === 'ACTIVE',
    severity: 'block',
    value: s.tradingState,
    limit: 'ACTIVE',
    message:
      s.tradingState === 'ACTIVE'
        ? 'Trading actif'
        : s.tradingState === 'REDUCING'
          ? 'Mode réduction : aucune nouvelle ouverture'
          : 'Trading arrêté (kill switch)',
  });

  if (intent.side !== 'BUY') {
    add({
      rule: 'long_only',
      label: 'Positions longues uniquement',
      passed: false,
      severity: 'block',
      message: 'Une ouverture doit être un achat : la vente à découvert est interdite',
    });
  }

  // Health of the account first: these can also move the kill switch.
  const drawdown = s.peakEquity > 0 ? (s.peakEquity - s.equity) / s.peakEquity : 0;
  const ddBreached = drawdown * 100 >= L.maxDrawdownPct;
  if (ddBreached) requiredTradingState = 'HALTED';
  add({
    rule: 'max_drawdown',
    label: 'Drawdown maximal',
    passed: !ddBreached,
    severity: 'block',
    value: pct(drawdown),
    limit: L.maxDrawdownPct,
    message: ddBreached
      ? `Drawdown de ${pct(drawdown)} % : coupure automatique (HALTED)`
      : `Drawdown ${pct(drawdown)} %`,
  });

  const dayLoss = s.dayStartEquity > 0 ? (s.dayStartEquity - s.equity) / s.dayStartEquity : 0;
  const dayBreached = dayLoss * 100 >= L.maxDailyLossPct;
  if (dayBreached && requiredTradingState === null) requiredTradingState = 'REDUCING';
  add({
    rule: 'daily_loss',
    label: 'Perte journalière',
    passed: !dayBreached,
    severity: 'block',
    value: pct(Math.max(dayLoss, 0)),
    limit: L.maxDailyLossPct,
    message: dayBreached
      ? `Perte du jour ${pct(dayLoss)} % : passage en mode réduction`
      : `Perte du jour ${pct(Math.max(dayLoss, 0))} %`,
  });

  const cooling =
    s.consecutiveLosses >= L.maxConsecutiveLosses &&
    s.lastLossAt !== null &&
    s.now - s.lastLossAt < L.cooldownHours * 3_600_000;
  add({
    rule: 'consecutive_losses',
    label: 'Pertes consécutives',
    passed: !cooling,
    severity: 'block',
    value: s.consecutiveLosses,
    limit: L.maxConsecutiveLosses,
    message: cooling
      ? `${s.consecutiveLosses} pertes consécutives : pause jusqu’au ${new Date(s.lastLossAt! + L.cooldownHours * 3_600_000).toISOString()}`
      : `${s.consecutiveLosses} perte(s) consécutive(s)`,
  });

  add({
    rule: 'orders_per_day',
    label: 'Nouveaux ordres du jour',
    passed: s.newOrdersToday < L.maxNewOrdersPerDay,
    severity: 'block',
    value: s.newOrdersToday,
    limit: L.maxNewOrdersPerDay,
    message: `${s.newOrdersToday} ordre(s) aujourd’hui`,
  });

  // Facts about the market (fail-closed).
  const age = s.now - m.dataAsOf;
  add({
    rule: 'data_freshness',
    label: 'Fraîcheur des données',
    passed: age >= 0 && age <= m.maxDataAgeMs,
    severity: 'block',
    value: `${Math.round(age / 60_000)} min`,
    limit: `${Math.round(m.maxDataAgeMs / 60_000)} min`,
    message:
      age <= m.maxDataAgeMs ? 'Données à jour' : 'Données trop anciennes : aucune ouverture sur un prix périmé',
  });

  const deviation = Math.abs(entry / m.referencePrice - 1);
  add({
    rule: 'price_band',
    label: 'Écart entrée / marché',
    passed: deviation * 100 <= L.maxEntryDeviationPct,
    severity: 'block',
    value: pct(deviation),
    limit: L.maxEntryDeviationPct,
    message: `Entrée à ${pct(deviation)} % du dernier cours`,
  });

  add({
    rule: 'confidence',
    label: 'Confiance minimale',
    passed: intent.confidence >= L.minConfidence,
    severity: 'block',
    value: round(intent.confidence, 3),
    limit: L.minConfidence,
    message: `Confiance ${round(intent.confidence * 100, 1)} %`,
  });

  const atrPct = m.atr === null ? null : m.atr / m.referencePrice;
  add({
    rule: 'volatility',
    label: 'Volatilité (ATR)',
    passed: atrPct !== null && atrPct * 100 <= L.maxAtrPct,
    severity: 'block',
    value: atrPct === null ? null : pct(atrPct),
    limit: L.maxAtrPct,
    message: atrPct === null ? 'ATR inconnu : volatilité non évaluable' : `ATR ${pct(atrPct)} % du prix`,
  });

  // Stop-loss: mandatory, below the entry, neither too tight nor too wide.
  const stop = intent.stopLoss;
  const stopValid = stop !== null && stop > 0 && stop < entry;
  add({
    rule: 'stop_required',
    label: 'Stop-loss obligatoire',
    passed: stopValid,
    severity: 'block',
    value: stop,
    message: stopValid ? `Stop à ${stop}` : 'Stop-loss absent ou du mauvais côté du prix',
  });
  const stopDistance = stopValid ? entry - stop! : null;
  if (stopDistance !== null) {
    const minDistance = m.atr === null ? 0 : L.minStopDistanceAtr * m.atr;
    const distancePct = stopDistance / entry;
    add({
      rule: 'stop_distance',
      label: 'Distance du stop',
      passed: stopDistance >= minDistance && distancePct * 100 <= L.maxStopDistancePct,
      severity: 'block',
      value: pct(distancePct),
      limit: `${L.minStopDistanceAtr} ATR – ${L.maxStopDistancePct} %`,
      message:
        stopDistance < minDistance
          ? `Stop trop serré (${round(stopDistance / (m.atr ?? 1), 2)} ATR)`
          : distancePct * 100 > L.maxStopDistancePct
            ? `Stop trop large (${pct(distancePct)} %)`
            : `Stop à ${pct(distancePct)} % de l’entrée`,
    });
  }

  if (intent.takeProfit !== null && stopDistance !== null && stopDistance > 0) {
    const rr = (intent.takeProfit - entry) / stopDistance;
    add({
      rule: 'reward_risk',
      label: 'Rapport gain/risque',
      passed: rr >= L.minRewardRisk,
      severity: 'block',
      value: round(rr, 2),
      limit: L.minRewardRisk,
      message: `Gain/risque ${round(rr, 2)}`,
    });
  }

  const held = s.positions.find((p) => p.instrumentId === intent.instrumentId) ?? null;
  const openCount = s.positions.filter((p) => p.quantity > 0).length;
  add({
    rule: 'max_positions',
    label: 'Positions simultanées',
    passed: held !== null || openCount < L.maxOpenPositions,
    severity: 'block',
    value: openCount,
    limit: L.maxOpenPositions,
    message: `${openCount} position(s) ouverte(s)`,
  });

  add({
    rule: 'liquidity',
    label: 'Liquidité',
    passed: m.avgDollarVolume !== null && m.avgDollarVolume >= L.minAvgDollarVolume,
    severity: 'block',
    value: m.avgDollarVolume === null ? null : Math.round(m.avgDollarVolume),
    limit: L.minAvgDollarVolume,
    message:
      m.avgDollarVolume === null ? 'Volume inconnu : liquidité non évaluable' : 'Volume moyen par bougie',
  });

  for (const p of s.positions) {
    if (p.instrumentId === intent.instrumentId || p.quantity <= 0) continue;
    const corr = s.correlations[p.instrumentId];
    const known = corr !== undefined && Number.isFinite(corr);
    add({
      rule: 'correlation',
      label: `Corrélation avec ${p.instrumentId}`,
      passed: !known || corr! <= L.maxCorrelation,
      severity: known ? 'block' : 'warn',
      value: known ? round(corr!, 3) : null,
      limit: L.maxCorrelation,
      message: known ? `Corrélation ${round(corr!, 2)}` : 'Corrélation non calculable (historique commun insuffisant)',
    });
  }

  if (m.bid !== null && m.ask !== null && m.bid > 0 && m.ask >= m.bid) {
    const spreadBps = ((m.ask - m.bid) / ((m.ask + m.bid) / 2)) * 10_000;
    add({
      rule: 'spread',
      label: 'Spread',
      passed: spreadBps <= L.maxSpreadBps,
      severity: 'block',
      value: round(spreadBps, 1),
      limit: L.maxSpreadBps,
      message: `Spread ${round(spreadBps, 1)} pb`,
    });
  } else {
    const blocking = s.mode === 'LIVE';
    add({
      rule: 'spread',
      label: 'Spread',
      passed: !blocking,
      severity: blocking ? 'block' : 'warn',
      message: blocking
        ? 'Cotation bid/ask indisponible : refusé en mode réel'
        : 'Cotation bid/ask indisponible : spread non vérifié (simulation)',
    });
  }

  // Quantity: the smallest of every ceiling, rounded down to the lot size.
  const requested = intent.quantity;
  const feeRate = s.feeBps / 10_000;
  const heldNotional = held ? held.quantity * held.markPrice : 0;
  const grossExposure = s.positions.reduce((a, p) => a + Math.abs(p.quantity) * p.markPrice, 0);
  const ceilings: { rule: string; label: string; qty: number; detail: string }[] = [];
  if (stopDistance !== null && stopDistance > 0) {
    ceilings.push({
      rule: 'risk_per_trade',
      label: 'Risque par trade',
      qty: (s.equity * (L.maxRiskPerTradePct / 100)) / stopDistance,
      detail: `${L.maxRiskPerTradePct} % du capital au stop`,
    });
  }
  ceilings.push(
    {
      rule: 'position_size',
      label: 'Taille de position',
      qty: (s.equity * (L.maxPositionPct / 100) - heldNotional) / entry,
      detail: `${L.maxPositionPct} % du capital`,
    },
    {
      rule: 'gross_exposure',
      label: 'Exposition totale',
      qty: (s.equity * (L.maxGrossExposurePct / 100) - grossExposure) / entry,
      detail: `${L.maxGrossExposurePct} % du capital`,
    },
    {
      rule: 'cash',
      label: 'Cash disponible',
      qty: s.cash / (entry * (1 + feeRate)),
      detail: 'cash, frais inclus',
    },
  );
  if (m.avgDollarVolume !== null) {
    ceilings.push({
      rule: 'participation',
      label: 'Part du volume',
      qty: (m.avgDollarVolume * (L.maxParticipationPct / 100)) / entry,
      detail: `${L.maxParticipationPct} % du volume moyen`,
    });
  }

  let approved = requested;
  for (const c of ceilings) {
    const cap = Math.max(0, c.qty);
    const binding = cap < approved;
    if (binding) approved = cap;
    add({
      rule: c.rule,
      label: c.label,
      passed: !binding,
      severity: 'resize',
      value: round(cap, 8),
      limit: c.detail,
      message: binding ? `Quantité ramenée à ${round(cap, 8)} (${c.detail})` : `Plafond ${round(cap, 8)}`,
    });
  }
  approved = floorTo(approved, m.instrument.sizeIncrement);
  const notional = approved * entry;
  const aboveMinimum = approved > 0 && notional >= m.instrument.minNotional;
  add({
    rule: 'min_notional',
    label: 'Montant minimal',
    passed: aboveMinimum,
    severity: 'block',
    value: round(notional, 2),
    limit: m.instrument.minNotional,
    message: aboveMinimum
      ? `Montant ${round(notional, 2)} ${m.instrument.quoteCurrency}`
      : 'Quantité nulle ou sous le minimum après application des limites',
  });

  return conclude(intent, checks, requested, approved, requiredTradingState);
}

// ---------------------------------------------------------------- reductions

function evaluateReduction(intent: OrderIntent, s: RiskState): RiskEvaluation {
  const checks: RiskCheck[] = [];
  checks.push(modeCheck(s.mode));
  const isBrake = intent.origin === 'protective' || intent.origin === 'manual';
  const allowed = s.tradingState !== 'HALTED' || isBrake;
  checks.push({
    rule: 'trading_state',
    label: 'Kill switch',
    passed: allowed,
    severity: 'block',
    value: s.tradingState,
    message: allowed
      ? isBrake
        ? 'Sortie de protection ou manuelle : toujours autorisée'
        : 'Réduction autorisée'
      : 'Trading arrêté : aucune décision de l’IA n’est exécutée',
  });

  const held = s.positions.find((p) => p.instrumentId === intent.instrumentId);
  const heldQty = held?.quantity ?? 0;
  const approved = floorTo(Math.min(intent.quantity, heldQty), s.market.instrument.sizeIncrement);
  checks.push({
    rule: 'no_short',
    label: 'Pas de vente à découvert',
    passed: intent.side === 'SELL' && approved > 0,
    severity: 'block',
    value: round(heldQty, 8),
    message:
      heldQty <= 0
        ? 'Aucune position à réduire'
        : approved < intent.quantity
          ? `Quantité limitée à la position détenue (${round(heldQty, 8)})`
          : 'Réduction dans la limite de la position',
  });
  if (heldQty > 0 && intent.quantity > heldQty) {
    checks.push({
      rule: 'held_quantity',
      label: 'Quantité détenue',
      passed: false,
      severity: 'resize',
      value: round(intent.quantity, 8),
      limit: round(heldQty, 8),
      message: `Vente ramenée à la quantité détenue (${round(heldQty, 8)})`,
    });
  }
  return conclude(intent, checks, intent.quantity, approved, null);
}

// ------------------------------------------------------------------- helpers

function modeCheck(mode: Mode): RiskCheck {
  return {
    rule: 'mode',
    label: 'Mode',
    passed: true,
    severity: 'info',
    value: mode,
    message:
      mode === 'RESEARCH'
        ? 'Mode recherche : verdict indicatif, aucune exécution'
        : mode === 'PAPER'
          ? 'Mode simulation'
          : 'Mode réel',
  };
}

function conclude(
  intent: OrderIntent,
  checks: RiskCheck[],
  requested: number,
  approved: number,
  requiredTradingState: TradingState | null,
): RiskEvaluation {
  const blocked = checks.filter((c) => c.severity === 'block' && !c.passed);
  // RESIZED means a limit actually bound. Rounding down to the venue's size
  // increment is not a risk decision and must not read as one in the journal.
  const resized = approved > 0 && approved < requested && checks.some((c) => c.severity === 'resize' && !c.passed);
  const outcome: RiskOutcome = blocked.length > 0 ? 'REJECTED' : resized ? 'RESIZED' : 'APPROVED';
  const summary =
    outcome === 'REJECTED'
      ? `Refusé : ${blocked.map((c) => c.message).join(' ; ')}`
      : outcome === 'RESIZED'
        ? `Approuvé avec quantité réduite de ${round(requested, 8)} à ${round(approved, 8)}`
        : 'Approuvé';
  const verdict: RiskVerdict = {
    outcome,
    requestedQuantity: requested,
    approvedQuantity: outcome === 'REJECTED' ? 0 : approved,
    checks,
    requiredTradingState,
    summary,
  };
  const order =
    outcome === 'REJECTED'
      ? null
      : approve({
          instrumentId: intent.instrumentId,
          side: intent.side,
          quantity: approved,
          referencePrice: intent.referencePrice,
          stopLoss: intent.stopLoss,
          takeProfit: intent.takeProfit,
          expiresAt: intent.expiresAt,
          reduceOnly: intent.reduceOnly,
          origin: intent.origin,
          decisionId: intent.decisionId,
        });
  return { verdict, order };
}

/** The only place an ApprovedOrder comes into existence. Deliberately not exported. */
function approve(fields: Omit<ApprovedOrder, typeof approvedBrand>): ApprovedOrder {
  return Object.freeze({ ...fields }) as ApprovedOrder;
}

/** Account-level health, evaluated by the monitor even when no order is pending. */
export function requiredStateFromHealth(
  limits: RiskLimits,
  equity: number,
  peakEquity: number,
  dayStartEquity: number,
): { state: TradingState | null; reason: string | null } {
  const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
  if (dd * 100 >= limits.maxDrawdownPct) {
    return { state: 'HALTED', reason: `Drawdown de ${pct(dd)} % ≥ ${limits.maxDrawdownPct} %` };
  }
  const dl = dayStartEquity > 0 ? (dayStartEquity - equity) / dayStartEquity : 0;
  if (dl * 100 >= limits.maxDailyLossPct) {
    return { state: 'REDUCING', reason: `Perte journalière de ${pct(dl)} % ≥ ${limits.maxDailyLossPct} %` };
  }
  return { state: null, reason: null };
}

export function floorTo(value: number, increment: number): number {
  if (!(value > 0)) return 0;
  const steps = Math.floor(value / increment + 1e-9);
  // Re-derive through the increment's decimals to avoid 0.30000000000000004.
  const decimals = Math.max(0, Math.ceil(-Math.log10(increment)));
  return Number((steps * increment).toFixed(Math.min(decimals, 12)));
}

function pct(fraction: number): number {
  return round(fraction * 100, 3);
}
