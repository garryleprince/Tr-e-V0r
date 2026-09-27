import { arrow, dirClass, exchangeOf, MARKET_LABELS, marketOf, pct, price, symbolOf, type MarketGroup } from '../app/format';
import { href } from '../app/router';
import type { WatchItem } from '../app/types';
import { useApi } from '../app/useApi';
import { Sparkline } from '../ui/Sparkline';
import { ErrorBlock, ListRow, LoadingBlock, Screen, Section } from '../ui/primitives';

const TREND = { up: '▲ haussier', down: '▼ baissier', range: '■ sans tendance' } as const;
const VOL = { low: 'calme', normal: '', high: 'volatil' } as const;
const ORDER: readonly MarketGroup[] = ['crypto', 'us', 'eu'];

function groupOf(w: WatchItem): MarketGroup {
  if (w.instrument) return marketOf(w.instrument);
  return w.instrumentId.startsWith('coinbase:') ? 'crypto' : exchangeOf(w.instrumentId) ? 'eu' : 'us';
}

export function MarketScreen() {
  const { data, error, loading, reload } = useApi<WatchItem[]>('/market/watchlist', { refreshMs: 60_000 });
  return (
    <Screen
      title="Marché"
      eyebrow="Liste de suivi"
      actions={
        <a className="text-link" href={href({ name: 'settings' })}>
          Modifier
        </a>
      }
    >
      {loading ? (
        <LoadingBlock lines={5} />
      ) : error && !data ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : data ? (
        <>
          {ORDER.map((group) => {
            const items = data.filter((w) => groupOf(w) === group);
            if (items.length === 0) return null;
            return (
              <Section key={group} title={MARKET_LABELS[group]}>
                <div className="list card-list">
                  {items.map((w) => (
                    <MarketRow key={w.instrumentId} w={w} />
                  ))}
                </div>
              </Section>
            );
          })}
          <p className="micro dim">
            Variation sur la dernière bougie clôturée et sur 20 bougies, dans la devise de cotation de chaque actif. Seules les bougies clôturées sont utilisées :
            la bougie en cours n’est jamais affichée comme un fait.
          </p>
        </>
      ) : null}
    </Screen>
  );
}

function MarketRow({ w }: { w: WatchItem }) {
  if (w.error !== undefined) {
    return (
      <ListRow
        href={href({ name: 'asset', id: w.instrumentId })}
        icon={<span className="asset-glyph">{symbolOf(w.instrumentId).slice(0, 4)}</span>}
        title={w.instrument?.displayName ?? symbolOf(w.instrumentId)}
        subtitle={<span className="bad">Données indisponibles : {w.error}</span>}
      />
    );
  }
  return (
    <ListRow
      href={href({ name: 'asset', id: w.instrumentId })}
      icon={<span className="asset-glyph">{symbolOf(w.instrumentId).slice(0, 4)}</span>}
      title={<span className="truncate block">{w.instrument.displayName}</span>}
      subtitle={
        <span className="stack-0">
          <span className="num">{price(w.last, w.instrument.quoteCurrency)}</span>
          <span className="truncate block micro">
            {w.trend ? TREND[w.trend] : '—'}
            {w.volatilityRegime && VOL[w.volatilityRegime] ? ` · ${VOL[w.volatilityRegime]}` : ''}
          </span>
        </span>
      }
      trailing={
        <span className="watch-trailing">
          <Sparkline values={w.sparkline} />
          <span className="stack-tight">
            <span className={`num change ${dirClass(w.change1)}`}>
              {arrow(w.change1)} {pct(w.change1, { sign: true })}
            </span>
            <span className={`num micro ${dirClass(w.change20)}`}>20 b. {pct(w.change20, { sign: true, digits: 1 })}</span>
          </span>
        </span>
      }
    />
  );
}
