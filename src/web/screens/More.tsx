import { useState } from 'react';
import { mutate, post, refreshAuth } from '../app/api';
import { ago, dateTime } from '../app/format';
import { href } from '../app/router';
import { useApp } from '../app/store';
import type { Dashboard, SessionRow, SystemInfo } from '../app/types';
import { useApi } from '../app/useApi';
import { IconBell, IconBook, IconFlask, IconGauge, IconGear, IconInfo, IconLayers, IconLock, IconLogout, IconShield } from '../ui/icons';
import { Button, Card, ErrorBlock, ListRow, LoadingBlock, Notice, Pill, Screen, Section, Sheet } from '../ui/primitives';

export function MoreScreen() {
  const email = useApp((s) => s.auth?.user?.email);
  const dash = useApi<Dashboard>('/dashboard');
  const unread = dash.data?.unreadAlerts ?? 0;
  const logout = async () => {
    await mutate(() => post('/auth/logout'));
    await refreshAuth().catch(() => undefined);
  };
  return (
    <Screen title="Plus" eyebrow={email}>
      <div className="list card-list">
        <ListRow href={href({ name: 'journal' })} icon={<IconBook />} title="Journal des décisions" subtitle="Chaque décision, son verdict et ses données" />
        <ListRow
          href={href({ name: 'activity' })}
          icon={<IconBell />}
          title="Activité"
          subtitle="Journal d’audit et alertes"
          trailing={unread > 0 ? <Pill tone="warn">{unread}</Pill> : undefined}
        />
        <ListRow href={href({ name: 'risk' })} icon={<IconGauge />} title="Risque et contrôle" subtitle="Mode, coupe-circuit, limites" />
        <ListRow href={href({ name: 'backtest' })} icon={<IconFlask />} title="Backtest" subtitle="Architecture en place, interface en V0.3" />
      </div>
      <div className="list card-list">
        <ListRow href={href({ name: 'settings' })} icon={<IconGear />} title="Réglages" subtitle="Liste de suivi, IA, coûts, apparence" />
        <ListRow href={href({ name: 'security' })} icon={<IconShield />} title="Sécurité" subtitle="Sessions, secrets, état du système" />
        <ListRow href={href({ name: 'about' })} icon={<IconInfo />} title="À propos" subtitle="Version, licences, avertissements" />
      </div>
      <Button variant="ghost" icon={<IconLogout size={18} />} onClick={logout}>
        Se déconnecter
      </Button>
    </Screen>
  );
}

