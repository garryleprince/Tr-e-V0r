import { AGENT_LABELS, DECISION_STATUS_LABELS, STANCE_LABELS } from '@core/labels';
import { dateTime, num, pct, price, qty, sourceLabel, symbolOf, usd } from '../app/format';
import { href } from '../app/router';
import type { AgentReportRow, DecisionSummary, RunDetail } from '../app/types';
import { useApi } from '../app/useApi';
import { ActionTag, SourceTag, statusTone } from '../ui/domain';
import { IconCheck, IconX } from '../ui/icons';
import { Card, ErrorBlock, LoadingBlock, Notice, Pill, Screen, Section, Stat } from '../ui/primitives';

export function RunDetailScreen({ id }: { id: string }) {
  const { data, error, loading, reload } = useApi<RunDetail>(`/analysis/runs/${encodeURIComponent(id)}`);
  return (
    <Screen
      title={data ? symbolOf(data.run.instrumentId) : 'Analyse'}
      eyebrow={data ? `${dateTime(data.run.startedAt)} · ${data.run.trigger === 'schedule' ? 'planifiée' : 'manuelle'} · ${data.run.timeframe}` : undefined}
      back={{ href: href({ name: 'ai' }), label: 'IA' }}
    >
      {loading ? (
        <>
          <LoadingBlock lines={4} />
          <LoadingBlock lines={6} />
        </>
      ) : error && !data ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : data ? (
        <RunBody r={data} />
      ) : null}
    </Screen>
  );
}

