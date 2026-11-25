'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Activity, AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Timer, Users } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useMountedLoad } from '@/components/useMountedLoad';
import { useNow } from '@/components/useNow';
import Skeleton from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { Sparkline } from '@/ui/charts/Sparkline';
import { formatAgo } from '@/components/system/format';
import { formatBytes, formatCount, formatMs, formatPerSecond, formatShare, formatTime, MISSING } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Aus dem reinen Modul: `stats-overview.ts` zieht lib/db nach sich.
import {
  errorTone,
  LIVE_ERROR_MINUTES,
  LIVE_POLL_MS,
  type LiveRound,
  type LiveStats,
} from '@/lib/haproxy/stats-live';

/**
 * Die Live-Kennzahlen des Reverse-Proxys, auf der Übersicht und oben auf der
 * Statistik-Seite. Eine Komponente für beide, damit dieselbe Zahl an beiden
 * Stellen dieselbe ist.
 *
 * Gefragt wird `/api/haproxy/stats/live` im Takt `LIVE_POLL_MS`. Das ist die
 * Datenbank, nicht HAProxy: neue Zahlen gibt es einmal je Minute, wenn der
 * Sammler seine Runde gedreht hat. `onRound` meldet genau diesen Moment, damit
 * die Statistik-Seite ihre Zeitreihe dann nachlädt und nicht auf Verdacht.
 */
