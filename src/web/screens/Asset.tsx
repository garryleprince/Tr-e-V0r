import { lazy, Suspense, useMemo, useState } from 'react';
import { mutate, post } from '../app/api';
import { arrow, barDate, compact, dateTime, dirClass, num, pct, price, symbolOf } from '../app/format';
import { href, navigate } from '../app/router';
import type { AnalysisOutcome, CandlesResponse, Timeframe } from '../app/types';
import { useApi } from '../app/useApi';
import type { ChartMarker, PriceLevel } from '../charts/CandleChart';
import { DecisionCard } from '../ui/domain';
import { IconAi, IconChart, IconTable } from '../ui/icons';
import { Button, Card, ErrorBlock, LoadingBlock, Notice, Pill, Screen, Section, Segmented, Skeleton, Stat } from '../ui/primitives';

const CandleChart = lazy(() => import('../charts/CandleChart').then((m) => ({ default: m.CandleChart })));

const TF_LABELS: Record<Timeframe, string> = { '15m': '15 min', '1h': '1 h', '4h': '4 h', '1d': '1 j' };

export function AssetScreen({ id }: { id: string }) {
  const [tf, setTf] = useState<Timeframe | null>(null);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [running, setRunning] = useState(false);
  const path = `/market/${encodeURIComponent(id)}/candles${tf ? `?tf=${tf}` : ''}`;
  const { data, error, loading, refreshing, reload } = useApi<CandlesResponse>(path);

  const crypto = data?.instrument.assetClass === 'crypto';
  const timeframes: Timeframe[] = crypto ? ['1h', '4h', '1d'] : ['1d'];

  const levels = useMemo<PriceLevel[]>(() => {
    const out: PriceLevel[] = [];
    for (const p of data?.positions ?? []) {
      out.push({ price: p.avgPrice, kind: 'entry', label: 'Entrée' });
      if (p.stopLoss) out.push({ price: p.stopLoss, kind: 'stop', label: 'Stop' });
      if (p.takeProfit) out.push({ price: p.takeProfit, kind: 'target', label: 'Objectif' });
    }
    // No open position: show the latest actionable proposal's levels, labelled as proposed.
    const d = data?.latestDecision;
    if (out.length === 0 && d && d.action === 'BUY' && d.entryPrice) {
      out.push({ price: d.entryPrice, kind: 'entry', label: 'Entrée proposée' });
      if (d.stopLoss) out.push({ price: d.stopLoss, kind: 'stop', label: 'Stop proposé' });
      if (d.takeProfit) out.push({ price: d.takeProfit, kind: 'target', label: 'Objectif proposé' });
    }
    return out;
  }, [data]);

  const markers = useMemo<ChartMarker[]>(() => (data?.positions ?? []).map((p) => ({ t: p.openedAt, side: 'buy', label: 'Achat' })), [data]);

  const runAnalysis = async () => {
    setRunning(true);
    const r = await mutate(() => post<AnalysisOutcome>('/analysis/run', { instrumentId: id }), (o) => o.note || 'Analyse terminée');
    setRunning(false);
    if (r) navigate({ name: 'run', id: r.runId });
  };

  const snap = data?.snapshot ?? null;
  const last = data?.candles[data.candles.length - 1];

  return (
    <Screen
      title={symbolOf(id)}
      eyebrow={data?.instrument.displayName ?? id}
      back={{ href: href({ name: 'market' }), label: 'Marché' }}
    >
      {loading ? (
        <>
          <Skeleton h={40} w="60%" />
          <Skeleton h={360} r={16} />
        </>
      ) : error && !data ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : data ? (
        <>
          <div className="price-head">
            <div className="hero-value num">{price(snap?.lastClose ?? last?.c ?? null, data.instrument.quoteCurrency)}</div>
            <div className={`num ${dirClass(snap?.change1)}`}>
              {arrow(snap?.change1)} {pct(snap?.change1, { sign: true })} <span className="dim small">dernière bougie clôturée</span>
            </div>
          </div>

          <div className="row-between wrap">
            <Segmented<Timeframe>
              label="Unité de temps"
              value={data.timeframe}
              onChange={(v) => setTf(v)}
              options={timeframes.map((t) => ({ value: t, label: TF_LABELS[t] }))}
            />
            <Segmented<'chart' | 'table'>
              label="Affichage"
              value={view}
              onChange={setView}
              options={[
                { value: 'chart', label: <IconChart size={18} />, ariaLabel: 'Graphique' },
                { value: 'table', label: <IconTable size={18} />, ariaLabel: 'Tableau' },
              ]}
            />
          </div>

          {data.warnings.length > 0 ? <Notice tone="warn">{data.warnings.join(' ')}</Notice> : null}

          <div className={refreshing ? 'is-refreshing' : ''}>
            {data.candles.length === 0 ? (
              <Notice tone="warn" title="Aucune bougie disponible">Le fournisseur n’a renvoyé aucune donnée pour cette unité de temps.</Notice>
            ) : view === 'chart' ? (
              <Card className="chart-card">
                <Suspense fallback={<Skeleton h={360} r={12} />}>
                  <CandleChart
                    candles={data.candles}
                    sma50={data.indicators.sma50}
                    sma200={data.indicators.sma200}
                    levels={levels}
                    markers={markers}
                    currency={data.instrument.quoteCurrency}
                  />
                </Suspense>
              </Card>
            ) : (
              <CandleTable data={data} />
            )}
          </div>
          <p className="micro dim">
            Source : {data.source}
            {data.fromCache ? ' (cache)' : ''} · dernière bougie clôturée : {data.asOf ? dateTime(data.asOf) : '—'} · {data.candles.length} bougies
          </p>

          <Section title="Analyse">
            <Button variant="primary" size="lg" loading={running} icon={<IconAi size={20} />} onClick={runAnalysis}>
              {running ? 'Les agents analysent…' : 'Lancer une analyse'}
            </Button>
            <p className="micro dim">
              Utilise l’unité de temps de la liste de suivi. La proposition passe par le Risk Engine ; en mode Recherche rien n’est exécuté.
            </p>
            {data.latestDecision ? <DecisionCard d={data.latestDecision} /> : null}
          </Section>

          {snap ? (
            <Section title="Indicateurs">
              <Card>
                <div className="stat-grid stat-grid-3">
                  <Stat label="RSI 14" value={num(snap.rsi14, 1)} sub={snap.rsi14 === null ? '' : snap.rsi14 > 70 ? 'suracheté' : snap.rsi14 < 30 ? 'survendu' : 'neutre'} />
                  <Stat label="ATR 14" value={pct(snap.atrPct, { digits: 1 })} sub="du prix" />
                  <Stat label="Vol. réalisée" value={pct(snap.realizedVol20, { digits: 0 })} sub="annualisée, 20 b." />
                  <Stat label="MM50" value={price(snap.sma50)} sub={snap.sma50 ? `${arrow(snap.lastClose - snap.sma50)} cours ${snap.lastClose > snap.sma50 ? 'au-dessus' : 'en dessous'}` : 'historique insuffisant'} />
                  <Stat label="MM200" value={price(snap.sma200)} sub={snap.sma200 ? `${arrow(snap.lastClose - snap.sma200)} cours ${snap.lastClose > snap.sma200 ? 'au-dessus' : 'en dessous'}` : 'historique insuffisant'} />
                  <Stat label="MACD" value={num(snap.macd?.histogram ?? null, 2)} sub="histogramme" />
                  <Stat label="Volume" value={snap.volumeZ20 !== null ? `${num(snap.volumeZ20, 1)} σ` : '—'} sub="vs 20 bougies" />
                  <Stat label="Liquidité" value={compact(snap.avgDollarVolume20)} sub="$ moyen / bougie" />
                  <Stat
                    label="Score technique"
                    value={<span className={dirClass(snap.technicalScore)}>{arrow(snap.technicalScore)} {num(snap.technicalScore, 2)}</span>}
                    sub="de −1 à +1"
                  />
                </div>
                <div className="row wrap" style={{ marginTop: 12 }}>
                  <Pill tone={snap.trend === 'up' ? 'up' : snap.trend === 'down' ? 'down' : 'neutral'}>
                    {snap.trend === 'up' ? '▲ Tendance haussière' : snap.trend === 'down' ? '▼ Tendance baissière' : '■ Sans tendance'}
                  </Pill>
                  <Pill tone={snap.volatilityRegime === 'high' ? 'warn' : 'neutral'}>Volatilité {snap.volatilityRegime === 'high' ? 'élevée' : snap.volatilityRegime === 'low' ? 'basse' : 'normale'}</Pill>
                </div>
                {snap.warnings.length > 0 ? <p className="micro dim" style={{ marginTop: 8 }}>{snap.warnings.join(' ')}</p> : null}
              </Card>
            </Section>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

function CandleTable({ data }: { data: CandlesResponse }) {
  const rows = data.candles.slice(-40).reverse();
  const sma50 = new Map(data.indicators.sma50.map((p) => [p.t, p.v]));
  const sma200 = new Map(data.indicators.sma200.map((p) => [p.t, p.v]));
  return (
    <div className="table-wrap card">
      <table className="data-table num">
        <caption className="sr-only">40 dernières bougies clôturées</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Ouv.</th>
            <th scope="col">Haut</th>
            <th scope="col">Bas</th>
            <th scope="col">Clôt.</th>
            <th scope="col">Var.</th>
            <th scope="col">Volume</th>
            <th scope="col">MM50</th>
            <th scope="col">MM200</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k, i) => {
            const prev = rows[i + 1];
            const ch = prev ? k.c / prev.c - 1 : null;
            return (
              <tr key={k.t}>
                <th scope="row">{data.timeframe === '1d' ? barDate(k.t) : dateTime(k.t)}</th>
                <td>{price(k.o)}</td>
                <td>{price(k.h)}</td>
                <td>{price(k.l)}</td>
                <td>{price(k.c)}</td>
                <td className={dirClass(ch)}>
                  {arrow(ch)} {pct(ch, { sign: true })}
                </td>
                <td>{compact(k.v)}</td>
                <td>{price(sma50.get(k.t))}</td>
                <td>{price(sma200.get(k.t))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
