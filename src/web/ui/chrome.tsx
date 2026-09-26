import { useState, type FormEvent } from 'react';
import { MODE_LABELS, TRADING_STATE_LABELS } from '@core/labels';
import { ApiError, post } from '../app/api';
import { href, type Tab } from '../app/router';
import { useApp } from '../app/store';
import type { DeskView } from '../app/types';
import { IconAi, IconCheck, IconHome, IconMarket, IconMore, IconWallet, IconX } from './icons';
import { Button, Field, Pill, Sheet } from './primitives';

// ----------------------------------------------------------------- tab bar

const TABS: readonly { tab: Tab; label: string; href: string; icon: typeof IconHome }[] = [
  { tab: 'home', label: 'Accueil', href: href({ name: 'home' }), icon: IconHome },
  { tab: 'market', label: 'Marché', href: href({ name: 'market' }), icon: IconMarket },
  { tab: 'ai', label: 'IA', href: href({ name: 'ai' }), icon: IconAi },
  { tab: 'portfolio', label: 'Portefeuille', href: href({ name: 'portfolio' }), icon: IconWallet },
  { tab: 'more', label: 'Plus', href: href({ name: 'more' }), icon: IconMore },
];

export function TabBar({ active, badge }: { active: Tab; badge?: number }) {
  return (
    <nav className="tabbar" aria-label="Navigation principale">
      {TABS.map(({ tab, label, href: to, icon: Icon }) => (
        <a key={tab} href={to} className={`tab ${active === tab ? 'on' : ''}`} aria-current={active === tab ? 'page' : undefined}>
          <span className="tab-icon">
            <Icon size={24} />
            {tab === 'more' && badge ? <span className="tab-badge" aria-label={`${badge} alertes`} /> : null}
          </span>
          <span className="tab-label">{label}</span>
        </a>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------- status badges

export function ModeBadge({ desk }: { desk: DeskView }) {
  const tone = desk.mode === 'LIVE' ? 'bad' : desk.mode === 'PAPER' ? 'accent' : 'neutral';
  return (
    <Pill tone={tone}>
      <span className="dot" aria-hidden="true" />
      {MODE_LABELS[desk.mode]}
    </Pill>
  );
}

export function StateBadge({ desk }: { desk: DeskView }) {
  const s = desk.effectiveState;
  const tone = s === 'ACTIVE' ? 'good' : s === 'REDUCING' ? 'warn' : 'bad';
  return (
    <Pill tone={tone} icon={s === 'ACTIVE' ? <IconCheck size={14} /> : <IconX size={14} />}>
      {TRADING_STATE_LABELS[s]}
    </Pill>
  );
}

// ------------------------------------------------------------------ toasts

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.kind === 'error' ? <IconX size={16} /> : <IconCheck size={16} />}
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- step-up

/**
 * Re-authentication prompt, opened by the API client when the server answers
 * STEP_UP_REQUIRED. The password goes straight to /api/auth/step-up and is
 * never kept.
 */
export function StepUpSheet() {
  const stepUp = useApp((s) => s.stepUp);
  const finish = useApp((s) => s.finishStepUp);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setPassword('');
    setError(null);
    finish(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ stepUpUntil: number }>('/auth/step-up', { password });
      setPassword('');
      finish(true, r.stepUpUntil);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Échec de la vérification');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={stepUp !== null} onClose={close} title="Confirmez votre identité">
      <form className="stack" onSubmit={submit}>
        <p className="muted small">{stepUp?.reason}</p>
        <p className="muted small">Cette action sensible exige votre mot de passe. L’autorisation dure 10 minutes.</p>
        <Field label="Mot de passe" error={error}>
          {(id) => (
            <input
              id={id}
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={password.length === 0}>
          Confirmer
        </Button>
      </form>
    </Sheet>
  );
}
