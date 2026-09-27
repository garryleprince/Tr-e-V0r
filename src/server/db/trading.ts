import type { ClosedTrade, ExitReason, Fill, Mode, OpenPosition, TradingState } from '../../core/domain/trading';
import { ModeSchema, TradingStateSchema } from '../../core/domain/trading';
import type { EquityPoint } from '../../core/backtest/metrics';
import { newId } from '../util';

/**
 * Data access for the desk: state, accounts, positions, orders, fills, trades
 * and equity. Every WRITE function returns prepared statements rather than
 * executing them, so the desk can commit one decision atomically with
 * `db.batch([...])`. Only the TradingDesk Durable Object calls the writers.
 *
 * Nothing is ever deleted: resetting the paper account moves its `reset_at`
 * forward and every portfolio query reads from that point, so the audit trail
 * of earlier decisions, orders and trades stays intact.
 */

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------- desk state

export interface DeskStateRow {
  readonly mode: Mode;
  readonly tradingState: TradingState;
  readonly reason: string | null;
  readonly updatedAt: number;
}

export async function getDeskState(db: D1Database): Promise<DeskStateRow | null> {
  const r = await db.prepare('SELECT * FROM desk_state WHERE id = 1').first<Row>();
  if (!r) return null;
  return {
    mode: ModeSchema.parse(r.mode),
    tradingState: TradingStateSchema.parse(r.trading_state),
    reason: strOrNull(r.reason),
    updatedAt: num(r.updated_at),
  };
}

export function putDeskState(db: D1Database, s: DeskStateRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO desk_state (id, mode, trading_state, reason, updated_at) VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, trading_state = excluded.trading_state,
       reason = excluded.reason, updated_at = excluded.updated_at`,
    )
    .bind(s.mode, s.tradingState, s.reason, s.updatedAt);
}

// ------------------------------------------------------------------- account

export interface AccountRow {
  readonly mode: Mode;
  readonly currency: string;
  readonly startingCash: number;
  readonly cash: number;
  readonly peakEquity: number;
  readonly dayStartEquity: number;
  readonly day: number;
  readonly consecutiveLosses: number;
  readonly lastLossAt: number | null;
  readonly createdAt: number;
  readonly resetAt: number;
}

export async function getAccount(db: D1Database, mode: Mode): Promise<AccountRow | null> {
  const r = await db.prepare('SELECT * FROM accounts WHERE mode = ?').bind(mode).first<Row>();
  if (!r) return null;
  return {
    mode,
    currency: str(r.currency),
    startingCash: num(r.starting_cash),
    cash: num(r.cash),
    peakEquity: num(r.peak_equity),
    dayStartEquity: num(r.day_start_equity),
    day: num(r.day),
    consecutiveLosses: num(r.consecutive_losses),
    lastLossAt: numOrNull(r.last_loss_at),
    createdAt: num(r.created_at),
    resetAt: num(r.reset_at),
  };
}

export function putAccount(db: D1Database, a: AccountRow): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO accounts (mode, currency, starting_cash, cash, peak_equity, day_start_equity, day, consecutive_losses, last_loss_at, created_at, reset_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mode) DO UPDATE SET currency = excluded.currency, starting_cash = excluded.starting_cash, cash = excluded.cash,
       peak_equity = excluded.peak_equity, day_start_equity = excluded.day_start_equity, day = excluded.day,
       consecutive_losses = excluded.consecutive_losses, last_loss_at = excluded.last_loss_at, reset_at = excluded.reset_at`,
    )
    .bind(
      a.mode,
      a.currency,
      a.startingCash,
      a.cash,
      a.peakEquity,
      a.dayStartEquity,
      a.day,
      a.consecutiveLosses,
      a.lastLossAt,
      a.createdAt,
      a.resetAt,
    );
}

// ----------------------------------------------------------------- positions

