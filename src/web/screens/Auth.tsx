import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, post, refreshAuth } from '../app/api';
import type { AuthStatus } from '../app/types';
import { IconLock, IconShield } from '../ui/icons';
import { Button, Field, Notice } from '../ui/primitives';

function AuthFrame({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <main className="auth" aria-labelledby="auth-title">
      <div className="auth-card">
        <img className="auth-logo" src="/icons/icon.svg" alt="" width={64} height={64} />
        <h1 id="auth-title" className="auth-title">
          {title}
        </h1>
        <p className="auth-sub">{subtitle}</p>
        {children}
      </div>
      <p className="auth-foot micro dim">Tr-e-V0r · V0.1 · simulation uniquement, aucun ordre réel</p>
    </main>
  );
}

export function SetupScreen({ status }: { status: AuthStatus }) {
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && confirm !== password;
  const weak = password.length > 0 && password.length < 12;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch || weak) return;
    setBusy(true);
    setError(null);
    try {
      await post('/auth/setup', { setupToken: token.trim(), email, password });
      await refreshAuth();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Installation impossible');
    } finally {
      setBusy(false);
    }
  };

  if (!status.setupAvailable) {
    return (
      <AuthFrame title="Installation" subtitle="Aucun compte n’existe encore sur ce déploiement.">
        <Notice tone="warn" title="Installation désactivée">
          Le secret <code>SETUP_TOKEN</code> n’est pas configuré sur le Worker. Ajoutez-le avec <code>wrangler secret put SETUP_TOKEN</code>, puis
          rechargez cette page. Voir docs/DEPLOIEMENT.md.
        </Notice>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame title="Créer le compte propriétaire" subtitle="Un seul compte par déploiement. Le jeton d’installation prouve que vous en êtes l’administrateur.">
      <form className="stack" onSubmit={submit}>
        <Field label="Jeton d’installation" hint="La valeur du secret SETUP_TOKEN du Worker.">
          {(id) => <input id={id} className="input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required />}
        </Field>
        <Field label="E-mail">
          {(id) => (
            <input id={id} className="input" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
        </Field>
        <Field label="Mot de passe" hint="12 caractères minimum." error={weak ? 'Au moins 12 caractères.' : null}>
          {(id) => (
            <input id={id} className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          )}
        </Field>
        <Field label="Confirmer le mot de passe" error={mismatch ? 'Les deux mots de passe diffèrent.' : null}>
          {(id) => (
            <input id={id} className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          )}
        </Field>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Button type="submit" variant="primary" size="lg" loading={busy} icon={<IconShield size={18} />}>
          Créer le compte
        </Button>
      </form>
    </AuthFrame>
  );
}

export function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/login', { email, password });
      setPassword('');
      await refreshAuth();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Connexion impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Tr-e-V0r" subtitle="Bureau de trading IA — analyse, simulation, contrôle du risque.">
      <form className="stack" onSubmit={submit}>
        <Field label="E-mail">
          {(id) => (
            <input id={id} className="input" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
        </Field>
        <Field label="Mot de passe">
          {(id) => (
            <input id={id} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          )}
        </Field>
        {error ? <Notice tone="bad">{error}</Notice> : null}
        <Button type="submit" variant="primary" size="lg" loading={busy} icon={<IconLock size={18} />}>
          Se connecter
        </Button>
      </form>
    </AuthFrame>
  );
}
