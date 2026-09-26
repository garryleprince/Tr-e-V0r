import { useState } from 'react';
import { ACTION_LABELS, DECISION_STATUS_LABELS, MODE_LABELS, TRADING_STATE_LABELS } from '@core/labels';
import { ApiError, errorText, mutate, post } from '../app/api';
import { ago, arrow, dateTime, dirClass, pct, price, symbolOf } from '../app/format';
import { href } from '../app/router';
import { useApp } from '../app/store';
import type { AppEvent, DecisionSummary, DeskView, Mode, TradingState, WatchItem } from '../app/types';
import { IconAlert, IconBell, IconHand, IconInfo, IconLock, IconPlay, IconPower } from './icons';
import { Button, Card, Field, ListRow, Notice, Pill, Segmented, Sheet, type Tone } from './primitives';
import { Sparkline } from './Sparkline';

// --------------------------------------------------------------- decisions

export function statusTone(status: DecisionSummary['status']): Tone {
  switch (status) {
    case 'EXECUTED':
      return 'good';
    case 'APPROVED':
    case 'RESIZED':
      return 'accent';
    case 'REJECTED':
      return 'warn';
    case 'INVALID':
      return 'bad';
    default:
      return 'neutral';
  }
}

export function ActionTag({ action }: { action: DecisionSummary['action'] }) {
  if (!action) return <Pill tone="bad">Aucune</Pill>;
  const tone: Tone = action === 'BUY' ? 'up' : action === 'SELL' ? 'down' : 'neutral';
  const glyph = action === 'BUY' ? '▲' : action === 'SELL' ? '▼' : '■';
  return (
    <Pill tone={tone}>
      <span aria-hidden="true">{glyph}</span> {ACTION_LABELS[action]}
    </Pill>
  );
}

export function SourceTag({ source }: { source: DecisionSummary['source'] }) {
  return source === 'llm' ? <Pill tone="accent">IA</Pill> : <Pill>Règles, sans IA</Pill>;
}

export function DecisionRow({ d }: { d: DecisionSummary }) {
  return (
    <ListRow
      href={href({ name: 'run', id: d.runId })}
      icon={<span className="asset-glyph">{symbolOf(d.instrumentId).slice(0, 4)}</span>}
      title={
        <span className="row wrap">
          <ActionTag action={d.action} />
          <Pill tone={statusTone(d.status)}>{DECISION_STATUS_LABELS[d.status]}</Pill>
        </span>
      }
      subtitle={
        <span className="num">
          {symbolOf(d.instrumentId)} · {d.confidence !== null ? `confiance ${pct(d.confidence, { digits: 0 })}` : 'sans proposition'} · {ago(d.createdAt)}
        </span>
      }
    />
  );
}

/** The latest decision, large: what, why, and what the Risk Engine said. */
export function DecisionCard({ d }: { d: DecisionSummary }) {
  const p = d.proposal;
  const rr = d.entryPrice && d.stopLoss && d.takeProfit && d.entryPrice > d.stopLoss ? (d.takeProfit - d.entryPrice) / (d.entryPrice - d.stopLoss) : null;
  return (
    <a className="card card-link decision-card" href={href({ name: 'run', id: d.runId })}>
      <div className="row-between">
        <div className="row wrap">
          <ActionTag action={d.action} />
          <span className="decision-asset">{symbolOf(d.instrumentId)}</span>
        </div>
        <Pill tone={statusTone(d.status)}>{DECISION_STATUS_LABELS[d.status]}</Pill>
      </div>
      {p ? <p className="decision-rationale">{p.mainScenario.title} — {p.rationale}</p> : null}
      {d.invalidReasons.length > 0 ? <p className="small bad">{d.invalidReasons.join(' · ')}</p> : null}
      {d.action === 'BUY' || d.action === 'SELL' ? (
        <div className="kv-grid num">
          <span className="dim">Entrée</span>
          <span>{price(d.entryPrice)}</span>
          <span className="dim">Stop</span>
          <span>{price(d.stopLoss)}</span>
          <span className="dim">Objectif</span>
          <span>{price(d.takeProfit)}</span>
          <span className="dim">Gain/risque</span>
          <span>{rr !== null ? rr.toFixed(2).replace('.', ',') : '—'}</span>
        </div>
      ) : null}
      {d.verdict ? <p className="small muted">Risque : {d.verdict.summary}</p> : null}
      <div className="row wrap small dim">
        <SourceTag source={d.source} />
        <span className="num">confiance {pct(d.confidence, { digits: 0 })}</span>
        <span>·</span>
        <span>{dateTime(d.createdAt)}</span>
      </div>
    </a>
  );
}

