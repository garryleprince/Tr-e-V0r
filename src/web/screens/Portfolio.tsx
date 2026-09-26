import { lazy, Suspense, useState } from 'react';
import { EXIT_REASON_LABELS } from '@core/labels';
import { mutate, post } from '../app/api';
import { arrow, date, dateTime, money, num, pct, pnlClass, price, qty, symbolOf } from '../app/format';
import { href } from '../app/router';
import type { EquityResponse, MarkedPosition, Portfolio, PortfolioReady, TradesResponse } from '../app/types';
import { useApi } from '../app/useApi';
import { IconChart, IconTable, IconWallet } from '../ui/icons';
import { Button, Card, Empty, ErrorBlock, Field, LoadingBlock, Meter, Notice, Screen, Section, Segmented, Sheet, Skeleton, Stat } from '../ui/primitives';

const EquityChart = lazy(() => import('../charts/EquityChart').then((m) => ({ default: m.EquityChart })));

export function PortfolioScreen() {
  const pf = useApi<Portfolio>('/portfolio', { refreshMs: 60_000 });
  return (
    <Screen title="Portefeuille" eyebrow="Compte de simulation">
      {pf.loading ? (
        <>
          <LoadingBlock lines={3} />
          <Skeleton h={300} r={16} />
        </>
      ) : pf.error && !pf.data ? (
        <ErrorBlock message={pf.error} onRetry={pf.reload} />
      ) : pf.data && pf.data.initialized ? (
        <PortfolioBody p={pf.data} />
      ) : (
        <Empty icon={<IconWallet />} title="Compte de simulation pas encore ouvert">
          Il sera créé avec 10 000 $ fictifs à la première analyse. Aucun argent réel n’est engagé dans cette version.
        </Empty>
      )}
    </Screen>
  );
}

function PortfolioBody({ p }: { p: PortfolioReady }) {
  const m = p.metrics;
  return (
    <>
      <Card className="hero">
        <div className="eyebrow">Capital</div>
        <div className="hero-value num">{money(p.equity, p.currency)}</div>
        <div className={`hero-sub num ${pnlClass(p.pnlTotal)}`}>
          {arrow(p.pnlTotal)} {money(p.pnlTotal, p.currency, { sign: true })} ({pct(p.pnlTotalPct, { sign: true })}) depuis le début
        </div>
        <div className="stat-grid">
          <Stat label="Liquidités" value={money(p.cash, p.currency, { compact: true })} />
          <Stat label="Aujourd’hui" value={<span className={pnlClass(p.pnlDay)}>{pct(p.pnlDayPct, { sign: true })}</span>} />
          <Stat label="Drawdown" value={pct(-p.drawdownPct, { digits: 2 })} />
        </div>
      </Card>

      <EquitySection currency={p.currency} />

      <Section title={`Positions ouvertes (${p.positions.length})`}>
        {p.positions.length > 0 ? (
          <div className="stack">
            {p.positions.map((pos) => (
              <PositionCard key={pos.id} pos={pos} currency={p.currency} />
            ))}
          </div>
        ) : (
          <Card>
            <p className="small muted">Aucune position. Les positions s’ouvrent quand une décision d’achat est approuvée par le Risk Engine en mode Simulation.</p>
          </Card>
        )}
      </Section>

      <Section title="Limites de risque">
        <Card className="stack">
          <Meter label="Positions" value={p.riskUsage.openPositions} max={p.riskUsage.maxOpenPositions} display={`${p.riskUsage.openPositions} / ${p.riskUsage.maxOpenPositions}`} />
          <Meter label="Exposition" value={p.riskUsage.exposurePct} max={p.riskUsage.maxExposurePct} display={`${pct(p.riskUsage.exposurePct, { digits: 0 })} / ${pct(p.riskUsage.maxExposurePct, { digits: 0 })}`} />
          <Meter label="Perte du jour" value={p.riskUsage.dayLossPct} max={p.riskUsage.maxDayLossPct} display={`${pct(p.riskUsage.dayLossPct, { digits: 1 })} / ${pct(p.riskUsage.maxDayLossPct, { digits: 0 })}`} />
          <Meter label="Drawdown" value={p.riskUsage.drawdownPct} max={p.riskUsage.maxDrawdownPct} display={`${pct(p.riskUsage.drawdownPct, { digits: 1 })} / ${pct(p.riskUsage.maxDrawdownPct, { digits: 0 })}`} />
          <p className="micro dim">Pertes consécutives : {p.consecutiveLosses} / {p.riskLimits.maxConsecutiveLosses} avant pause de {p.riskLimits.cooldownHours} h.</p>
          <a className="text-link small" href={href({ name: 'risk' })}>
            Régler les limites
          </a>
        </Card>
      </Section>

      <Section title="Performance">
        <Card>
          <div className="stat-grid stat-grid-3">
            <Stat label="Rendement" value={<span className={pnlClass(m.totalReturn)}>{pct(m.totalReturn, { sign: true })}</span>} />
            <Stat label="Drawdown max" value={pct(-m.maxDrawdown, { digits: 2 })} />
            <Stat label="Trades clos" value={String(m.trades)} />
            <Stat label="Taux de réussite" value={pct(m.winRate, { digits: 0 })} />
            <Stat label="Facteur de profit" value={num(m.profitFactor, 2)} />
            <Stat label="Espérance / trade" value={money(m.expectancy, p.currency, { sign: true })} />
            <Stat label="Sharpe" value={num(m.sharpe, 2)} />
            <Stat label="Sortino" value={num(m.sortino, 2)} />
            <Stat label="Exposition moy." value={pct(m.averageExposure, { digits: 0 })} />
          </div>
          <p className="micro dim" style={{ marginTop: 10 }}>
            Calculé sur la simulation depuis le {date(p.resetAt)}, frais et glissement inclus. Avec peu de trades, ces chiffres ne sont pas statistiquement
            significatifs.
          </p>
        </Card>
      </Section>

      <TradesSection currency={p.currency} />
      <ResetSection hasPositions={p.positions.length > 0} startingCash={p.startingCash} />
    </>
  );
}

