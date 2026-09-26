import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, get } from './api';
import { useApp } from './store';

export interface ApiState<T> {
  readonly data: T | null;
  readonly error: string | null;
  /** true only for the first load; refreshes keep the previous data on screen. */
  readonly loading: boolean;
  readonly refreshing: boolean;
  reload(): void;
}

/**
 * GET with the conventions every screen needs: previous data stays visible
 * while refreshing, the request is aborted on unmount, and any mutation
 * (`useApp.bump`) triggers a refetch. `refreshMs` polls only while the page is
 * visible — a hidden PWA does not keep hitting the API.
 */
export function useApi<T>(path: string | null, opts: { refreshMs?: number } = {}): ApiState<T> {
  const revision = useApp((s) => s.revision);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const samePath = lastPath.current === path;
    lastPath.current = path;
    if (!samePath) {
      setData(null);
      setLoading(true);
    } else {
      setRefreshing(true);
    }
    get<T>(path, controller.signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => {
        const text = errorText(err);
        if (text) setError(text);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => controller.abort();
  }, [path, revision, tick]);

  useEffect(() => {
    if (!opts.refreshMs || path === null) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    }, opts.refreshMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') setTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [opts.refreshMs, path]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, refreshing, reload };
}
