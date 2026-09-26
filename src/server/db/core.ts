import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  type Settings,
  type SettingsKey,
} from '../../core/domain/settings';
import { InstrumentSchema, type Candle, type Instrument, type Quote } from '../../core/domain/market';
import type { Timeframe } from '../../core/domain/time';
import { log, newId, parseJson } from '../util';

/**
 * Data access for settings, instruments, candles, quotes, events and job
 * heartbeats. Plain functions over D1; every row is mapped to a typed object.
 */

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

// ------------------------------------------------------------------ settings

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value FROM settings').all<Row>();
  const stored: Record<string, unknown> = {};
  for (const r of results) stored[str(r.key)] = parseJson(strOrNull(r.value), null);
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingsKey[]) {
    const schema = SettingsSchema.shape[key];
    const candidate = stored[key];
    if (candidate === undefined || candidate === null) {
      merged[key] = DEFAULT_SETTINGS[key];
      continue;
    }
    const parsed = schema.safeParse(candidate);
    if (parsed.success) merged[key] = parsed.data;
    else {
      // A stored value that no longer validates (schema change) falls back to
      // the safe default — never to a partially-parsed value.
      log('warn', 'invalid stored setting, using default', { key });
      merged[key] = DEFAULT_SETTINGS[key];
    }
  }
  return merged as Settings;
}

export async function putSetting<K extends SettingsKey>(
  db: D1Database,
  key: K,
  value: Settings[K],
  now: number,
): Promise<void> {
  const parsed = SettingsSchema.shape[key].parse(value);
  await db
    .prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    )
    .bind(key, JSON.stringify(parsed), now)
    .run();
}

// --------------------------------------------------------------- instruments

function mapInstrument(r: Row): Instrument {
  return InstrumentSchema.parse({
    id: r.id,
    provider: r.provider,
    symbol: r.symbol,
    displayName: r.display_name,
    assetClass: r.asset_class,
    quoteCurrency: r.quote_currency,
    priceIncrement: num(r.price_increment),
    sizeIncrement: num(r.size_increment),
    minNotional: num(r.min_notional),
    active: num(r.active) === 1,
  });
}

export async function listInstruments(db: D1Database): Promise<Instrument[]> {
  const { results } = await db.prepare('SELECT * FROM instruments ORDER BY asset_class, id').all<Row>();
  return results.map(mapInstrument);
}

export async function getInstrument(db: D1Database, id: string): Promise<Instrument | null> {
  const r = await db.prepare('SELECT * FROM instruments WHERE id = ?').bind(id).first<Row>();
  return r ? mapInstrument(r) : null;
}

// ------------------------------------------------------------------- candles