// ----------------------------------------------------------------- market

export function WatchRow({ w }: { w: WatchItem }) {
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
      title={
        <span className="row">
          <span>{symbolOf(w.instrumentId)}</span>
          <span className="dim small truncate">{w.instrument.displayName}</span>
        </span>
      }
      subtitle={<span className="num">{w.last !== null ? price(w.last, w.instrument.quoteCurrency) : '—'}</span>}
      trailing={
        <span className="watch-trailing">
          <Sparkline values={w.sparkline} />
          <span className={`num change ${dirClass(w.change1)}`}>
            {arrow(w.change1)} {pct(w.change1, { sign: true })}
          </span>
        </span>
      }
    />
  );
}

// ------------------------------------------------------------------ events

export function EventRow({ e, onAck }: { e: AppEvent; onAck?: (id: string) => void }) {
  const icon = e.severity === 'info' ? <IconInfo size={18} /> : <IconAlert size={18} />;
  return (
    <div className={`event-row sev-${e.severity}`}>
      <span className="event-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="grow">
        <div className="event-title">
          <span className="sr-only">{e.severity === 'critical' ? 'Critique : ' : e.severity === 'warning' ? 'Alerte : ' : ''}</span>
          {e.title}
        </div>
        <div className="micro dim">
          {dateTime(e.ts)} · {e.actor === 'user' ? 'vous' : e.actor === 'system' ? 'système' : e.actor}
        </div>
      </div>
      {onAck && e.severity !== 'info' && e.acknowledgedAt === null ? (
        <Button size="sm" variant="ghost" onClick={() => onAck(e.id)}>
          Vu
        </Button>
      ) : null}
    </div>
  );
}

export function EventsEmpty() {
  return (
    <div className="empty small">
      <div className="empty-icon">
        <IconBell />
      </div>
      <div className="empty-text">Aucun événement pour l’instant.</div>
    </div>
  );
}

// ------------------------------------------------------------- kill switch

/**
 * Kill switch. Braking is always one confirmation away and never needs the
 * password; resuming does (server-enforced).
 */
export function KillSwitch({ desk }: { desk: DeskView }) {
  const [target, setTarget] = useState<TradingState | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const s = desk.effectiveState;

  const open = (next: TradingState) => {
    setTarget(next);
    setReason(next === 'HALTED' ? 'Arrêt manuel depuis l’application' : next === 'REDUCING' ? 'Réduction manuelle de l’exposition' : 'Reprise manuelle');
  };

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    const r = await mutate(
      () => post('/desk/kill-switch', { state: target, reason: reason.trim() || 'Action manuelle' }, 'Reprendre le trading automatique exige votre mot de passe.'),
      `État : ${TRADING_STATE_LABELS[target]}`,
    );
    setBusy(false);
    if (r) setTarget(null);
  };

  return (
    <Card tone={s === 'HALTED' ? 'bad' : s === 'REDUCING' ? 'warn' : undefined} className="killswitch">
      <div className="row-between">
        <div className="row">
          <span className={`ks-dot ks-${s}`} aria-hidden="true" />
          <div>
            <div className="eyebrow">Coupe-circuit</div>
            <div className="ks-state">{TRADING_STATE_LABELS[s]}</div>
          </div>
        </div>
        <span className="micro dim">{ago(desk.updatedAt)}</span>
      </div>
      <p className="small muted">
        {s === 'ACTIVE'
          ? 'L’IA peut proposer des ouvertures et des réductions, toujours soumises au Risk Engine.'
          : s === 'REDUCING'
            ? 'L’IA ne peut plus que réduire l’exposition. Les stops restent actifs.'
            : 'Aucun ordre IA. Les stops de protection et vos clôtures manuelles restent actifs.'}
        {desk.reason ? ` Motif : ${desk.reason}` : ''}
      </p>
      {desk.forcedByDeployment ? (
        <Notice tone="bad" title="Arrêt imposé par le déploiement">
          La variable KILL_SWITCH du Worker force l’arrêt. Il ne peut être levé que depuis la configuration Cloudflare.
        </Notice>
      ) : (
        <div className="row wrap">
          {s !== 'HALTED' ? (
            <Button variant="danger" icon={<IconPower size={18} />} onClick={() => open('HALTED')}>
              Arrêt d’urgence
            </Button>
          ) : null}
          {s === 'ACTIVE' ? (
            <Button icon={<IconHand size={18} />} onClick={() => open('REDUCING')}>
              Réduction seule
            </Button>
          ) : null}
          {s !== 'ACTIVE' ? (
            <Button icon={<IconPlay size={16} />} onClick={() => open('ACTIVE')}>
              Reprendre
            </Button>
          ) : null}
        </div>
      )}
      <Sheet open={target !== null} onClose={() => setTarget(null)} title={target === 'HALTED' ? 'Arrêt d’urgence' : target === 'REDUCING' ? 'Réduction seule' : 'Reprendre'}>
        <div className="stack">
          <p className="small muted">
            {target === 'HALTED'
              ? 'Plus aucun ordre de l’IA ne sera accepté. Les positions ouvertes gardent leurs stops.'
              : target === 'REDUCING'
                ? 'L’IA ne pourra plus ouvrir ni renforcer de position.'
                : 'L’IA pourra de nouveau proposer des ouvertures. Votre mot de passe sera demandé.'}
          </p>
          <Field label="Motif (journalisé)">
            {(id) => <input id={id} className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <Button variant={target === 'HALTED' ? 'danger' : 'primary'} size="lg" loading={busy} onClick={confirm}>
            Confirmer
          </Button>
        </div>
      </Sheet>
    </Card>
  );
}

