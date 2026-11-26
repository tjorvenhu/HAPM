'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { Archive, ListChecks, Send } from 'lucide-react';
import ErrorNote from '@/components/ErrorNote';
import AreaTabs, { useArea, type Area } from '@/components/AreaTabs';
import { SkeletonDetail, SkeletonRows } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Nur Typen: die Dateien dahinter erreichen `lib/db`.
import type { AuditOverview, ForwardTestResult } from '@/lib/audit-log/actions';
import type { ForwardDestination } from '@/lib/audit-log/forward';
import EntriesView from './EntriesView';
import ForwardingView, { type HttpDraft, type SyslogDraft } from './ForwardingView';
import RetentionView from './RetentionView';
import '../../logs.css';

/**
 * Protokoll: wer was wann getan hat (`audit_logs`), wohin es weitergeleitet
 * wird und wie lange es bleibt. Siehe docs/protokoll.md.
 *
 * Drei Reiter, der gewählte steht als `?bereich=` in der Adresse. Die Einträge
 * lädt ihr Reiter selbst. Einstellungen und Zustand der Weiterleitung lädt die
 * Seite, weil zwei Reiter sie brauchen, und sie hält auch die Entwürfe der
 * Formulare: sie bleiben beim Wechsel des Reiters stehen.
 */

type AuditTab = 'eintraege' | 'weiterleitung' | 'aufbewahrung';

const AREAS: Area<AuditTab>[] = [
  { key: 'eintraege', label: msgid('Einträge'), icon: ListChecks },
  { key: 'weiterleitung', label: msgid('Weiterleitung an SIEM'), icon: Send },
  { key: 'aufbewahrung', label: msgid('Aufbewahrung'), icon: Archive },
];

const POLL_MS = 15_000;

export default function AuditPage() {
  // `useSearchParams` verlangt eine Suspense-Grenze, sonst scheitert der Build.
  return (
    <Suspense fallback={<SkeletonRows />}>
      <Audit />
    </Suspense>
  );
}

function Audit() {
  const { apiFetch } = useApp();
  const { t } = useT();
  const [area, selectArea] = useArea(AREAS, '/protokoll');
  const now = useNow(30_000);

  const [overview, setOverview] = useState<AuditOverview | null>(null);
  const [error, setError] = useState('');
  const [syslogDraft, setSyslogDraft] = useState<SyslogDraft | null>(null);
  const [httpDraft, setHttpDraft] = useState<HttpDraft | null>(null);
  const [retentionDraft, setRetentionDraft] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/audit/settings', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error);
      setOverview(body.data as AuditOverview);
      setError('');
    } catch {
      setError(t('Die Einstellungen des Protokolls konnten nicht geladen werden.'));
    }
  }, [apiFetch, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Zustand der Weiterleitung und Bestand ändern sich, während die Seite offen ist.
  usePolling(load, POLL_MS);

  const save = useCallback(
    async (patch: Record<string, unknown>): Promise<AuditOverview> => {
      const res = await apiFetch('/api/audit/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || t('Die Einstellung ließ sich nicht speichern.'));
      const next = body.data as AuditOverview;
      setOverview(next);
      return next;
    },
    [apiFetch, t]
  );

  const test = useCallback(
    async (destination: ForwardDestination): Promise<ForwardTestResult> => {
      const res = await apiFetch('/api/audit/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error);
      void load();
      return body.data as ForwardTestResult;
    },
    [apiFetch, load]
  );

  const dirty = (key: AuditTab) =>
    (key === 'weiterleitung' && (syslogDraft !== null || httpDraft !== null)) ||
    (key === 'aufbewahrung' && retentionDraft !== null && overview !== null && retentionDraft !== String(overview.settings.retentionDays));

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t('Protokoll')}{' '}
            <InfoHint text={t('Jede Anmeldung und jede Änderung an HAPM steht hier mit Zeitpunkt, Konto oder API-Key und Adresse. Was HAProxy an Anfragen sieht, steht unter „Logs“.')} />
          </h1>
          <p className="page-subtitle">{t('Wer was wann getan hat.')}</p>
        </div>
      </div>

      <AreaTabs areas={AREAS} value={area} onChange={selectArea} dirty={dirty} />

      {area === 'eintraege' ? (
        <EntriesView />
      ) : !overview ? (
        error ? (
          <div className="alert alert-danger sys-block"><ErrorNote text={error} /></div>
        ) : (
          <SkeletonDetail />
        )
      ) : (
        <>
          {error && <div className="alert alert-danger sys-block"><ErrorNote text={error} /></div>}
          {area === 'weiterleitung' ? (
            <ForwardingView
              overview={overview}
              now={now}
              syslogDraft={syslogDraft}
              setSyslogDraft={setSyslogDraft}
              httpDraft={httpDraft}
              setHttpDraft={setHttpDraft}
              save={save}
              test={test}
            />
          ) : (
            <RetentionView overview={overview} draft={retentionDraft} setDraft={setRetentionDraft} save={save} />
          )}
        </>
      )}
    </>
  );
}
