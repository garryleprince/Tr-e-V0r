import { useEffect, useState } from 'react';
import { mutate, put } from '../app/api';
import { exchangeOf, MARKET_LABELS, marketOf, symbolOf } from '../app/format';
import { href } from '../app/router';
import { useApp, type Theme } from '../app/store';
import type { Settings, SettingsResponse, Timeframe } from '../app/types';
import { useApi } from '../app/useApi';
import { IconMoon, IconSun } from '../ui/icons';
import { Button, Card, ErrorBlock, Field, LoadingBlock, Notice, Pill, Screen, Section, Segmented, Toggle } from '../ui/primitives';

/** Same bound as the server's watchlist schema: the daily cycle must fit in one cron run. */
const WATCHLIST_MAX = 12;

export function SettingsScreen() {
  const { data, error, loading, reload } = useApi<SettingsResponse>('/settings');
  return (
    <Screen title="Réglages" back={{ href: href({ name: 'more' }), label: 'Plus' }}>
      <AppearanceSection />
      {loading ? (
        <LoadingBlock lines={8} />
      ) : error && !data ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : data ? (
        <>
          <WatchlistSection data={data} />
          <LlmSection data={data} />
          <CostsSection value={data.settings.costs} />
          <ScheduleSection value={data.settings.schedule} />
        </>
      ) : null}
    </Screen>
  );
}

function AppearanceSection() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  return (
    <Section title="Apparence">
      <Segmented<Theme>
        label="Thème"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'system', label: 'Système' },
          { value: 'dark', label: <span className="row" style={{ justifyContent: 'center', gap: 6 }}><IconMoon size={16} /> Sombre</span> },
          { value: 'light', label: <span className="row" style={{ justifyContent: 'center', gap: 6 }}><IconSun size={16} /> Clair</span> },
        ]}
      />
    </Section>
  );
}

function WatchlistSection({ data }: { data: SettingsResponse }) {
  const [ids, setIds] = useState<string[]>(data.settings.watchlist.instrumentIds);
  const [tf, setTf] = useState<Timeframe>(data.settings.watchlist.timeframe);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setIds(data.settings.watchlist.instrumentIds);
    setTf(data.settings.watchlist.timeframe);
  }, [data]);
  const toggle = (id: string, on: boolean) => setIds((xs) => (on ? [...xs, id] : xs.filter((x) => x !== id)));
  const save = async () => {
    setBusy(true);
    await mutate(() => put('/settings/watchlist', { instrumentIds: ids, timeframe: tf }), 'Liste de suivi enregistrée');
    setBusy(false);
  };
  const equityDaily = tf !== '1d' && ids.some((id) => data.instruments.find((i) => i.id === id)?.assetClass !== 'crypto');
  const full = ids.length >= WATCHLIST_MAX;
  const needsKey = !data.secrets.alphaVantage && ids.some((id) => id.startsWith('alphavantage:'));
  return (
    <Section title="Liste de suivi">
      <Card className="stack">
        <p className="small muted">
          {ids.length} / {WATCHLIST_MAX} actifs. Chacun est analysé une fois par jour ; les actions consomment une requête Alpha Vantage par jour.
        </p>
        {needsKey ? (
          <Notice tone="warn" title="Clé Alpha Vantage absente">
            Les actions US et européennes ne peuvent pas être chargées sans le secret ALPHAVANTAGE_API_KEY (gratuit sur alphavantage.co).
          </Notice>
        ) : null}
        {(['crypto', 'us', 'eu'] as const).map((group) => (
          <div key={group} className="stack">
            <div className="eyebrow">{MARKET_LABELS[group]}</div>
            {data.instruments
              .filter((i) => i.assetClass !== 'fx' && marketOf(i) === group)
              .map((i) => (
                <Toggle
                  key={i.id}
                  checked={ids.includes(i.id)}
                  onChange={(on) => (on && full ? undefined : toggle(i.id, on))}
                  label={i.displayName}
                  hint={`${symbolOf(i.id)} · ${i.quoteCurrency} · ${
                    group === 'crypto' ? 'Coinbase (Kraken en secours)' : `${exchangeOf(i.symbol) ?? 'NYSE / Nasdaq'}, quotidien`
                  }`}
                />
              ))}
          </div>
        ))}
        {full ? <p className="micro dim">Maximum atteint : retirez un actif pour en ajouter un autre.</p> : null}
        <Field label="Unité de temps des analyses">
          {() => (
            <Segmented<Timeframe>
              label="Unité de temps des analyses"
              value={tf}
              onChange={setTf}
              options={[
                { value: '1h', label: '1 h' },
                { value: '4h', label: '4 h' },
                { value: '1d', label: '1 jour' },
              ]}
            />
          )}
        </Field>
        {equityDaily ? <Notice tone="warn">Les actions et ETF ne sont disponibles qu’en quotidien : leur analyse échouera sur une autre unité.</Notice> : null}
        <p className="micro dim">Le cycle planifié tourne une fois par jour ; une unité plus fine sert surtout aux analyses manuelles.</p>
        <Button variant="primary" loading={busy} disabled={ids.length === 0} onClick={save}>
          Enregistrer
        </Button>
      </Card>
    </Section>
  );
}