// --------------------------------------------------------------------- mode

const MODE_HELP: Record<Mode, string> = {
  RESEARCH: 'L’IA analyse et propose ; le Risk Engine juge ; rien n’est exécuté, même en simulation.',
  PAPER: 'Les décisions approuvées sont exécutées sur un compte simulé (frais et glissement inclus).',
  LIVE: 'Ordres réels. Indisponible en V0.1.',
};

/**
 * Autonomy level. LIVE is visibly locked; tapping it asks the server, whose
 * refusal (and its list of conditions) is shown as is.
 */
export function ModeControl({ desk }: { desk: DeskView }) {
  const [pending, setPending] = useState<Mode | null>(null);
  const [liveInfo, setLiveInfo] = useState<{ message: string; conditions: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);

  const choose = async (m: Mode) => {
    if (m === desk.mode) return;
    if (m === 'LIVE') {
      try {
        await post('/desk/mode', { mode: 'LIVE' });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'LIVE_NOT_AVAILABLE') {
          const conditions = Array.isArray(err.details) ? [] : ((err.details as { conditions?: string[] } | undefined)?.conditions ?? []);
          setLiveInfo({ message: err.message, conditions });
        } else {
          const text = errorText(err);
          if (text) toast('error', text);
        }
      }
      return;
    }
    setPending(m);
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    const r = await mutate(() => post('/desk/mode', { mode: pending }, 'Changer de mode exige votre mot de passe.'), `Mode : ${MODE_LABELS[pending]}`);
    setBusy(false);
    if (r) setPending(null);
  };

  return (
    <div className="stack">
      <Segmented<Mode>
        label="Mode d’autonomie"
        value={desk.mode}
        onChange={choose}
        options={[
          { value: 'RESEARCH', label: 'Recherche' },
          { value: 'PAPER', label: 'Simulation' },
          {
            value: 'LIVE',
            label: (
              <span className="row" style={{ justifyContent: 'center', gap: 4 }}>
                <IconLock size={14} /> Réel
              </span>
            ),
            ariaLabel: desk.liveAvailable ? 'Réel' : 'Réel, verrouillé',
            title: desk.liveAvailable ? undefined : 'Verrouillé en V0.1 : touchez pour voir les conditions',
          },
        ]}
      />
      <p className="small muted">{MODE_HELP[desk.mode]}</p>
      <Sheet open={pending !== null} onClose={() => setPending(null)} title={`Passer en ${pending ? MODE_LABELS[pending] : ''}`}>
        <div className="stack">
          <p className="small muted">{pending ? MODE_HELP[pending] : ''}</p>
          <p className="small muted">Le changement est journalisé. Votre mot de passe sera demandé si la dernière vérification date de plus de 10 minutes.</p>
          <Button variant="primary" size="lg" loading={busy} onClick={confirm}>
            Confirmer
          </Button>
        </div>
      </Sheet>
      <Sheet open={liveInfo !== null} onClose={() => setLiveInfo(null)} title="Mode réel verrouillé">
        <div className="stack">
          <Notice tone="warn" title="Refusé par le serveur">
            {liveInfo?.message}
          </Notice>
          {liveInfo && liveInfo.conditions.length > 0 ? (
            <>
              <p className="small muted">Conditions requises, toutes cumulatives :</p>
              <ul className="plain-list small">
                {liveInfo.conditions.map((c) => (
                  <li key={c}>
                    <IconLock size={14} /> {c}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}
