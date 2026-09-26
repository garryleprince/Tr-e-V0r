import { arrow, money, pct, pnlClass, sentence, usd } from '../app/format';
import { href } from '../app/router';
import type { Dashboard } from '../app/types';
import { useApi } from '../app/useApi';
import { ModeBadge, StateBadge } from '../ui/chrome';
import { DecisionCard, EventRow, EventsEmpty, KillSwitch, WatchRow } from '../ui/domain';
import { IconAi } from '../ui/icons';
import { Card, Empty, ErrorBlock, LinkButton, LoadingBlock, Meter, Notice, Screen, Section, Stat } from '../ui/primitives';

const today = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

export function DashboardScreen() {
  const { data, error, loading, reload } = useApi<Dashboard>('/dashboard', { refreshMs: 60_000 });

  return (
    <Screen
      title="Accueil"
      eyebrow={today.format(new Date())}
      actions={
        data ? (
          <>
            <ModeBadge desk={data.desk} />
            <StateBadge desk={data.desk} />
          </>
        ) : null
      }
    >
      {loading ? (
        <>
          <LoadingBlock lines={2} />
          <LoadingBlock lines={4} />
        </>
      ) : error && !data ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : data ? (
        <DashboardBody d={data} />
      ) : null}
    </Screen>
  );
}

function DashboardBody({ d }: { d: Dashboard }) {
  const p = d.portfolio;
  return (
    <>
      {d.dataNotice ? <Notice tone="warn" title="Données de démonstration">{d.dataNotice}</Notice> : null}
      {!d.llm.available ? (
        <Notice tone="info" title="Modèle d’IA non connecté">
          {sentence(d.llm.reason)} Les analyses utilisent l’analyste quantitatif à règles, clairement signalé « sans IA ».
        </Notice>
      ) : null}

      <Section title="Portefeuille" action={<a className="text-link" href={href({ name: 'portfolio' })}>Détails</a>}>
        {p.initialized ? (
          <Card className="hero">
            <div className="eyebrow">Capital simulé</div>
            <div className="hero-value num">{money(p.equity, p.currency)}</div>
            <div className={`hero-sub num ${pnlClass(p.pnlDay)}`}>
              {arrow(p.pnlDay)} {money(p.pnlDay, p.currency, { sign: true })} ({pct(p.pnlDayPct, { sign: true })}) aujourd’hui
            </div>
            <div className="stat-grid">
              <Stat label="Résultat total" value={<span className={pnlClass(p.pnlTotal)}>{pct(p.pnlTotalPct, { sign: true })}</span>} sub={money(p.pnlTotal, p.currency, { sign: true })} />
              <Stat label="Exposition" value={pct(p.exposurePct, { digits: 0 })} sub={`${p.positions.length} position${p.positions.length > 1 ? 's' : ''}`} />
              <Stat label="Drawdown" value={pct(-p.drawdownPct, { digits: 2 })} sub={`limite ${pct(-p.riskUsage.maxDrawdownPct, { digits: 0 })}`} />
            </div>
          </Card>
        ) : (
          <Empty title="Compte de simulation pas encore créé">Il sera ouvert avec 10 000 $ fictifs à la première analyse.</Empty>
        )}
      </Section>

      <Section title="Marché" action={<a className="text-link" href={href({ name: 'market' })}>Tout voir</a>}>
        <div className="list card-list">
          {d.watchlist.map((w) => (
            <WatchRow key={w.instrumentId} w={w} />
          ))}
        </div>
      </Section>

      <Section title="IA" action={<a className="text-link" href={href({ name: 'ai' })}>Analyses</a>}>
        {d.latestDecision ? (
          <DecisionCard d={d.latestDecision} />
        ) : (
          <Empty icon={<IconAi />} title="Aucune décision pour l’instant" action={<LinkButton href={href({ name: 'market' })} variant="primary">Choisir un actif à analyser</LinkButton>}>
            Ouvrez un actif et lancez une analyse : les agents produisent une proposition, le Risk Engine la juge, et tout est journalisé.
          </Empty>
        )}
        <div className="row-between small muted llm-line">
          <span>
            {d.llm.available ? `Modèle : ${d.llm.deepModel}` : 'Analyste à règles (sans IA)'}
          </span>
          <span className="num">
            Budget IA : {usd(d.llm.spentTodayUsd)} / {usd(d.llm.dailyBudgetUsd)}
          </span>
        </div>
      </Section>

      <Section title="Risque">
        {p.initialized ? (
          <Card className="stack">
            <Meter label="Positions ouvertes" value={p.riskUsage.openPositions} max={p.riskUsage.maxOpenPositions} display={`${p.riskUsage.openPositions} / ${p.riskUsage.maxOpenPositions}`} />
            <Meter label="Exposition" value={p.riskUsage.exposurePct} max={p.riskUsage.maxExposurePct} display={`${pct(p.riskUsage.exposurePct, { digits: 0 })} / ${pct(p.riskUsage.maxExposurePct, { digits: 0 })}`} />
            <Meter label="Perte du jour" value={p.riskUsage.dayLossPct} max={p.riskUsage.maxDayLossPct} display={`${pct(p.riskUsage.dayLossPct, { digits: 1 })} / ${pct(p.riskUsage.maxDayLossPct, { digits: 0 })}`} />
            <Meter label="Drawdown" value={p.riskUsage.drawdownPct} max={p.riskUsage.maxDrawdownPct} display={`${pct(p.riskUsage.drawdownPct, { digits: 1 })} / ${pct(p.riskUsage.maxDrawdownPct, { digits: 0 })}`} />
          </Card>
        ) : null}
        <KillSwitch desk={d.desk} />
      </Section>

      <Section
        title="Activité"
        action={
          <a className="text-link" href={href({ name: 'activity' })}>
            {d.unreadAlerts > 0 ? `${d.unreadAlerts} alerte${d.unreadAlerts > 1 ? 's' : ''}` : 'Journal'}
          </a>
        }
      >
        <div className="card card-list">{d.activity.length > 0 ? d.activity.slice(0, 5).map((e) => <EventRow key={e.id} e={e} />) : <EventsEmpty />}</div>
      </Section>
    </>
  );
}