function EquitySection({ currency }: { currency: string }) {
  const eq = useApi<EquityResponse>('/portfolio/equity');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const curve = eq.data?.curve ?? [];
  return (
    <Section
      title="Capital et drawdown"
      action={
        <Segmented<'chart' | 'table'>
          label="Affichage"
          value={view}
          onChange={setView}
          options={[
            { value: 'chart', label: <IconChart size={18} />, ariaLabel: 'Graphique' },
            { value: 'table', label: <IconTable size={18} />, ariaLabel: 'Tableau' },
          ]}
        />
      }
    >
      {eq.loading ? (
        <Skeleton h={300} r={16} />
      ) : eq.error && !eq.data ? (
        <ErrorBlock message={eq.error} onRetry={eq.reload} />
      ) : curve.length < 2 ? (
        <Card>
          <p className="small muted">La courbe apparaîtra après quelques relevés (un toutes les 15 minutes par la surveillance).</p>
        </Card>
      ) : view === 'chart' ? (
        <Card className="chart-card">
          <Suspense fallback={<Skeleton h={300} r={12} />}>
            <EquityChart curve={curve} currency={currency} />
          </Suspense>
        </Card>
      ) : (
        <div className="table-wrap card">
          <table className="data-table num">
            <caption className="sr-only">Relevés du capital simulé</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Capital</th>
                <th scope="col">Liquidités</th>
                <th scope="col">Drawdown</th>
              </tr>
            </thead>
            <tbody>
              {curve
                .slice(-60)
                .reverse()
                .map((pt) => (
                  <tr key={pt.t}>
                    <th scope="row">{dateTime(pt.t)}</th>
                    <td>{money(pt.equity, currency)}</td>
                    <td>{money(pt.cash, currency)}</td>
                    <td>{pct(-Math.abs(pt.drawdown), { digits: 2 })}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function PositionCard({ pos, currency }: { pos: MarkedPosition; currency: string }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = async () => {
    setBusy(true);
    const r = await mutate(() => post(`/portfolio/positions/${encodeURIComponent(pos.id)}/close`, { confirm: true }), 'Position clôturée en simulation');
    setBusy(false);
    if (r) setConfirm(false);
  };
  return (
    <Card className="stack position">
      <div className="row-between">
        <a className="position-name" href={href({ name: 'asset', id: pos.instrumentId })}>
          {symbolOf(pos.instrumentId)}
        </a>
        <span className={`num ${pnlClass(pos.unrealizedPnl)}`}>
          {arrow(pos.unrealizedPnl)} {money(pos.unrealizedPnl, currency, { sign: true })} ({pct(pos.unrealizedPct, { sign: true })})
        </span>
      </div>
      <div className="kv-grid num small">
        <span className="dim">Quantité</span>
        <span>{qty(pos.quantity)}</span>
        <span className="dim">Prix moyen</span>
        <span>{price(pos.avgPrice)}</span>
        <span className="dim">Cours</span>
        <span>{price(pos.markPrice)}</span>
        <span className="dim">Valeur</span>
        <span>{money(pos.marketValue, currency)}</span>
        <span className="dim">Stop</span>
        <span>{price(pos.stopLoss)}</span>
        <span className="dim">Objectif</span>
        <span>{price(pos.takeProfit)}</span>
        <span className="dim">Échéance</span>
        <span>{pos.expiresAt ? dateTime(pos.expiresAt) : '—'}</span>
        <span className="dim">Ouverte</span>
        <span>{dateTime(pos.openedAt)}</span>
      </div>
      <div className="row">
        <Button size="sm" onClick={() => setConfirm(true)}>
          Clôturer
        </Button>
        {pos.decisionId ? <span className="micro dim">issue d’une décision de l’IA</span> : null}
      </div>
      <Sheet open={confirm} onClose={() => setConfirm(false)} title={`Clôturer ${symbolOf(pos.instrumentId)}`}>
        <div className="stack">
          <p className="small muted">
            Vente simulée de {qty(pos.quantity)} au cours actuel, frais et glissement inclus. Une clôture manuelle est un frein : elle passe même quand le
            coupe-circuit est activé.
          </p>
          <Button variant="primary" size="lg" loading={busy} onClick={close}>
            Confirmer la clôture
          </Button>
        </div>
      </Sheet>
    </Card>
  );
}

function TradesSection({ currency }: { currency: string }) {
  const t = useApi<TradesResponse>('/portfolio/trades');
  const trades = t.data?.trades ?? [];
  return (
    <Section title="Trades clôturés">
      {t.loading ? (
        <LoadingBlock lines={3} />
      ) : trades.length === 0 ? (
        <Card>
          <p className="small muted">Aucun trade clôturé pour l’instant.</p>
        </Card>
      ) : (
        <div className="card card-list">
          {trades.slice(0, 30).map((tr) => (
            <div key={tr.id} className="list-row">
              <span className="grow list-main">
                <span className="list-title">
                  {symbolOf(tr.instrumentId)} <span className="dim small">· {EXIT_REASON_LABELS[tr.exitReason]}</span>
                </span>
                <span className="list-sub num">
                  {price(tr.entryPrice)} → {price(tr.exitPrice)} · {date(tr.openedAt)} → {date(tr.closedAt)}
                </span>
              </span>
              <span className={`num ${pnlClass(tr.pnl)}`}>
                {arrow(tr.pnl)} {money(tr.pnl, currency, { sign: true })}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function ResetSection({ hasPositions, startingCash }: { hasPositions: boolean; startingCash: number }) {
  const [open, setOpen] = useState(false);
  const [cash, setCash] = useState(String(startingCash));
  const [busy, setBusy] = useState(false);
  const value = Number(cash.replace(/\s/g, '').replace(',', '.'));
  const valid = Number.isFinite(value) && value >= 100 && value <= 10_000_000;
  const reset = async () => {
    setBusy(true);
    const r = await mutate(() => post('/portfolio/reset', { startingCash: value }, 'Réinitialiser la simulation exige votre mot de passe.'), 'Simulation réinitialisée');
    setBusy(false);
    if (r) setOpen(false);
  };
  return (
    <Section title="Simulation">
      <Card className="stack">
        <p className="small muted">
          Repartir d’un capital neuf. L’historique n’est pas effacé : il reste consultable dans le journal, les statistiques repartent de zéro.
        </p>
        {hasPositions ? <Notice tone="info">Clôturez d’abord les positions ouvertes.</Notice> : null}
        <Button onClick={() => setOpen(true)} disabled={hasPositions}>
          Réinitialiser la simulation
        </Button>
      </Card>
      <Sheet open={open} onClose={() => setOpen(false)} title="Réinitialiser la simulation">
        <div className="stack">
          <Field label="Capital de départ ($)" error={valid ? null : 'Entre 100 et 10 000 000.'}>
            {(id) => <input id={id} className="input num" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} />}
          </Field>
          <Button variant="primary" size="lg" loading={busy} disabled={!valid} onClick={reset}>
            Réinitialiser
          </Button>
        </div>
      </Sheet>
    </Section>
  );
}
