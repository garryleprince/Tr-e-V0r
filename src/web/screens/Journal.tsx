import { useEffect, useState } from 'react';
import { errorText, get, mutate, post } from '../app/api';
import { useApp } from '../app/store';
import type { AppEvent, DecisionSummary } from '../app/types';
import { DecisionRow, EventRow, EventsEmpty } from '../ui/domain';
import { IconBook } from '../ui/icons';
import { Button, Empty, ErrorBlock, LoadingBlock, Screen, Segmented } from '../ui/primitives';
import { href } from '../app/router';

/**
 * Cursor pagination over a list ordered newest first: `before` is the time of
 * the last loaded item.
 */
function usePaged<T>(base: string, timeOf: (x: T) => number) {
  const revision = useApp((s) => s.revision);
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const PAGE = 30;
  const sep = base.includes('?') ? '&' : '?';

  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    get<T[]>(`${base}${sep}limit=${PAGE}`, c.signal)
      .then((rows) => {
        setItems(rows);
        setDone(rows.length < PAGE);
        setError(null);
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => !c.signal.aborted && setLoading(false));
    return () => c.abort();
  }, [base, sep, revision]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last) return;
    setMore(true);
    try {
      const rows = await get<T[]>(`${base}${sep}limit=${PAGE}&before=${timeOf(last)}`);
      setItems((xs) => [...xs, ...rows]);
      setDone(rows.length < PAGE);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setMore(false);
    }
  };
  return { items, loading, more, error, done, loadMore };
}

type DecisionFilter = 'all' | 'EXECUTED' | 'REJECTED' | 'INVALID';

export function JournalScreen() {
  const [filter, setFilter] = useState<DecisionFilter>('all');
  const base = filter === 'all' ? '/decisions' : `/decisions?status=${filter}`;
  const { items, loading, more, error, done, loadMore } = usePaged<DecisionSummary>(base, (d) => d.createdAt);
  return (
    <Screen title="Journal des décisions" back={{ href: href({ name: 'more' }), label: 'Plus' }}>
      <Segmented<DecisionFilter>
        label="Filtrer"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'Toutes' },
          { value: 'EXECUTED', label: 'Exécutées' },
          { value: 'REJECTED', label: 'Refusées' },
          { value: 'INVALID', label: 'Invalides' },
        ]}
      />
      {loading ? (
        <LoadingBlock lines={6} />
      ) : error && items.length === 0 ? (
        <ErrorBlock message={error} />
      ) : items.length === 0 ? (
        <Empty icon={<IconBook />} title="Aucune décision">
          Chaque analyse laisse ici sa décision, le verdict du risque et le lien vers les données et rapports utilisés.
        </Empty>
      ) : (
        <>
          <div className="list card-list">
            {items.map((d) => (
              <DecisionRow key={d.id} d={d} />
            ))}
          </div>
          {!done ? (
            <Button loading={more} onClick={loadMore}>
              Plus ancien
            </Button>
          ) : null}
        </>
      )}
      <p className="micro dim">Le journal n’est jamais effacé, y compris après une réinitialisation de la simulation.</p>
    </Screen>
  );
}

type Severity = 'all' | 'warning' | 'critical';

export function ActivityScreen() {
  const [sev, setSev] = useState<Severity>('all');
  const base = sev === 'all' ? '/events' : `/events?severity=${sev}`;
  const { items, loading, more, error, done, loadMore } = usePaged<AppEvent>(base, (e) => e.ts);
  const ack = (id: string) => void mutate(() => post(`/events/${encodeURIComponent(id)}/ack`));
  return (
    <Screen title="Activité" back={{ href: href({ name: 'more' }), label: 'Plus' }}>
      <Segmented<Severity>
        label="Gravité"
        value={sev}
        onChange={setSev}
        options={[
          { value: 'all', label: 'Tout' },
          { value: 'warning', label: 'Alertes' },
          { value: 'critical', label: 'Critiques' },
        ]}
      />
      {loading ? (
        <LoadingBlock lines={6} />
      ) : error && items.length === 0 ? (
        <ErrorBlock message={error} />
      ) : items.length === 0 ? (
        <EventsEmpty />
      ) : (
        <>
          <div className="card card-list">
            {items.map((e) => (
              <EventRow key={e.id} e={e} onAck={ack} />
            ))}
          </div>
          {!done ? (
            <Button loading={more} onClick={loadMore}>
              Plus ancien
            </Button>
          ) : null}
        </>
      )}
      <p className="micro dim">Journal d’audit : connexions, changements de mode et de limites, coupe-circuit, ordres simulés, erreurs des tâches planifiées.</p>
    </Screen>
  );
}