function LlmSection({ data }: { data: SettingsResponse }) {
  const [llm, setLlm] = useState<Settings['llm']>(data.settings.llm);
  const [budget, setBudget] = useState(String(data.settings.llm.dailyBudgetUsd ?? 5));
  const [unlimited, setUnlimited] = useState(data.settings.llm.dailyBudgetUsd === null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setLlm(data.settings.llm);
    setBudget(String(data.settings.llm.dailyBudgetUsd ?? 5));
    setUnlimited(data.settings.llm.dailyBudgetUsd === null);
  }, [data]);
  const set = <K extends keyof Settings['llm']>(k: K, v: Settings['llm'][K]) => setLlm((x) => ({ ...x, [k]: v }));
  const budgetValue = Number(budget.replace(',', '.'));
  const save = async () => {
    setBusy(true);
    await mutate(
      () => put('/settings/llm', { ...llm, dailyBudgetUsd: unlimited ? null : budgetValue, baseUrl: llm.baseUrl?.trim() || null }),
      'Réglages IA enregistrés',
    );
    setBusy(false);
  };
  const keyPresent = llm.provider === 'anthropic' ? data.secrets.anthropic : llm.provider === 'openai-compatible' ? data.secrets.openaiCompatible : true;
  return (
    <Section title="Modèle d’IA">
      <Card className="stack">
        <Field label="Fournisseur">
          {(id) => (
            <select id={id} className="input" value={llm.provider} onChange={(e) => set('provider', e.target.value as Settings['llm']['provider'])}>
              <option value="anthropic">Claude (Anthropic)</option>
              <option value="openai-compatible">Compatible OpenAI (GPT, Gemini, modèle local…)</option>
              <option value="disabled">Désactivé : règles quantitatives uniquement</option>
            </select>
          )}
        </Field>
        {llm.provider !== 'disabled' ? (
          <>
            <div className="row-between small">
              <span className="muted">Clé API ({llm.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_COMPATIBLE_API_KEY'})</span>
              {keyPresent ? <Pill tone="good">Secret configuré</Pill> : <Pill tone="warn">Absente</Pill>}
            </div>
            <p className="micro dim">
              Les clés sont des secrets du Worker Cloudflare (<code>wrangler secret put</code>). Elles ne transitent jamais par cette page et ne peuvent pas y être
              saisies.
            </p>
            {llm.provider === 'openai-compatible' ? (
              <Field label="URL de base" hint="Ex. https://api.openai.com/v1 ou l’URL d’un serveur local compatible.">
                {(id) => <input id={id} className="input" inputMode="url" value={llm.baseUrl ?? ''} onChange={(e) => set('baseUrl', e.target.value)} />}
              </Field>
            ) : null}
            <Field label="Modèle du trader (décision)">
              {(id) => <input id={id} className="input" value={llm.deepModel} onChange={(e) => set('deepModel', e.target.value)} />}
            </Field>
            <Field label="Effort du trader">
              {() => (
                <Segmented
                  label="Effort du trader"
                  value={llm.deepEffort}
                  onChange={(v) => set('deepEffort', v)}
                  options={[
                    { value: 'low', label: 'Faible' },
                    { value: 'medium', label: 'Moyen' },
                    { value: 'high', label: 'Élevé' },
                  ]}
                />
              )}
            </Field>
            <Field label="Modèle des analystes">
              {(id) => <input id={id} className="input" value={llm.quickModel} onChange={(e) => set('quickModel', e.target.value)} />}
            </Field>
            <Field label="Effort des analystes">
              {() => (
                <Segmented
                  label="Effort des analystes"
                  value={llm.quickEffort}
                  onChange={(v) => set('quickEffort', v)}
                  options={[
                    { value: 'low', label: 'Faible' },
                    { value: 'medium', label: 'Moyen' },
                    { value: 'high', label: 'Élevé' },
                  ]}
                />
              )}
            </Field>
            <Toggle
              checked={unlimited}
              onChange={setUnlimited}
              label="Budget quotidien illimité"
              hint="Aucun plafond dans l’application : seule la limite de dépense de votre compte chez le fournisseur s’applique. Réglez-en une dans sa console."
            />
            {!unlimited ? (
              <Field label="Budget quotidien ($)" hint="Au-delà, les appels sont refusés jusqu’au lendemain (UTC).">
                {(id) => <input id={id} className="input num" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />}
              </Field>
            ) : null}
            <Toggle
              checked={llm.fallbackToRules}
              onChange={(v) => set('fallbackToRules', v)}
              label="Repli sur les règles si le modèle échoue"
              hint="Désactivé : un échec du modèle produit une décision « invalide », visible comme telle."
            />
          </>
        ) : null}
        <Button variant="primary" loading={busy} disabled={!unlimited && (!Number.isFinite(budgetValue) || budgetValue < 0)} onClick={save}>
          Enregistrer
        </Button>
      </Card>
    </Section>
  );
}

function CostsSection({ value }: { value: Settings['costs'] }) {
  const [form, setForm] = useState({ feeBps: String(value.feeBps), slippageBps: String(value.slippageBps), minFee: String(value.minFee) });
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm({ feeBps: String(value.feeBps), slippageBps: String(value.slippageBps), minFee: String(value.minFee) }), [value]);
  const n = (s: string) => Number(s.replace(',', '.'));
  const save = async () => {
    setBusy(true);
    await mutate(() => put('/settings/costs', { feeBps: n(form.feeBps), slippageBps: n(form.slippageBps), minFee: n(form.minFee) }), 'Coûts enregistrés');
    setBusy(false);
  };
  return (
    <Section title="Coûts simulés">
      <Card className="stack">
        <Field label="Frais par ordre (points de base)" hint="10 pb = 0,10 %.">
          {(id) => <input id={id} className="input num" inputMode="decimal" value={form.feeBps} onChange={(e) => setForm({ ...form, feeBps: e.target.value })} />}
        </Field>
        <Field label="Glissement (points de base)">
          {(id) => <input id={id} className="input num" inputMode="decimal" value={form.slippageBps} onChange={(e) => setForm({ ...form, slippageBps: e.target.value })} />}
        </Field>
        <Field label="Frais minimum ($)">
          {(id) => <input id={id} className="input num" inputMode="decimal" value={form.minFee} onChange={(e) => setForm({ ...form, minFee: e.target.value })} />}
        </Field>
        <Button variant="primary" loading={busy} onClick={save}>
          Enregistrer
        </Button>
      </Card>
    </Section>
  );
}

function ScheduleSection({ value }: { value: Settings['schedule'] }) {
  return (
    <Section title="Automatisation">
      <Card className="stack">
        <Toggle
          checked={value.analysisEnabled}
          onChange={(v) => void mutate(() => put('/settings/schedule', { analysisEnabled: v }), v ? 'Analyses planifiées activées' : 'Analyses planifiées suspendues')}
          label="Analyses planifiées"
          hint="Une fois par jour sur la liste de suivi. La surveillance des stops tourne toujours, toutes les 15 minutes."
        />
      </Card>
    </Section>
  );
}