function RunBody({ r }: { r: RunDetail }) {
  const d = r.run.decision;
  return (
    <>
      {r.run.status === 'failed' ? <Notice tone="bad" title="Analyse en échec">{r.run.error}</Notice> : null}
      {r.run.status === 'skipped' ? <Notice tone="info" title="Analyse ignorée">{r.run.error}</Notice> : null}

      {d ? <DecisionSection d={d} /> : null}
      {d?.verdict ? <VerdictSection d={d} /> : null}

      {r.orders.length > 0 ? (
        <Section title="Exécution simulée">
          <div className="card card-list">
            {r.orders.map((o) => (
              <div key={o.id} className="list-row">
                <span className="grow list-main">
                  <span className="list-title">
                    {o.side === 'BUY' ? '▲ Achat' : '▼ Vente'} {qty(o.quantity)} à {price(o.fillPrice)}
                  </span>
                  <span className="list-sub num">
                    frais {usd(o.fee)} · glissement {num(o.slippageBps, 1)} pb · {dateTime(o.createdAt)}
                  </span>
                </span>
                <Pill tone={o.status === 'FILLED' ? 'good' : 'warn'}>{o.status === 'FILLED' ? 'Exécuté' : o.status}</Pill>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {r.consensus ? (
        <Section title="Consensus des agents">
          <Card className="stack">
            <ShareBar label="Haussier" value={r.consensus.bullish} tone="up" />
            <ShareBar label="Neutre" value={r.consensus.neutral} tone="neutral" />
            <ShareBar label="Baissier" value={r.consensus.bearish} tone="down" />
            <p className="micro dim">
              Pondéré par la confiance, sur {r.consensus.available.length} agent{r.consensus.available.length > 1 ? 's' : ''} disponible
              {r.consensus.available.length > 1 ? 's' : ''}.
              {r.consensus.missing.length > 0 ? ` Absents, non comptés : ${r.consensus.missing.map((a) => AGENT_LABELS[a]).join(', ')}.` : ''}
            </p>
          </Card>
        </Section>
      ) : null}

      <Section title="Rapports des agents">
        <div className="stack">
          {r.reports.map((rep) => (
            <ReportCard key={rep.agent} rep={rep} />
          ))}
        </div>
      </Section>

      {r.snapshot ? (
        <Section title="Données au moment de la décision">
          <Card>
            <div className="stat-grid stat-grid-3">
              <Stat label="Dernière clôture" value={price(r.snapshot.lastClose)} />
              <Stat label="RSI 14" value={num(r.snapshot.rsi14, 1)} />
              <Stat label="ATR" value={pct(r.snapshot.atrPct, { digits: 1 })} />
              <Stat label="MM50" value={price(r.snapshot.sma50)} />
              <Stat label="MM200" value={price(r.snapshot.sma200)} />
              <Stat label="Score" value={num(r.snapshot.technicalScore, 2)} />
            </div>
            <p className="micro dim" style={{ marginTop: 10 }}>
              Dernière bougie visible : {dateTime(r.snapshot.asOf)} · {r.snapshot.barsUsed} bougies · source {sourceLabel(r.dataSource)}. Aucune donnée postérieure n’était
              accessible aux agents.
            </p>
          </Card>
        </Section>
      ) : null}

      <p className="micro dim num">
        Coût IA de l’analyse : {usd(r.run.llmCostUsd)} · identifiant {r.run.id}
      </p>
    </>
  );
}

function DecisionSection({ d }: { d: DecisionSummary }) {
  const p = d.proposal;
  const rr = d.entryPrice && d.stopLoss && d.takeProfit && d.entryPrice > d.stopLoss ? (d.takeProfit - d.entryPrice) / (d.entryPrice - d.stopLoss) : null;
  return (
    <Section title="Décision">
      <Card className="stack">
        <div className="row-between">
          <div className="row wrap">
            <ActionTag action={d.action} />
            <SourceTag source={d.source} />
          </div>
          <Pill tone={statusTone(d.status)}>{DECISION_STATUS_LABELS[d.status]}</Pill>
        </div>
        {d.invalidReasons.length > 0 ? (
          <Notice tone="bad" title="Proposition invalide — jamais transformée en « attente »">
            <ul className="plain-list">
              {d.invalidReasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </Notice>
        ) : null}
        <div className="stat-grid">
          <Stat label="Confiance" value={pct(d.confidence, { digits: 0 })} />
          <Stat label="Référence" value={price(d.referencePrice)} />
          <Stat label="Horizon" value={d.horizonBars ? `${d.horizonBars} bougies` : '—'} />
        </div>
        {d.action === 'BUY' || d.action === 'SELL' ? (
          <div className="stat-grid">
            <Stat label="Entrée" value={price(d.entryPrice)} />
            <Stat label="Stop" value={price(d.stopLoss)} sub={d.entryPrice && d.stopLoss ? pct(d.stopLoss / d.entryPrice - 1, { sign: true, digits: 1 }) : undefined} />
            <Stat label="Objectif" value={price(d.takeProfit)} sub={rr !== null ? `gain/risque ${rr.toFixed(2).replace('.', ',')}` : undefined} />
          </div>
        ) : null}
        {p ? (
          <>
            <div className="scenario">
              <div className="row-between">
                <span className="scenario-title">Scénario principal · {p.mainScenario.title}</span>
                <span className="num small">{pct(p.mainScenario.probability, { digits: 0 })}</span>
              </div>
              <p className="small muted">{p.mainScenario.description}</p>
            </div>
            <div className="scenario">
              <div className="row-between">
                <span className="scenario-title">Scénario alternatif · {p.altScenario.title}</span>
                <span className="num small">{pct(p.altScenario.probability, { digits: 0 })}</span>
              </div>
              <p className="small muted">{p.altScenario.description}</p>
            </div>
            {p.keyFactors.length > 0 ? (
              <div>
                <div className="eyebrow">Facteurs déterminants</div>
                <ul className="plain-list small">
                  {p.keyFactors.map((f) => (
                    <li key={f.factor}>
                      <span className={f.direction === 'bullish' ? 'up' : f.direction === 'bearish' ? 'down' : 'dim'}>
                        {f.direction === 'bullish' ? '▲' : f.direction === 'bearish' ? '▼' : '■'}
                      </span>{' '}
                      {f.factor} <span className="dim num">· poids {num(f.weight, 2)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div>
              <div className="eyebrow">Justification</div>
              <p className="small">{p.rationale}</p>
            </div>
            <div>
              <div className="eyebrow">Invalidation</div>
              <p className="small">{p.invalidation}</p>
            </div>
          </>
        ) : null}
        {d.planExplanation ? (
          <div>
            <div className="eyebrow">Gestionnaire de portefeuille</div>
            <p className="small">{d.planExplanation}</p>
          </div>
        ) : null}
        {d.executionNote ? <p className="small muted">Exécution : {d.executionNote}</p> : null}
      </Card>
    </Section>
  );
}

function VerdictSection({ d }: { d: DecisionSummary }) {
  const v = d.verdict!;
  const checks = [...v.checks].sort((a, b) => Number(a.passed) - Number(b.passed));
  const failed = checks.filter((c) => !c.passed).length;
  return (
    <Section title="Verdict du Risk Engine">
      <Card className="stack">
        <div className="row-between">
          <Pill tone={v.outcome === 'REJECTED' ? 'warn' : v.outcome === 'RESIZED' ? 'accent' : 'good'}>
            {v.outcome === 'REJECTED' ? 'Refusé' : v.outcome === 'RESIZED' ? 'Réduit' : 'Approuvé'}
          </Pill>
          <span className="small muted num">
            {qty(v.approvedQty)} / {qty(v.requestedQty)} demandés
          </span>
        </div>
        <p className="small">{v.summary}</p>
        <p className="micro dim">
          {checks.length} règles évaluées, {failed} en échec · état du coupe-circuit : {v.tradingState}
        </p>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.rule} className={c.passed ? 'ok' : c.severity === 'block' ? 'fail' : 'resize'}>
              <span className="check-icon" aria-hidden="true">
                {c.passed ? <IconCheck size={14} /> : <IconX size={14} />}
              </span>
              <span className="grow">
                <span className="check-label">
                  <span className="sr-only">{c.passed ? 'Respectée : ' : 'Non respectée : '}</span>
                  {c.label}
                </span>
                <span className="check-msg">{c.message}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  );
}

function ReportCard({ rep }: { rep: AgentReportRow }) {
  const label = rep.agent === 'trader' ? 'Trader' : AGENT_LABELS[rep.agent];
  const details = rep.details as {
    signals?: { name: string; reading: string; implication: string }[];
    keyLevels?: { label: string; price: number; kind: string }[];
    risks?: string[];
    note?: string;
  };
  return (
    <Card className={`stack report ${rep.status !== 'ok' ? 'is-muted' : ''}`}>
      <div className="row-between">
        <span className="report-name">{label}</span>
        {rep.status === 'unavailable' ? (
          <Pill>Indisponible</Pill>
        ) : rep.status === 'error' ? (
          <Pill tone="bad">Erreur</Pill>
        ) : rep.stance ? (
          <Pill tone={rep.stance === 'bullish' ? 'up' : rep.stance === 'bearish' ? 'down' : 'neutral'}>
            {rep.stance === 'bullish' ? '▲' : rep.stance === 'bearish' ? '▼' : '■'} {STANCE_LABELS[rep.stance]} · {pct(rep.confidence, { digits: 0 })}
          </Pill>
        ) : rep.confidence !== null ? (
          <Pill>{pct(rep.confidence, { digits: 0 })}</Pill>
        ) : null}
      </div>
      <p className="small">{rep.summary}</p>
      {rep.error ? <p className="small bad">{rep.error}</p> : null}
      {details.note ? <p className="micro dim">{details.note}</p> : null}
      {details.signals && details.signals.length > 0 ? (
        <ul className="plain-list small">
          {details.signals.map((s) => (
            <li key={s.name}>
              <span className={s.implication === 'bullish' ? 'up' : s.implication === 'bearish' ? 'down' : 'dim'}>
                {s.implication === 'bullish' ? '▲' : s.implication === 'bearish' ? '▼' : '■'}
              </span>{' '}
              <strong>{s.name}</strong> — {s.reading}
            </li>
          ))}
        </ul>
      ) : null}
      {details.keyLevels && details.keyLevels.length > 0 ? (
        <div className="row wrap">
          {details.keyLevels.map((k) => (
            <Pill key={`${k.kind}-${k.price}`}>
              {k.kind === 'support' ? 'Support' : k.kind === 'resistance' ? 'Résistance' : 'Pivot'} {price(k.price)}
            </Pill>
          ))}
        </div>
      ) : null}
      {details.risks && details.risks.length > 0 ? <p className="micro dim">Risques : {details.risks.join(' · ')}</p> : null}
      <div className="micro dim num">
        {rep.source === 'llm'
          ? `${rep.provider ?? ''} ${rep.model ?? ''} · ${rep.inputTokens ?? 0} + ${rep.outputTokens ?? 0} jetons · ${usd(rep.costUsd)} · ${num((rep.latencyMs ?? 0) / 1000, 1)} s`
          : rep.source === 'rules'
            ? 'Calcul déterministe, sans modèle de langage'
            : 'Non exécuté'}
      </div>
      {rep.transcript ? (
        <details className="transcript">
          <summary>Voir l’échange exact avec le modèle</summary>
          <div className="eyebrow">Consigne système</div>
          <pre>{rep.transcript.system}</pre>
          <div className="eyebrow">Message envoyé</div>
          <pre>{rep.transcript.user}</pre>
          <div className="eyebrow">Réponse brute</div>
          <pre>{rep.transcript.raw}</pre>
        </details>
      ) : null}
    </Card>
  );
}

function ShareBar({ label, value, tone }: { label: string; value: number; tone: 'up' | 'down' | 'neutral' }) {
  return (
    <div className="share">
      <div className="row-between small">
        <span>
          {tone === 'up' ? '▲' : tone === 'down' ? '▼' : '■'} {label}
        </span>
        <span className="num">{pct(value, { digits: 0 })}</span>
      </div>
      <div className="share-track" aria-hidden="true">
        <span className={`share-fill share-${tone}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
      </div>
    </div>
  );
}