export default function LiveTraffic({
  scope,
  href,
  onRound,
}: {
  /** Ein Dienst (Backend-Zeile). Leer: alle Frontends. */
  scope?: string;
  /** Macht jede Kachel zu einem Link, auf der Übersicht zur Statistik. */
  href?: string;
  /** Eine neue Runde des Sammlers ist da. Nicht beim ersten Laden. */
  onRound?: (latestAt: string) => void;
}) {
  const { apiFetch } = useApp();
  const { t, locale } = useT();
  const now = useNow(LIVE_POLL_MS);
  const [live, setLive] = useState<LiveStats | null>(null);
  const [error, setError] = useState('');

  const latestRef = useRef<string | null | undefined>(undefined);
  const onRoundRef = useRef(onRound);
  useEffect(() => {
    onRoundRef.current = onRound;
  }, [onRound]);

  // Leise: kein Platzhalter beim Nachladen, ein Fehler lässt die letzten Zahlen stehen.
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (scope) params.set('scope', scope);
      const res = await apiFetch(`/api/haproxy/stats/live${params.size ? `?${params}` : ''}`);
      const body = await res.json();
      if (!body.success) throw new Error(body.error);
      const data = body.data as LiveStats;
      const previous = latestRef.current;
      latestRef.current = data.latestAt;
      setLive(data);
      setError('');
      if (previous !== undefined && data.latestAt && data.latestAt !== previous) {
        onRoundRef.current?.(data.latestAt);
      }
    } catch {
      setError(t('Die Live-Werte konnten nicht geladen werden.'));
    }
  }, [apiFetch, scope, t]);

  useMountedLoad(load);
  usePolling(load, LIVE_POLL_MS);

  const head = (
    <div className="live-kpis-head">
      <span
        className={`live-kpis-dot${live && !live.stale ? ' is-live' : live?.latestAt ? ' is-stale' : ''}`}
        aria-hidden="true"
      />
      <strong>{t('Live')}</strong>
      <span className="live-kpis-stamp">
        {error && !live
          ? error
          : !live
            ? ''
            : !live.latestAt
              ? t('Noch keine Messung. HAPM liest die Zähler von HAProxy jede Minute.')
              : live.stale
                ? t('Letzte Messung {ago}. Seitdem kam keine neue.', { ago: formatAgo(now, live.latestAt, locale) })
                : t('Messung von {time}', { time: formatTime(locale, live.latestAt, true) })}
      </span>
      <InfoHint
        text={t(
          'HAPM liest die Zähler von HAProxy jede Minute. Die Werte gelten für die letzte Minute, die Fehlerquoten für die letzten {minutes} Minuten. Die Linie zeigt die letzte halbe Stunde.',
          { minutes: LIVE_ERROR_MINUTES }
        )}
      />
    </div>
  );

  if (!live) {
    return (
      <section className="live-kpis sys-block">
        {head}
        <div className="live-kpi-grid">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} height={98} radius="var(--radius-lg)" />
          ))}
        </div>
      </section>
    );
  }

  const { current, rounds } = live;
  const to = live.latestAt ? Date.parse(live.latestAt) : now;
  const from = to - live.windowMinutes * 60_000;
  const line = (pick: (round: LiveRound) => number | null) =>
    rounds
      .map((round) => ({ t: Date.parse(round.at), value: pick(round) }))
      .filter((point) => point.t >= from);
  const known = (value: number | null, format: (value: number) => string) =>
    value === null ? MISSING : format(value);
  const tone5xx = errorTone(current.share5xx);

  return (
    <section className="live-kpis sys-block">
      {head}
      <div className="live-kpi-grid">
        <LiveKpi
          href={href}
          icon={<Activity size={16} strokeWidth={1.5} />}
          label={t('Anfragen pro Sekunde')}
          value={known(current.requestsPerSec, (v) => formatPerSecond(locale, v))}
          spark={line((round) => round.requestsPerSec)}
          from={from}
          to={to}
        />
        <LiveKpi
          href={href}
          icon={<ArrowUpFromLine size={16} strokeWidth={1.5} />}
          label={t('Ausgehend, an die Besucher')}
          value={known(current.bytesOutPerSec, (v) => formatBytes(locale, v))}
          unit={current.bytesOutPerSec === null ? undefined : '/s'}
          spark={line((round) => round.bytesOutPerSec)}
          from={from}
          to={to}
        />
        <LiveKpi
          href={href}
          icon={<ArrowDownToLine size={16} strokeWidth={1.5} />}
          label={t('Eingehend, von den Besuchern')}
          value={known(current.bytesInPerSec, (v) => formatBytes(locale, v))}
          unit={current.bytesInPerSec === null ? undefined : '/s'}
          spark={line((round) => round.bytesInPerSec)}
          from={from}
          to={to}
        />
        <LiveKpi
          href={href}
          icon={<Timer size={16} strokeWidth={1.5} />}
          label={t('Ø Antwortzeit der Ziele')}
          value={known(current.responseMs, (v) => formatMs(locale, v))}
          spark={line((round) => round.responseMs)}
          from={from}
          to={to}
        />
        <LiveKpi
          href={href}
          icon={<Users size={16} strokeWidth={1.5} />}
          label={t('Offene Verbindungen')}
          value={known(current.sessions, (v) => formatCount(locale, v))}
          spark={line((round) => round.sessions)}
          from={from}
          to={to}
        />
        <LiveKpi
          href={href}
          icon={<AlertTriangle size={16} strokeWidth={1.5} />}
          label={t('Serverfehler (5xx) in {minutes} Min. · 4xx: {share}', {
            minutes: LIVE_ERROR_MINUTES,
            share: formatShare(locale, current.share4xx, 1),
          })}
          value={known(current.share5xx, (v) => formatShare(locale, v, 1))}
          tone={tone5xx}
          spark={line((round) => round.share5xx)}
          from={from}
          to={to}
        />
      </div>
    </section>
  );
}

function LiveKpi({
  href,
  icon,
  label,
  value,
  unit,
  tone,
  spark,
  from,
  to,
}: {
  href?: string;
  icon: ReactNode;
  label: string;
  /** Schon formatiert, `MISSING` für unbekannt. */
  value: string;
  unit?: string;
  tone?: 'warning' | 'danger';
  spark: { t: number; value: number | null }[];
  from: number;
  to: number;
}) {
  const className = `kpi live-kpi${tone ? ` is-${tone}` : ''}`;
  const body = (
    <>
      <span className="live-kpi-top">
        <span className="kpi-icon">{icon}</span>
        <span className="kpi-body">
          <span className="kpi-value">
            {value}
            {unit && <small>{unit}</small>}
          </span>
          <span className="kpi-label">{label}</span>
        </span>
      </span>
      <Sparkline points={spark} from={from} to={to} tone={tone ?? 'accent'} />
    </>
  );
  return href ? (
    <Link href={href} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}
