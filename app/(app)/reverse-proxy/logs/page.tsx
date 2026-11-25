'use client';

import { Suspense, useCallback, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, History, ScrollText } from 'lucide-react';
import { SkeletonRows } from '@/components/Skeleton';
import { useT } from '@/lib/i18n/react';
import RunsView from './RunsView';
import HaproxyLogView from './HaproxyLogView';
import '../../../logs.css';

/**
 * Reverse-Proxy → Logs: zwei Quellen, zwei Reiter.
 *
 * „Vorgänge" ist, was HAPM an der Konfiguration geändert hat
 * (`haproxy_runs`). „HAProxy-Log" ist, was HAProxy selbst schreibt: jede
 * Anfrage und jede Meldung des Prozesses, aus der Datei des Mitschnitts
 * (`lib/haproxy-log.ts`). Getrennt, weil das eine eine Historie mit Schritten
 * ist und das andere ein Strom von tausenden Zeilen am Tag.
 *
 * Der Reiter steht in der Adresse (`?ansicht=haproxy`), damit sich ein Link
 * direkt auf das Log setzen lässt.
 */

type View = 'runs' | 'haproxy';

export default function ReverseProxyLogsPage() {
  // `useSearchParams` verlangt eine Suspense-Grenze, sonst scheitert der Build.
  return (
    <Suspense fallback={<SkeletonRows />}>
      <LogsPage />
    </Suspense>
  );
}

function LogsPage() {
  const { t } = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [view, setView] = useState<View>(() =>
    searchParams.get('ansicht') === 'haproxy' ? 'haproxy' : 'runs'
  );

  const select = useCallback(
    (next: View) => {
      setView(next);
      router.replace(next === 'haproxy' ? '?ansicht=haproxy' : '/reverse-proxy/logs', { scroll: false });
    },
    [router]
  );

  return (
    <>
      <div className="page-header">
        <div>
          <Link
            href="/reverse-proxy"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8125rem' }}
          >
            <ArrowLeft size={14} />
            {t('Reverse-Proxy')}
          </Link>
          <h1 className="page-title">{t('Reverse-Proxy-Protokolle')}</h1>
          <p className="page-subtitle">
            {view === 'runs'
              ? t(
                  'Jeder Vorgang mit seinen Schritten: angelegt, geändert, gelöscht. Domains und Ziele stehen mit in der Zeile, damit auch ein entferntes Ziel noch lesbar ist.'
                )
              : t(
                  'Was HAProxy selbst schreibt: jede Anfrage und jede Meldung des Prozesses, die neueste oben.'
                )}
          </p>
        </div>
      </div>

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'runs'}
          className={`tab ${view === 'runs' ? 'active' : ''}`}
          onClick={() => select('runs')}
        >
          <History size={15} />
          {t('Vorgänge')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'haproxy'}
          className={`tab ${view === 'haproxy' ? 'active' : ''}`}
          onClick={() => select('haproxy')}
        >
          <ScrollText size={15} />
          {t('HAProxy-Log')}
        </button>
      </div>

      {view === 'runs' ? <RunsView /> : <HaproxyLogView />}
    </>
  );
}