export function SecurityScreen() {
  const sessions = useApi<SessionRow[]>('/auth/sessions');
  const system = useApi<SystemInfo>('/system');
  const [confirm, setConfirm] = useState(false);
  const logoutAll = async () => {
    await mutate(() => post('/auth/logout-all'), 'Toutes les sessions ont été fermées');
    setConfirm(false);
    await refreshAuth().catch(() => undefined);
  };
  const s = system.data;
  return (
    <Screen title="Sécurité" back={{ href: href({ name: 'more' }), label: 'Plus' }}>
      <Section title="Dispositifs en place">
        <Card>
          <ul className="posture">
            <PostureItem ok title="Clés API côté serveur uniquement" text="Secrets du Worker Cloudflare ; jamais envoyés à cette page ni stockés dans le navigateur." />
            <PostureItem ok title="Session HttpOnly, SameSite=Strict" text="Cookie illisible par le JavaScript de la page ; seule son empreinte SHA-256 est stockée." />
            <PostureItem ok title="Ré-authentification pour les actions sensibles" text="Changer de mode, desserrer une limite, reprendre après un arrêt, réinitialiser." />
            <PostureItem ok title="Verrouillage après 5 échecs" text="Et limitation des tentatives par adresse IP." />
            <PostureItem ok title="Coupe-circuit à deux niveaux" text="Dans l’application, et KILL_SWITCH au niveau du déploiement." />
            <PostureItem
              ok={s ? !s.liveTradingEnabled : true}
              title="Trading réel désactivé"
              text="Aucun adaptateur de courtier dans cette version : aucune clé de trading ni droit de retrait n’existe."
            />
          </ul>
        </Card>
      </Section>

      <Section title="Sessions actives" action={<Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>Tout fermer</Button>}>
        {sessions.loading ? (
          <LoadingBlock lines={2} />
        ) : sessions.error ? (
          <ErrorBlock message={sessions.error} onRetry={sessions.reload} />
        ) : (
          <div className="card card-list">
            {(sessions.data ?? []).map((x) => (
              <div key={x.id} className="list-row">
                <span className="grow list-main">
                  <span className="list-title truncate">{describeAgent(x.userAgent)}</span>
                  <span className="list-sub">
                    Active {ago(x.lastSeenAt)} · créée le {dateTime(x.createdAt)} · expire le {dateTime(x.expiresAt)}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="État du système">
        {system.loading ? (
          <LoadingBlock lines={4} />
        ) : system.error || !s ? (
          <ErrorBlock message={system.error ?? 'Indisponible'} onRetry={system.reload} />
        ) : (
          <Card className="stack">
            <div className="kv-grid small">
              <span className="dim">Version</span>
              <span>{s.version}</span>
              <span className="dim">Environnement</span>
              <span>{s.environment}</span>
              <span className="dim">Données de marché</span>
              <span>{s.dataMode === 'fixture' ? 'démonstration (enregistrées)' : 'en direct'}</span>
              <span className="dim">Sources de marché</span>
              <span>Coinbase · Yahoo Finance (non officiel) · BCE</span>
              <span className="dim">Alpha Vantage (secours)</span>
              <span className="num">
                {s.providers.alphaVantageKey
                  ? `clé configurée · ${s.providers.alphaVantageCallsToday} / ${s.providers.alphaVantageDailyLimit} appels aujourd’hui`
                  : 'facultatif, non configuré'}
              </span>
              <span className="dim">Modèle d’IA</span>
              <span>{s.llm.available ? s.llm.deepModel : 'non connecté'}</span>
              <span className="dim">Arrêt imposé</span>
              <span>{s.killSwitchForced ? 'oui (KILL_SWITCH)' : 'non'}</span>
            </div>
            <div className="eyebrow">Tâches planifiées</div>
            {s.jobs.length === 0 ? (
              <p className="small muted">Aucune exécution enregistrée. En local, les tâches se déclenchent via wrangler (voir docs/DEPLOIEMENT.md).</p>
            ) : (
              <ul className="plain-list small">
                {s.jobs.map((j) => (
                  <li key={j.name}>
                    <Pill tone={j.lastStatus === 'ok' ? 'good' : 'bad'}>{j.lastStatus === 'ok' ? 'OK' : 'Erreur'}</Pill> {j.name === 'analysis' ? 'Analyses' : j.name === 'monitor' ? 'Surveillance' : j.name} ·{' '}
                    {ago(j.lastRunAt)}
                    {j.detail ? <span className="micro dim"> · {j.detail}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </Section>

      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Fermer toutes les sessions">
        <div className="stack">
          <p className="small muted">Tous les appareils, y compris celui-ci, devront se reconnecter.</p>
          <Button variant="danger" size="lg" onClick={logoutAll} icon={<IconLock size={18} />}>
            Fermer toutes les sessions
          </Button>
        </div>
      </Sheet>
    </Screen>
  );
}

function PostureItem({ ok, title, text }: { ok: boolean; title: string; text: string }) {
  return (
    <li className={ok ? 'ok' : 'fail'}>
      <IconShield size={18} />
      <span>
        <strong>{title}</strong>
        <span className="small muted"> — {text}</span>
      </span>
    </li>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Appareil inconnu';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return ua.slice(0, 40);
}

export function BacktestScreen() {
  return (
    <Screen title="Backtest" back={{ href: href({ name: 'more' }), label: 'Plus' }}>
      <Notice tone="info" title="Interface prévue en V0.3">
        Le moteur existe et est couvert par des tests automatisés, mais aucun écran ne permet encore de lancer un backtest. Aucun résultat n’est affiché ici tant
        qu’il n’a pas été réellement calculé.
      </Notice>
      <Section title="Ce qui est déjà en place">
        <Card>
          <ul className="posture">
            <PostureItem ok title="Moteur événementiel" text="Même simulateur d’exécution que le mode Simulation : frais, glissement, stop avant objectif si les deux sont touchés." />
            <PostureItem ok title="Pas de biais d’anticipation" text="Décision à la clôture d’une bougie, exécution à l’ouverture suivante ; seules les bougies clôturées sont visibles." />
            <PostureItem ok title="Segments TRAIN / VALIDATION / TEST / HORS ÉCHANTILLON" text="Avec embargo entre segments ; le test final ne sert qu’une fois." />
            <PostureItem ok title="Métriques" text="Rendement, CAGR, volatilité, Sharpe, Sortino, drawdown et durée, Calmar, taux de réussite, facteur de profit, espérance." />
          </ul>
        </Card>
      </Section>
      <Section title="À venir">
        <Card>
          <ul className="plain-list small">
            <li>
              <IconLayers size={14} /> V0.3 : lancer un backtest depuis l’app, comparer des stratégies, courbe et drawdown par segment.
            </li>
            <li>
              <IconLayers size={14} /> Rejeu des décisions de l’IA sur l’historique, avec coût IA estimé avant lancement.
            </li>
          </ul>
        </Card>
      </Section>
    </Screen>
  );
}

export function AboutScreen() {
  return (
    <Screen title="À propos" back={{ href: href({ name: 'more' }), label: 'Plus' }}>
      <Card className="stack">
        <div className="row">
          <img src="/icons/icon.svg" alt="" width={48} height={48} className="about-logo" />
          <div>
            <div className="report-name">Tr-e-V0r</div>
            <div className="small muted">Version 0.1 · simulation uniquement</div>
          </div>
        </div>
        <p className="small">
          Bureau de trading assisté par IA : des agents analysent, un trader propose, un gestionnaire de portefeuille dimensionne, et un Risk Engine indépendant
          décide. Aucune décision d’un modèle ne peut contourner le Risk Engine.
        </p>
      </Card>
      <Notice tone="warn" title="Avertissement">
        Outil expérimental, sans garantie. Rien ici n’est un conseil en investissement. Les performances simulées ne préjugent pas des résultats réels.
      </Notice>
      <Section title="Logiciels tiers">
        <Card>
          <ul className="plain-list small">
            <li>
              Graphiques :{' '}
              <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer noopener">
                TradingView Lightweight Charts™
              </a>{' '}
              — Apache-2.0, © TradingView, Inc.
            </li>
            <li>React, React DOM — MIT</li>
            <li>Hono — MIT</li>
            <li>Zod — MIT</li>
            <li>Zustand — MIT</li>
            <li>SDK Anthropic TypeScript — MIT</li>
          </ul>
          <div className="eyebrow" style={{ marginTop: 12 }}>
            Données
          </div>
          <ul className="plain-list small">
            <li>Taux de change : Source BCE (taux de référence de l’euro)</li>
            <li>Crypto : Coinbase, Kraken</li>
            <li>Actions : Yahoo Finance — source non officielle, sans garantie de disponibilité</li>
          </ul>
          <p className="micro dim" style={{ marginTop: 8 }}>
            Détail dans THIRD_PARTY_NOTICES.md. L’architecture s’inspire de TradingAgents, Qlib, NautilusTrader, FinRL et Hummingbot/Condor (concepts étudiés,
            aucun code copié ; voir docs/audit/).
          </p>
        </Card>
      </Section>
    </Screen>
  );
}
