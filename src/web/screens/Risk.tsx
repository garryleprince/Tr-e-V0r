import { useEffect, useMemo, useState } from 'react';
import { HARD_CAPS } from '@core/risk/caps';
import { mutate, put } from '../app/api';
import { num } from '../app/format';
import { href } from '../app/router';
import type { Dashboard, RiskLimits, SettingsResponse } from '../app/types';
import { useApi } from '../app/useApi';
import { KillSwitch, ModeControl } from '../ui/domain';
import { Button, Card, ErrorBlock, Field, LoadingBlock, Notice, Screen, Section } from '../ui/primitives';

type Key = keyof RiskLimits;

const GROUPS: readonly { title: string; keys: readonly Key[] }[] = [
  { title: 'Taille et exposition', keys: ['maxRiskPerTradePct', 'maxPositionPct', 'maxGrossExposurePct', 'maxOpenPositions', 'maxCorrelation'] },
  { title: 'Pertes et pauses', keys: ['maxDailyLossPct', 'maxDrawdownPct', 'maxConsecutiveLosses', 'cooldownHours', 'maxNewOrdersPerDay'] },
  { title: 'Qualité de la proposition', keys: ['minConfidence', 'minRewardRisk', 'minStopDistanceAtr', 'maxStopDistancePct', 'maxEntryDeviationPct'] },
  { title: 'Conditions de marché', keys: ['maxAtrPct', 'minAvgDollarVolume', 'maxParticipationPct', 'maxSpreadBps', 'maxDataAgeBars'] },
];

const CAPS: Partial<Record<Key, number>> = HARD_CAPS;

function parseNumber(s: string): number {
  return Number(s.replace(/\s/g, '').replace(',', '.'));
}

export function RiskScreen() {
  const settings = useApi<SettingsResponse>('/settings');
  const dash = useApi<Dashboard>('/dashboard');
  return (
    <Screen title="Risque et contrôle" back={{ href: href({ name: 'more' }), label: 'Plus' }}>
      <Section title="Mode d’autonomie">
        {dash.data ? (
          <Card>
            <ModeControl desk={dash.data.desk} />
          </Card>
        ) : (
          <LoadingBlock lines={2} />
        )}
      </Section>
      <Section title="Coupe-circuit">{dash.data ? <KillSwitch desk={dash.data.desk} /> : <LoadingBlock lines={2} />}</Section>
      <Section title="Limites du Risk Engine">
        {settings.loading ? (
          <LoadingBlock lines={8} />
        ) : settings.error && !settings.data ? (
          <ErrorBlock message={settings.error} onRetry={settings.reload} />
        ) : settings.data ? (
          <LimitsForm current={settings.data.settings.risk} labels={settings.data.labels.risk} />
        ) : null}
      </Section>
    </Screen>
  );
}

function LimitsForm({ current, labels }: { current: RiskLimits; labels: Record<Key, string> }) {
  const initial = useMemo(() => Object.fromEntries(Object.entries(current).map(([k, v]) => [k, String(v).replace('.', ',')])) as Record<Key, string>, [current]);
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm(initial), [initial]);

  const parsed = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, parseNumber(v)])) as RiskLimits;
  const invalid = (Object.keys(form) as Key[]).filter((k) => !Number.isFinite(parsed[k]) || parsed[k] < 0 || (CAPS[k] !== undefined && parsed[k] > CAPS[k]!));
  const dirty = (Object.keys(form) as Key[]).some((k) => parsed[k] !== current[k]);

  const save = async () => {
    setBusy(true);
    await mutate(() => put('/settings/risk', parsed, 'Desserrer une limite de risque exige votre mot de passe.'), 'Limites enregistrées');
    setBusy(false);
  };

  return (
    <div className="stack">
      <Notice tone="info">
        Resserrer une limite est immédiat. La desserrer demande votre mot de passe et laisse une alerte dans le journal. Aucun réglage ne peut dépasser les
        plafonds fixés dans le code.
      </Notice>
      {GROUPS.map((g) => (
        <Card key={g.title} className="stack">
          <div className="eyebrow">{g.title}</div>
          {g.keys.map((k) => (
            <Field
              key={k}
              label={labels[k]}
              hint={CAPS[k] !== undefined ? `Plafond : ${num(CAPS[k]!, 4)}` : undefined}
              error={invalid.includes(k) ? (CAPS[k] !== undefined ? `Valeur entre 0 et ${num(CAPS[k]!, 4)}.` : 'Valeur invalide.') : null}
            >
              {(id) => (
                <input
                  id={id}
                  className="input num"
                  inputMode="decimal"
                  value={form[k]}
                  onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </Card>
      ))}
      {dirty ? (
        <div className="sticky-actions">
          <Button variant="primary" size="lg" loading={busy} disabled={invalid.length > 0} onClick={save}>
            Enregistrer les limites
          </Button>
          <Button variant="ghost" className="sticky-cancel" onClick={() => setForm(initial)}>
            Annuler les modifications
          </Button>
        </div>
      ) : null}
    </div>
  );
}
