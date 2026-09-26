import { create } from 'zustand';
import type { AuthStatus } from './types';

/**
 * Client state that is not server data: authentication status, the step-up
 * prompt, toasts, theme, and a revision counter screens use to refetch after
 * a mutation. Server data itself lives in `useApi`, never duplicated here.
 */

export type Theme = 'system' | 'dark' | 'light';

export interface Toast {
  readonly id: number;
  readonly kind: 'info' | 'success' | 'error';
  readonly text: string;
}

interface StepUpRequest {
  readonly reason: string;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

interface AppState {
  auth: AuthStatus | null;
  stepUp: StepUpRequest | null;
  toasts: Toast[];
  theme: Theme;
  revision: number;
  setAuth(auth: AuthStatus | null): void;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  setTheme(theme: Theme): void;
  /** Asks the owner to re-enter the password; resolves once it succeeded. */
  requestStepUp(reason: string): Promise<void>;
  finishStepUp(ok: boolean, stepUpUntil?: number): void;
  bump(): void;
}

const THEME_KEY = 'trevor.theme';
let toastSeq = 0;

function readTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  // The status bar colour follows the forced theme, or each OS appearance under "system".
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => {
    const lightMedia = (meta.getAttribute('media') ?? '').includes('light');
    const light = theme === 'light' || (theme === 'system' && lightMedia);
    meta.setAttribute('content', light ? '#f6f7f9' : '#08090b');
  });
}

export const useApp = create<AppState>((set, get) => ({
  auth: null,
  stepUp: null,
  toasts: [],
  theme: readTheme(),
  revision: 0,
  setAuth: (auth) => set({ auth }),
  toast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-2), { id, kind, text }] }));
    window.setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3500);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setTheme: (theme) => {
    try {
      if (theme === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* storage unavailable: the choice lasts for this visit only */
    }
    applyTheme(theme);
    set({ theme });
  },
  requestStepUp: (reason) =>
    new Promise<void>((resolve, reject) => {
      get().stepUp?.reject(new Error('Remplacée par une autre demande'));
      set({ stepUp: { reason, resolve, reject } });
    }),
  finishStepUp: (ok, stepUpUntil) => {
    const req = get().stepUp;
    const auth = get().auth;
    set({ stepUp: null, ...(ok && auth && stepUpUntil ? { auth: { ...auth, stepUpUntil } } : {}) });
    if (!req) return;
    if (ok) req.resolve();
    else req.reject(new StepUpCancelled());
  },
  bump: () => set((s) => ({ revision: s.revision + 1 })),
}));

export class StepUpCancelled extends Error {
  constructor() {
    super('Ré-authentification annulée');
  }
}
