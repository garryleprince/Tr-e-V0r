import { useState } from 'react';
import { AGENT_LABELS, DECISION_STATUS_LABELS } from '@core/labels';
import { mutate, post } from '../app/api';
import { ago, sentence, symbolOf, usd } from '../app/format';
import { href, navigate } from '../app/router';
import type { AnalysisOutcome, Dashboard, RunSummary } from '../app/types';
import { useApi } from '../app/useApi';
import { ActionTag, statusTone } from '../ui/domain';
import { IconAi, IconClock, IconPlay } from '../ui/icons';
import { Button, Card, Empty, ErrorBlock, ListRow, LoadingBlock, Pill, Screen, Section, Sheet } from '../ui/primitives';

const RUN_STATUS: Record<RunSummary['status'], string> = {
  running: 'En cours',
  completed: 'Terminée',
  failed: 'Échec',
  skipped: 'Ignorée',
};

export function AiScreen() {
  const runs = useApi<RunSummary[]>('/analysis/runs?limit=30', { refreshMs: 60_000 });
  const dash = useApi<Dashboard>('/dashboard');
  const [picker, setPicker] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  const run = async (instrumentId: string) => {
    setRunning(instrumentId);
    const r = await mutate(() => post<AnalysisOutcome>('/analysis/run', { instrumentId }), (o) => o.note || 'Analyse terminée');
    setRunning(null);
    setPicker(false);
    if (r) navigate({ name: 'run', id: r.runId });
  };

  const llm = dash.data?.llm;

  return (
    <Screen
      title="IA"
      eyebrow="Agents et décisions"
      actions={
        <Button variant="primary" size="sm" icon={<IconPlay size={14} />} onClick={() => setPicker(true)}>
          Analyser
        </Button>
      }
    >
      <Section title="Équipe d’agents">
        <Card className="stack">
          <AgentLine name={AGENT_LABELS.technical} state={llm?.available ? `IA · ${llm.quickModel}` : 'Règles quantitatives (sans IA)'} tone={llm?.available ? 'accent' : 'neutral'} />
          <AgentLine name={AGENT_LABELS.fundamental} state="Prévu V0.2" tone="neutral" muted />
          <AgentLine name={AGENT_LABELS.sentiment} state="Prévu V0.2" tone="neutral" muted />
          <AgentLine name={AGENT_LABELS.macro} state="Prévu V0.2" tone="neutral" muted />
          <AgentLine name="Trader" state={llm?.available ? `IA · ${llm.deepModel}` : 'Règles quantitatives (sans IA)'} tone={llm?.available ? 'accent' : 'neutral'} />
          <AgentLine name="Gestionnaire de portefeuille" state="Code déterministe" tone="neutral" />
          <AgentLine name="Risk Engine" state="Code déterministe, indépendant" tone="good" />
          <p className="micro dim">
            Un agent indisponible est affiché comme tel et exclu du consensus : il n’est jamais compté comme « neutre ». Aucun modèle ne peut contourner le Risk
            Engine : seul lui fabrique un ordre approuvé.
          </p>
          {llm ? (
            <p className="micro dim num">
              Dépense IA du jour : {usd(llm.spentTodayUsd)} sur un budget de {usd(llm.dailyBudgetUsd)}.
              {!llm.available && llm.reason ? ` ${sentence(llm.reason)}` : ''}
            </p>
          ) : null}
        </Card>
      </Section>

      <Section title="Analyses récentes">
        {runs.loading ? (
          <LoadingBlock lines={5} />
        ) : runs.error && !runs.data ? (
          <ErrorBlock message={runs.error} onRetry={runs.reload} />
        ) : runs.data && runs.data.length > 0 ? (
          <div className="list card-list">
            {runs.data.map((r) => (
              <ListRow
                key={r.id}
                href={href({ name: 'run', id: r.id })}
                icon={<span className="asset-glyph">{symbolOf(r.instrumentId).slice(0, 4)}</span>}
                title={
                  <span className="row wrap">
                    {r.decision ? <ActionTag action={r.decision.action} /> : null}
                    {r.decision ? (
                      <Pill tone={statusTone(r.decision.status)}>{DECISION_STATUS_LABELS[r.decision.status]}</Pill>
                    ) : (
                      <Pill tone={r.status === 'failed' ? 'bad' : 'neutral'}>{RUN_STATUS[r.status]}</Pill>
                    )}
                  </span>
                }
                subtitle={
                  <span className="num">
                    {symbolOf(r.instrumentId)} · {r.timeframe} · {r.trigger === 'schedule' ? 'planifiée' : 'manuelle'} · {ago(r.startedAt)}
                    {r.llmCostUsd > 0 ? ` · ${usd(r.llmCostUsd)}` : ''}
                  </span>
                }
              />
            ))}
          </div>
        ) : (
          <Empty icon={<IconAi />} title="Aucune analyse" action={<Button variant="primary" onClick={() => setPicker(true)}>Lancer la première</Button>}>
            Les analyses planifiées tournent une fois par jour sur la liste de suivi. Vous pouvez aussi en lancer une à la demande.
          </Empty>
        )}
        <p className="micro dim">
          <IconClock size={12} /> Cycle planifié : chaque jour à 00:07 UTC, sur la dernière bougie quotidienne clôturée (crypto et actions).
        </p>
      </Section>

      <Sheet open={picker} onClose={() => setPicker(false)} title="Analyser un actif">
        <div className="list">
          {(dash.data?.watchlist ?? []).map((w) => (
            <ListRow
              key={w.instrumentId}
              onClick={() => run(w.instrumentId)}
              icon={<span className="asset-glyph">{symbolOf(w.instrumentId).slice(0, 4)}</span>}
              title={w.instrument?.displayName ?? symbolOf(w.instrumentId)}
              subtitle={running === w.instrumentId ? 'Les agents analysent…' : undefined}
              chevron={running === null}
            />
          ))}
        </div>
        {running ? <p className="micro dim">Une analyse avec un modèle peut prendre jusqu’à une minute.</p> : null}
      </Sheet>
    </Screen>
  );
}

function AgentLine({ name, state, tone, muted }: { name: string; state: string; tone: 'accent' | 'neutral' | 'good'; muted?: boolean }) {
  return (
    <div className={`row-between agent-line ${muted ? 'is-muted' : ''}`}>
      <span>{name}</span>
      <Pill tone={tone}>{state}</Pill>
    </div>
  );
}
