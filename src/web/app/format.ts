/**
 * French formatting (fr-FR): thin spaces for thousands, comma decimals, and an
 * explicit sign wherever a value is a change or a result.
 */

const cache = new Map<string, Intl.NumberFormat>();

function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) {
    f = new Intl.NumberFormat('fr-FR', opts);
    cache.set(key, f);
  }
  return f;
}

export const DASH = '—';

/** Decimals that keep about five significant digits for a price. */
export function priceDecimals(v: number): number {
  const a = Math.abs(v);
  if (a >= 1 || a === 0) return 2;
  if (a >= 0.01) return 4;
  return 6;
}

export function price(v: number | null | undefined, currency?: string): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const d = priceDecimals(v);
  if (currency) {
    return nf({ style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  }
  return nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
}

export function money(v: number | null | undefined, currency = 'USD', opts: { sign?: boolean; compact?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return nf({
    style: 'currency',
    currency,
    currencyDisplay: 'narrowSymbol',
    ...(opts.compact && Math.abs(v) >= 100_000 ? { notation: 'compact', maximumFractionDigits: 1 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    ...(opts.sign ? { signDisplay: 'exceptZero' } : {}),
  }).format(v);
}

/** A fraction (0.0123) as a percentage (+1,23 %). */
export function pct(v: number | null | undefined, opts: { sign?: boolean; digits?: number } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  const digits = opts.digits ?? 2;
  return nf({ style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits, ...(opts.sign ? { signDisplay: 'exceptZero' } : {}) }).format(v);
}

export function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return nf({ maximumFractionDigits: digits }).format(v);
}

export function qty(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return nf({ maximumFractionDigits: v >= 100 ? 2 : 6 }).format(v);
}

export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return nf({ notation: 'compact', maximumFractionDigits: 1 }).format(v);
}

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return DASH;
  return nf({ style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 }).format(v);
}

const dtf = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const dfUtc = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const tf = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

export function dateTime(ms: number | null | undefined): string {
  return ms ? dtf.format(ms) : DASH;
}

export function date(ms: number | null | undefined): string {
  return ms ? df.format(ms) : DASH;
}

/** Bar dates are UTC session dates: never shift them into the local day. */
export function barDate(ms: number | null | undefined): string {
  return ms ? dfUtc.format(ms) : DASH;
}

export function time(ms: number | null | undefined): string {
  return ms ? tf.format(ms) : DASH;
}

const rtf = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' });

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return DASH;
  const s = Math.round((ms - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return 'à l’instant';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 30 * 86_400) return rtf.format(Math.round(s / 86_400), 'day');
  return date(ms);
}

/** Direction glyph that doubles the colour, so direction never relies on hue alone. */
export function arrow(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return '■';
  return v > 0 ? '▲' : '▼';
}

export function dirClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'up' : 'down';
}

export function pnlClass(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return '';
  return v > 0 ? 'good' : 'bad';
}

export function symbolOf(instrumentId: string): string {
  const s = instrumentId.split(':')[1] ?? instrumentId;
  return s.replace(/-USD$/, '');
}

/** Ends a sentence that may or may not already end with punctuation. */
export function sentence(text: string | null | undefined): string {
  if (!text) return '';
  const t = text.trim();
  const capital = t.charAt(0).toLocaleUpperCase('fr-FR') + t.slice(1);
  return /[.!?…]$/.test(capital) ? capital : `${capital}.`;
}