function mapPosition(r: Row): OpenPosition & { lastCheckedAt: number } {
  return {
    id: str(r.id),
    instrumentId: str(r.instrument_id),
    mode: ModeSchema.parse(r.mode),
    quantity: num(r.quantity),
    avgPrice: num(r.avg_price),
    // Rows written before V0.2 carry no entry_value: same currency as the account.
    entryValue: r.entry_value === null || r.entry_value === undefined ? num(r.avg_price) * num(r.quantity) : num(r.entry_value),
    stopLoss: numOrNull(r.stop_loss),
    takeProfit: numOrNull(r.take_profit),
    expiresAt: numOrNull(r.expires_at),
    openedAt: num(r.opened_at),
    decisionId: strOrNull(r.decision_id),
    entryFees: num(r.entry_fees),
    lastCheckedAt: num(r.last_checked_at),
  };
}

export async function openPositions(db: D1Database, mode: Mode): Promise<(OpenPosition & { lastCheckedAt: number })[]> {
  const { results } = await db
    .prepare("SELECT * FROM positions WHERE mode = ? AND status = 'open' ORDER BY opened_at")
    .bind(mode)
    .all<Row>();
  return results.map(mapPosition);
}

export function upsertOpenPosition(db: D1Database, p: OpenPosition, lastCheckedAt: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO positions (id, mode, instrument_id, status, quantity, avg_price, entry_value, entry_fees, stop_loss, take_profit, expires_at, opened_at, decision_id, last_checked_at)
       VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET quantity = excluded.quantity, avg_price = excluded.avg_price, entry_value = excluded.entry_value, entry_fees = excluded.entry_fees,
       stop_loss = excluded.stop_loss, take_profit = excluded.take_profit, expires_at = excluded.expires_at,
       last_checked_at = excluded.last_checked_at`,
    )
    .bind(
      p.id,
      p.mode,
      p.instrumentId,
      p.quantity,
      p.avgPrice,
      p.entryValue,
      p.entryFees,
      p.stopLoss,
      p.takeProfit,
      p.expiresAt,
      p.openedAt,
      p.decisionId,
      lastCheckedAt,
    );
}

export function closePosition(
  db: D1Database,
  id: string,
  closedAt: number,
  exitPrice: number,
  realizedPnl: number,
  reason: ExitReason,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE positions SET status = 'closed', closed_at = ?, exit_price = ?, realized_pnl = ?, exit_reason = ?, last_checked_at = ? WHERE id = ?",
    )
    .bind(closedAt, exitPrice, realizedPnl, reason, closedAt, id);
}

export function touchPosition(db: D1Database, id: string, lastCheckedAt: number): D1PreparedStatement {
  return db.prepare('UPDATE positions SET last_checked_at = ? WHERE id = ?').bind(lastCheckedAt, id);
}

// ------------------------------------------------------ orders, fills, trades

export interface OrderRecord {
  readonly id: string;
  readonly clientOrderId: string;
  readonly mode: Mode;
  readonly venue: string;
  readonly instrumentId: string;
  readonly decisionId: string | null;
  readonly verdictId: string | null;
  readonly side: 'BUY' | 'SELL';
  readonly quantity: number;
  readonly referencePrice: number;
  readonly status: 'FILLED' | 'REJECTED' | 'CANCELLED' | 'PENDING';
  readonly origin: 'ai' | 'protective' | 'manual';
  readonly reason: string | null;
  readonly createdAt: number;
}

export function insertOrder(db: D1Database, o: OrderRecord): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO orders (id, client_order_id, mode, venue, instrument_id, decision_id, verdict_id, side, type, quantity, reference_price, status, origin, reason, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MARKET', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      o.id,
      o.clientOrderId,
      o.mode,
      o.venue,
      o.instrumentId,
      o.decisionId,
      o.verdictId,
      o.side,
      o.quantity,
      o.referencePrice,
      o.status,
      o.origin,
      o.reason,
      o.createdAt,
      o.createdAt,
    );
}

/** `fx`: quote → account currency factor applied to this fill. */
export function insertFill(db: D1Database, orderId: string, f: Fill, fx: number): D1PreparedStatement {
  return db
    .prepare('INSERT INTO fills (id, order_id, price, quantity, fee, slippage_bps, ts, fx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), orderId, f.price, f.quantity, f.fee, f.slippageBps, f.ts, fx);
}

export function insertTrade(
  db: D1Database,
  mode: Mode,
  positionId: string,
  decisionId: string | null,
  t: ClosedTrade,
  currency: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO trades (id, mode, position_id, instrument_id, quantity, entry_price, exit_price, opened_at, closed_at, pnl, return_pct, exit_reason, decision_id, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      mode,
      positionId,
      t.instrumentId,
      t.quantity,
      t.entryPrice,
      t.exitPrice,
      t.openedAt,
      t.closedAt,
      t.pnl,
      t.returnPct,
      t.exitReason,
      decisionId,
      currency,
    );
}

/** Trades closed since `since` (the account's reset time), most recent first. */
export async function listTrades(db: D1Database, mode: Mode, since: number, limit = 500): Promise<(ClosedTrade & { id: string })[]> {
  const { results } = await db
    .prepare('SELECT * FROM trades WHERE mode = ? AND closed_at >= ? ORDER BY closed_at DESC LIMIT ?')
    .bind(mode, since, limit)
    .all<Row>();
  return results.map((r) => ({
    id: str(r.id),
    instrumentId: str(r.instrument_id),
    quantity: num(r.quantity),
    entryPrice: num(r.entry_price),
    exitPrice: num(r.exit_price),
    openedAt: num(r.opened_at),
    closedAt: num(r.closed_at),
    pnl: num(r.pnl),
    returnPct: num(r.return_pct),
    exitReason: str(r.exit_reason) as ExitReason,
  }));
}

export async function countNewOrdersSince(db: D1Database, mode: Mode, since: number): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM orders WHERE mode = ? AND side = 'BUY' AND origin = 'ai' AND status = 'FILLED' AND created_at >= ?")
    .bind(mode, since)
    .first<Row>();
  return r ? num(r.n) : 0;
}

export async function listOrders(db: D1Database, mode: Mode, limit = 100): Promise<Row[]> {
  const { results } = await db
    .prepare(
      `SELECT o.*, f.price AS fill_price, f.fee AS fill_fee, f.slippage_bps AS fill_slippage_bps
       FROM orders o LEFT JOIN fills f ON f.order_id = o.id WHERE o.mode = ? ORDER BY o.created_at DESC LIMIT ?`,
    )
    .bind(mode, limit)
    .all<Row>();
  return results;
}

// -------------------------------------------------------------------- equity

export function insertEquitySnapshot(
  db: D1Database,
  mode: Mode,
  p: { ts: number; cash: number; equity: number; exposure: number; drawdown: number; openPositions: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO equity_snapshots (mode, ts, cash, equity, exposure, drawdown, open_positions) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(mode, ts) DO UPDATE SET cash = excluded.cash, equity = excluded.equity, exposure = excluded.exposure,
       drawdown = excluded.drawdown, open_positions = excluded.open_positions`,
    )
    .bind(mode, p.ts, p.cash, p.equity, p.exposure, p.drawdown, p.openPositions);
}

