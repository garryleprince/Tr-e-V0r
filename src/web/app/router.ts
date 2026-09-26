import { useSyncExternalStore } from 'react';

/**
 * Hash router. A hash keeps every route servable by the static assets binding
 * and works offline from the service worker's shell.
 */

export type Route =
  | { name: 'home' }
  | { name: 'market' }
  | { name: 'asset'; id: string }
  | { name: 'ai' }
  | { name: 'run'; id: string }
  | { name: 'portfolio' }
  | { name: 'more' }
  | { name: 'journal' }
  | { name: 'activity' }
  | { name: 'settings' }
  | { name: 'risk' }
  | { name: 'security' }
  | { name: 'backtest' }
  | { name: 'about' };

export type Tab = 'home' | 'market' | 'ai' | 'portfolio' | 'more';

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [head, arg] = parts;
  switch (head) {
    case undefined:
      return { name: 'home' };
    case 'market':
      return { name: 'market' };
    case 'asset':
      return arg ? { name: 'asset', id: arg } : { name: 'market' };
    case 'ai':
      return { name: 'ai' };
    case 'run':
      return arg ? { name: 'run', id: arg } : { name: 'ai' };
    case 'portfolio':
    case 'more':
    case 'journal':
    case 'activity':
    case 'settings':
    case 'risk':
    case 'security':
    case 'backtest':
    case 'about':
      return { name: head };
    default:
      return { name: 'home' };
  }
}

export function href(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'asset':
      return `#/asset/${encodeURIComponent(route.id)}`;
    case 'run':
      return `#/run/${encodeURIComponent(route.id)}`;
    default:
      return `#/${route.name}`;
  }
}

export function navigate(route: Route): void {
  const next = href(route);
  if (window.location.hash !== next) window.location.hash = next;
}

export function tabOf(route: Route): Tab {
  switch (route.name) {
    case 'home':
      return 'home';
    case 'market':
    case 'asset':
      return 'market';
    case 'ai':
    case 'run':
      return 'ai';
    case 'portfolio':
      return 'portfolio';
    default:
      return 'more';
  }
}

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}
