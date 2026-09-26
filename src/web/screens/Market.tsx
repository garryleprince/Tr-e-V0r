import { arrow, dirClass, pct, price, symbolOf } from '../app/format';
import { href } from '../app/router';
import type { WatchItem } from '../app/types';
import { useApi } from '../app/useApi';
import { Sparkline } from '../ui/Sparkline';
import { ErrorBlock, ListRow, LoadingBlock, Pill, Screen, Section } from '../ui/primitives';

const TREND = { up: 'Tendance haussière', down: 'Tendance baissière', range: 'Sans tendance' } as const;
const VOL = { low: 'Volatilité basse', normal: 'Volatilité normale', high: 'Volatilité élevée' } as const;

export function MarketScreen() {
  const { data, error, loading, reload } = useApi<WatchItem[]>('/market/watchlist', { refreshMs: 60_000 });
  return (
    <Screen title="Marché" eyebrow="Liste de suivi">
      {loading ? (
        <LoadingBlock lines={5} />
      ) : error && !data ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : data ? (
        <>
          <Section title="Actifs suivis" action={<a className="text-link" href={href({ name: 'settings' })}>Modifier</a>}>
            <div className="list card-list">
              {data.map((w) =>
                w.error !== undefined ? (
                  <ListRow
                    key={w.instrumentId}
                    href={href({ name: 'asset', id: w.instrumentId })}
                    title={symbolOf(w.instrumentId)}
                    subtitle={<span className="bad">Données indisponibles : {w.error}</span>}
                  />
                ) : (
                  <ListRow
                    key={w.instrumentId}
                    href={href({ name: 'asset', id: w.instrumentId })}
                    icon={<span className="asset-glyph">{symbolOf(w.instrumentId).slice(0, 4)}</span>}
                    title={
                      <span className="row">
                        <span>{symbolOf(w.instrumentId)}</span>
                        <span className="num">{price(w.last, w.instrument.quoteCurrency)}</span>
                      </span>
                    }
                    subtitle={
                      <span className="row wrap">
                        {w.trend ? <Pill tone={w.trend === 'up' ? 'up' : w.trend === 'down' ? 'down' : 'neutral'}>{TREND[w.trend]}</Pill> : null}
                        {w.volatilityRegime ? <Pill tone={w.volatilityRegime === 'high' ? 'warn' : 'neutral'}>{VOL[w.volatilityRegime]}</Pill> : null}
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
                ),
              )}
            </div>
          </Section>
          <p className="micro dim">
            Variation sur la dernière bougie clôturée et sur 20 bougies. Seules les bougies clôturées sont utilisées : la bougie en cours n’est jamais affichée
            comme un fait.
          </p>
        </>
      ) : null}
    </Screen>
  );
}