export async function equityCurve(db: D1Database, mode: Mode, since: number): Promise<(EquityPoint & { cash: number; drawdown: number })[]> {
  const { results } = await db
    .prepare('SELECT * FROM equity_snapshots WHERE mode = ? AND ts >= ? ORDER BY ts ASC')
    .bind(mode, since)
    .all<Row>();
  return results.map((r) => ({
    t: num(r.ts),
    equity: num(r.equity),
    cash: num(r.cash),
    exposure: num(r.exposure),
    drawdown: num(r.drawdown),
  }));
}

// ------------------------------------------------------------------- verdicts

export function insertVerdict(
  db: D1Database,
  v: {
    id: string;
    decisionId: string | null;
    origin: string;
    outcome: string;
    requestedQty: number;
    approvedQty: number;
    checks: unknown;
    limits: unknown;
    tradingState: TradingState;
    summary: string;
    createdAt: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO risk_verdicts (id, decision_id, origin, outcome, requested_qty, approved_qty, checks, limits_snapshot, trading_state, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      v.id,
      v.decisionId,
      v.origin,
      v.outcome,
      v.requestedQty,
      v.approvedQty,
      JSON.stringify(v.checks),
      JSON.stringify(v.limits),
      v.tradingState,
      v.summary,
      v.createdAt,
    );
}