export async function upsertCandles(
  db: D1Database,
  instrumentId: string,
  tf: Timeframe,
  candles: readonly Candle[],
  source: string,
  now: number,
): Promise<number> {
  if (candles.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO candles (instrument_id, timeframe, t, o, h, l, c, v, source, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(instrument_id, timeframe, t) DO UPDATE SET
       o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v,
       source = excluded.source, fetched_at = excluded.fetched_at`,
  );
  const batch = candles.map((k) => stmt.bind(instrumentId, tf, k.t, k.o, k.h, k.l, k.c, k.v, source, now));
  for (let i = 0; i < batch.length; i += 100) await db.batch(batch.slice(i, i + 100));
  return candles.length;
}

/** The most recent `limit` stored candles, oldest first. */
export async function getCandles(
  db: D1Database,
  instrumentId: string,
  tf: Timeframe,
  limit: number,
): Promise<{ candles: Candle[]; source: string | null }> {
  const { results } = await db
    .prepare('SELECT t, o, h, l, c, v, source FROM candles WHERE instrument_id = ? AND timeframe = ? ORDER BY t DESC LIMIT ?')
    .bind(instrumentId, tf, limit)
    .all<Row>();
  const candles = results
    .map((r) => ({ t: num(r.t), o: num(r.o), h: num(r.h), l: num(r.l), c: num(r.c), v: num(r.v) }))
    .reverse();
  return { candles, source: results[0] ? str(results[0].source) : null };
}

export interface FetchRecord {
  readonly fetchedAt: number;
  readonly source: string;
  readonly status: string;
  readonly detail: string | null;
}

export async function getFetchRecord(db: D1Database, instrumentId: string, tf: Timeframe): Promise<FetchRecord | null> {
  const r = await db
    .prepare('SELECT fetched_at, source, status, detail FROM candle_fetches WHERE instrument_id = ? AND timeframe = ?')
    .bind(instrumentId, tf)
    .first<Row>();
  return r ? { fetchedAt: num(r.fetched_at), source: str(r.source), status: str(r.status), detail: strOrNull(r.detail) } : null;
}

export async function putFetchRecord(
  db: D1Database,
  instrumentId: string,
  tf: Timeframe,
  rec: FetchRecord,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO candle_fetches (instrument_id, timeframe, fetched_at, source, status, detail) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(instrument_id, timeframe) DO UPDATE SET fetched_at = excluded.fetched_at, source = excluded.source,
       status = excluded.status, detail = excluded.detail`,
    )
    .bind(instrumentId, tf, rec.fetchedAt, rec.source, rec.status, rec.detail)
    .run();
}

// -------------------------------------------------------------------- quotes

export async function putQuote(db: D1Database, instrumentId: string, q: Quote, source: string, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO quotes (instrument_id, bid, ask, last, ts, source, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(instrument_id) DO UPDATE SET bid = excluded.bid, ask = excluded.ask, last = excluded.last,
       ts = excluded.ts, source = excluded.source, fetched_at = excluded.fetched_at`,
    )
    .bind(instrumentId, q.bid, q.ask, q.last, q.ts, source, now)
    .run();
}

export async function getQuote(
  db: D1Database,
  instrumentId: string,
): Promise<(Quote & { source: string; fetchedAt: number }) | null> {
  const r = await db.prepare('SELECT * FROM quotes WHERE instrument_id = ?').bind(instrumentId).first<Row>();
  return r
    ? {
        bid: numOrNull(r.bid),
        ask: numOrNull(r.ask),
        last: num(r.last),
        ts: num(r.ts),
        source: str(r.source),
        fetchedAt: num(r.fetched_at),
      }
    : null;
}

// -------------------------------------------------------------------- events

export type Severity = 'info' | 'warning' | 'critical';
export type Actor = 'user' | 'system' | 'agent' | 'risk';

export interface AppEvent {
  readonly id: string;
  readonly ts: number;
  readonly type: string;
  readonly severity: Severity;
  readonly actor: Actor;
  readonly title: string;
  readonly data: unknown;
  readonly acknowledgedAt: number | null;
}

export function eventStatement(
  db: D1Database,
  e: { ts: number; type: string; severity: Severity; actor: Actor; title: string; data?: unknown },
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO events (id, ts, type, severity, actor, title, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(newId(), e.ts, e.type, e.severity, e.actor, e.title, e.data === undefined ? null : JSON.stringify(e.data));
}

export async function addEvent(
  db: D1Database,
  e: { ts: number; type: string; severity: Severity; actor: Actor; title: string; data?: unknown },
): Promise<void> {
  await eventStatement(db, e).run();
}

export async function listEvents(
  db: D1Database,
  opts: { limit: number; before?: number; minSeverity?: Severity },
): Promise<AppEvent[]> {
  const severities =
    opts.minSeverity === 'critical' ? ['critical'] : opts.minSeverity === 'warning' ? ['warning', 'critical'] : ['info', 'warning', 'critical'];
  const { results } = await db
    .prepare(
      `SELECT * FROM events WHERE ts < ? AND severity IN (${severities.map(() => '?').join(',')}) ORDER BY ts DESC LIMIT ?`,
    )
    .bind(opts.before ?? Number.MAX_SAFE_INTEGER, ...severities, opts.limit)
    .all<Row>();
  return results.map((r) => ({
    id: str(r.id),
    ts: num(r.ts),
    type: str(r.type),
    severity: str(r.severity) as Severity,
    actor: str(r.actor) as Actor,
    title: str(r.title),
    data: parseJson(strOrNull(r.data), null),
    acknowledgedAt: numOrNull(r.acknowledged_at),
  }));
}

export async function acknowledgeEvent(db: D1Database, id: string, now: number): Promise<boolean> {
  const res = await db.prepare('UPDATE events SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL').bind(now, id).run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function countUnacknowledged(db: D1Database): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE acknowledged_at IS NULL AND severity IN ('warning','critical')")
    .first<Row>();
  return r ? num(r.n) : 0;
}

// ---------------------------------------------------------------- heartbeats

export async function beat(db: D1Database, name: string, now: number, status: string, detail?: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO job_heartbeats (name, last_run_at, last_status, detail) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, last_status = excluded.last_status, detail = excluded.detail`,
    )
    .bind(name, now, status, detail ?? null)
    .run();
}

export async function heartbeats(db: D1Database): Promise<{ name: string; lastRunAt: number; lastStatus: string; detail: string | null }[]> {
  const { results } = await db.prepare('SELECT * FROM job_heartbeats ORDER BY name').all<Row>();
  return results.map((r) => ({
    name: str(r.name),
    lastRunAt: num(r.last_run_at),
    lastStatus: str(r.last_status),
    detail: strOrNull(r.detail),
  }));
}
