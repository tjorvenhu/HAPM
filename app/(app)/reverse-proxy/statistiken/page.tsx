'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft, BarChart3, Loader2, RefreshCw, Globe, Activity, AlertTriangle,
  ArrowDownUp, Timer, Users, ShieldBan, FileText,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { SkeletonRows } from '@/components/Skeleton';
import Select from '@/components/Select';
import { BarList } from '@/ui/charts/BarList';
import CountryFlag from '@/components/CountryFlag';
import { countryName } from '@/lib/country-flags';
import MetricChart, { ChartCard } from '@/components/systems/MetricChart';
import { seriesColor } from '@/lib/systems/series';
import LiveTraffic from '@/components/reverse-proxy/LiveTraffic';
import type { ChartPoint } from '@/lib/systems/series';
import { formatBytes, formatCount, formatDateTime, formatShare, formatTime, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { STATS_FORMATS, seriesPerLocale } from './format';
import BrandLogo from '@/components/BrandLogo';
import CrowdsecStats from '@/components/crowdsec/CrowdsecStats';

/**
 * Die Auswertung des Reverse-Proxys.
 *
 * ── Zwei Quellen, zwei Geschwindigkeiten ──
 *
 * Die Seite zeigt zwei Dinge, die aus verschiedenen Richtungen kommen, und das
 * ist der Grund für ihren Aufbau:
 *
 *  - **Wie viel** lief, über die Zeit. Das kommt aus `haproxy_metrics`, also aus
 *    der Datenbank, und ist billig: ein Ladevorgang ist eine Abfrage. Oben
 *    stehen die Live-Kennzahlen (`LiveTraffic`, dieselben wie auf der
 *    Übersicht), die alle fünfzehn Sekunden fragen. Sie melden, wenn der
 *    Sammler eine neue Runde geschrieben hat, und erst dann lädt die Seite die
 *    Zeitreihe nach: der neue Punkt steht da, ohne dass ein Zeitraum von dreißig
 *    Tagen alle fünfzehn Sekunden neu gelesen wird.
 *  - **Wer** zugegriffen hat: Adressen, Länder, Pfade. Das steht nur im
 *    Access-Log auf der Maschine, und ein Lauf liest dort bis zu 200 000 Zeilen.
 *    Deshalb ein eigener, langsamer Takt (`TRAFFIC_POLL_MS`), und nie zwei
 *    Läufe gleichzeitig.
 *
 * Sie in EINE Route zu legen hätte geheißen, dass jeder Poll-Takt das Log
 * liest. Deshalb zwei Routen und zwei Ladezustände, sichtbar getrennt: der
 * untere Block trägt seinen eigenen Knopf und seinen eigenen Zeitstempel.
 *
 * Nachladen ist immer leise: kein Platzhalter, kein Spinner. Den gibt es nur
 * beim ersten Laden und nach einer Handlung (Zeitraum, Dienst, Knopf).
 *
 * ── Warum der Zeitraum nur für die obere Hälfte gilt ──
 *
 * Weil die untere keinen hat. Das Access-Log wird über `tail` gelesen, also
 * über eine Zeilenzahl und nicht über ein Datum (Begründung in
 * `lib/haproxy/access-log.ts`). Welchen Zeitraum die gelesenen Zeilen abdecken,
 * steht deshalb IN der Auswertung und wird angezeigt, statt dass der Wähler
 * oben eine Deckung behauptet, die er nicht hat.
 */

/* ══════════════════════════════════════════════════════════════════════
 * Was von den Routen kommt
 * ══════════════════════════════════════════════════════════════════════ */

type Metrics = Record<string, number | null>;

interface StatsResponse {
  hours: number;
  bucketMinutes: number;
  /** Wie viele Rasterpunkte dahinterstehen. Unter zwei gibt es keine Differenz
   *  und damit keinen einzigen Balken — siehe den Hinweis auf der Seite. */
  samples: number;
  series: ({ at: string } & Metrics)[];
  totals: Metrics;
  services: { scope: string; serverId: string; serverName: string; requests: number }[];
  proxies: { $id: string; name: string }[];
}

interface Counted {
  key: string;
  count: number;
}

interface TrafficResponse {
  collectedAt: string;
  scope: string | null;
  lines: number;
  proxies: {
    serverId: string;
    serverName: string;
    source: 'file' | 'journal' | 'none';
    logPath: string | null;
    error: string | null;
    lines: number | null;
    parsed: number | null;
    from: string | null;
    to: string | null;
  }[];
  totals: {
    lines: number;
    parsed: number;
    bytes: number;
    uniqueIps: number;
    uniqueIpsExact: boolean;
    from: string | null;
    to: string | null;
  };
  countries: { code: string; count: number }[];
  countryCoverage: number | null;
  countryUnknown: number;
  geoipAvailable: boolean;
  ips: Counted[];
  paths: Counted[];
  statusCodes: Counted[];
  methods: Counted[];
  hours: { hour: string; count: number }[];
  backends: {
    backend: string;
    requests: number;
    http2xx: number;
    http3xx: number;
    http4xx: number;
    http5xx: number;
    httpOther: number;
    bytes: number;
  }[];
}

/* ══════════════════════════════════════════════════════════════════════
 * Konstanten — stabil, weil MetricChart memoisiert ist
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * Wie oft das Access-Log neu ausgewertet wird, solange die Seite offen ist.
 *
 * Ein Lauf liest bis zu 200 000 Zeilen (`/api/haproxy/traffic`), das ist
 * Arbeit für die Maschine und keine Abfrage. Zwei Minuten, weil sich Länder,
 * Adressen und Pfade in kürzerer Zeit kaum verschieben und das Diagramm
 * darüber in Stunden rechnet. Ein verdeckter Tab fragt nicht (`usePolling`).
 */
const TRAFFIC_POLL_MS = 120_000;

const RANGES = [
  { value: '6', label: msgid('Letzte 6 Stunden') },
  { value: '24', label: msgid('Letzte 24 Stunden') },
  { value: '72', label: msgid('Letzte 3 Tage') },
  { value: '168', label: msgid('Letzte 7 Tage') },
  { value: '720', label: msgid('Letzte 30 Tage') },
];

/** Die Statusklassen in der Reihenfolge, in der sie gestapelt werden: gut
 *  unten, kaputt oben. Sonst liegt die 5xx-Spur zwischen zwei harmlosen
 *  Bändern und ist beim Überfliegen nicht zu finden. */
const STATUS_SERIES = seriesPerLocale([
  { key: 'http2xx', name: msgid('2xx erfolgreich'), color: seriesColor(0) },
  { key: 'http3xx', name: msgid('3xx weitergeleitet'), color: seriesColor(1) },
  { key: 'httpOther', name: msgid('Andere'), color: seriesColor(5) },
  { key: 'http4xx', name: msgid('4xx Anfragefehler'), color: seriesColor(2) },
  { key: 'http5xx', name: msgid('5xx Serverfehler'), color: seriesColor(3) },
]);

const TRAFFIC_SERIES = seriesPerLocale([
  { key: 'bytesOutKb', name: msgid('Ausgehend'), color: seriesColor(0) },
  { key: 'bytesInKb', name: msgid('Eingehend'), color: seriesColor(4) },
]);

const TIMING_SERIES = seriesPerLocale([
  { key: 'responseMs', name: msgid('Antwort des Ziels'), color: seriesColor(0) },
  { key: 'totalMs', name: msgid('Gesamt'), color: seriesColor(1) },
  { key: 'queueMs', name: msgid('Warteschlange'), color: seriesColor(3) },
]);

/** Eine einzelne Reihe fängt bei der ersten Farbe an, wie jede andere
 *  Einzelreihe im Werkzeug. Sie stand auf `seriesColor(4)` und war damit rosa —
 *  neben Diagrammen, in denen Rottöne die Fehler sind, liest sich das als
 *  Warnung, und gleichzeitige Sitzungen sind keine. */
const SESSION_SERIES = seriesPerLocale([
  { key: 'sessionsCurrent', name: msgid('Gleichzeitige Sitzungen'), color: seriesColor(0) },
]);

const PROBLEM_SERIES = seriesPerLocale([
  { key: 'errors', name: msgid('Fehler'), color: seriesColor(3) },
  { key: 'denied', name: msgid('Abgewiesen'), color: seriesColor(2) },
  { key: 'retries', name: msgid('Wiederholt'), color: seriesColor(5) },
]);

const REQUEST_SERIES = seriesPerLocale([
  { key: 'count', name: msgid('Anfragen'), color: seriesColor(0) },
]);

/* ══════════════════════════════════════════════════════════════════════
 * Die Seite
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * `useSearchParams` verlangt eine Suspense-Grenze, sonst scheitert der Build an
 * dieser Seite. Dieselbe Hülle wie auf der Gruppenseite, aus demselben Grund.
 */
export default function ReverseProxyStatsPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <StatsSwitch />
    </Suspense>
  );
}

type StatsTab = 'verkehr' | 'crowdsec';

/**
 * Zwei Reiter: der Verkehr über HAProxy und CrowdSec (`?ansicht=crowdsec`).
 * CrowdSec hat eine eigene Quelle (seine Ereignisse) und einen eigenen
 * Zeitraum, deshalb ein eigener Reiter und kein Block unter dem Verkehr.
 */
function StatsSwitch() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useT();
  const [tab, setTab] = useState<StatsTab>(() => (searchParams.get('ansicht') === 'crowdsec' ? 'crowdsec' : 'verkehr'));

  const choose = useCallback(
    (next: StatsTab) => {
      setTab(next);
      router.replace(next === 'crowdsec' ? '/reverse-proxy/statistiken?ansicht=crowdsec' : '/reverse-proxy/statistiken', {
        scroll: false,
      });
    },
    [router]
  );

  const tabs = (
    <div className="tabs" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'verkehr'}
        className={`tab ${tab === 'verkehr' ? 'active' : ''}`}
        onClick={() => choose('verkehr')}
      >
        <BrandLogo brand="haproxy" size={15} />
        {t('Verkehr')}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'crowdsec'}
        className={`tab ${tab === 'crowdsec' ? 'active' : ''}`}
        onClick={() => choose('crowdsec')}
      >
        <BrandLogo brand="crowdsec" size={15} />
        CrowdSec
      </button>
    </div>
  );

  if (tab === 'crowdsec') {
    return (
      <>
        <div className="page-header">
          <div>
            <Link className="sys-back" href="/reverse-proxy">
              <ArrowLeft size={14} />
              {t('Reverse-Proxy')}
            </Link>
            <h1 className="page-title">{t('Reverse-Proxy-Statistik')}</h1>
            <p className="page-subtitle">{t('Was CrowdSec erkannt und abgelehnt hat: WAF-Treffer, Szenarien und Sperren.')}</p>
          </div>
        </div>
        {tabs}
        <CrowdsecStats />
      </>
    );
  }
  return <StatsView tabs={tabs} />;
}

function StatsView({ tabs }: { tabs: React.ReactNode }) {
  const { apiFetch } = useApp();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, locale } = useT();
  const fmt = STATS_FORMATS[locale];

  const [hours, setHours] = useState('24');
  /**
   * Leer heißt: die Übersicht über alle Frontends. Gesetzt heißt: ein Dienst.
   *
   * Der Startwert kommt aus `?dienst=` — derselbe Parameter, mit dem auch die
   * Zertifikatsseite auf einen Eintrag zeigt. Er steht im Startwert und nicht
   * in einem Effekt: ein Effekt liefe erst nach dem ersten Ladevorgang, und der
   * hätte dann die Übersicht geholt, die niemand sehen wollte.
   */
  const [scope, setScope] = useState(() => searchParams.get('dienst') ?? '');

  /**
   * Den Dienst wechseln — und die Adresse mitnehmen.
   *
   * Damit ist die Ansicht verlinkbar (der Knopf auf der Zielkarte zeigt genau
   * hierher) und der Zurück-Knopf des Browsers tut das Erwartbare. `replace`
   * und nicht `push`: wer durch fünf Dienste klickt, will danach mit einem
   * Schritt aus der Seite heraus und nicht durch fünf Zustände zurück.
   */
  const selectScope = useCallback(
    (next: string) => {
      setScope(next);
      router.replace(next ? `?dienst=${encodeURIComponent(next)}` : '/reverse-proxy/statistiken', {
        scroll: false,
      });
    },
    [router]
  );

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [traffic, setTraffic] = useState<TrafficResponse | null>(null);
  const [trafficLoading, setTrafficLoading] = useState(false);
  const [trafficError, setTrafficError] = useState('');

  /* ── Die Zeitreihe ── */

  const loadStats = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const params = new URLSearchParams({ hours });
        if (scope) params.set('scope', scope);
        const res = await apiFetch(`/api/haproxy/stats?${params}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        setStats(data.data as StatsResponse);
        setError('');
      } catch {
        setError(t('Die Zeitreihe konnte nicht geladen werden.'));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, hours, scope, t]
  );

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Kein eigener Takt: `LiveTraffic` meldet die neue Runde des Sammlers, und
  // genau dann gibt es einen neuen Punkt. Ein fester Takt von einer Minute lag
  // bis zu einer Minute daneben, ein schnellerer läse dieselben Zeilen mehrfach.
  const onRound = useCallback(() => void loadStats(true), [loadStats]);

  /** Eigener Zustand für den Knopf, damit die Liste stehen bleibt statt hinter
   *  einem Platzhalter zu verschwinden — siehe docs/ui.md. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    const started = Date.now();
    await loadStats(true);
    // Ohne Mindestdauer blitzt der Spinner bei einer schnellen Antwort nur auf,
    // und das sieht aus wie ein Fehler statt wie ein Ladevorgang.
    const rest = 400 - (Date.now() - started);
    if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
    setRefreshing(false);
  }, [loadStats]);

  /* ── Das Access-Log ── */

  /** Läuft gerade eine Auswertung? Dann startet der Takt keine zweite. */
  const trafficBusy = useRef(false);

  const loadTraffic = useCallback(
    async (quiet = false) => {
      if (quiet && trafficBusy.current) return;
      trafficBusy.current = true;
      if (!quiet) {
        setTrafficLoading(true);
        setTrafficError('');
      }
      try {
        const params = new URLSearchParams();
        if (scope) params.set('scope', scope);
        const res = await apiFetch(`/api/haproxy/traffic?${params}`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        setTraffic(data.data as TrafficResponse);
        setTrafficError('');
      } catch {
        // Leise gescheitert: die letzte Auswertung bleibt stehen, ihr
        // Zeitstempel zeigt, wie alt sie ist.
        if (!quiet) setTrafficError(t('Die Zugriffe konnten nicht ausgewertet werden.'));
      } finally {
        trafficBusy.current = false;
        if (!quiet) setTrafficLoading(false);
      }
    },
    [apiFetch, scope, t]
  );

  // Beim Öffnen und bei jedem Wechsel des Dienstes. NICHT
  // beim Zeitraum: der gilt für die Zeitreihe, das Log liest immer sein Fenster.
  useEffect(() => {
    loadTraffic();
  }, [loadTraffic]);

  usePolling(() => loadTraffic(true), TRAFFIC_POLL_MS);

  /* ── Aus den Antworten Diagramme ── */

  const points = useMemo<ChartPoint[]>(
    () =>
      (stats?.series ?? []).map((row) => {
        const { at, ...rest } = row;
        return { t: Date.parse(at), ...rest };
      }),
    [stats]
  );

  const hourPoints = useMemo<ChartPoint[]>(
    () =>
      (traffic?.hours ?? []).map((entry) => ({
        t: Date.parse(entry.hour),
        count: entry.count,
      })),
    [traffic]
  );

  const rangeMs = Number(hours) * 3_600_000;
  const totals = stats?.totals ?? {};
  const requests = totals.requests ?? null;
  const errorRate =
    requests && requests > 0 && totals.http5xx !== null && totals.http5xx !== undefined
      ? totals.http5xx / requests
      : null;
  const successRate =
    requests && requests > 0 && totals.http2xx !== null && totals.http2xx !== undefined
      ? (totals.http2xx + (totals.http3xx ?? 0)) / requests
      : null;

  return (
    <>
      <div className="page-header">
        <div>
          {/*
            Der Rückweg richtet sich danach, wo man steht, und nicht danach, wo
            die Seite im Menü hängt. Aus der Auswertung EINES Dienstes führt er
            zur Gesamtauswertung — dorthin, wo man herkam. Dass er von der
            Übersicht aus zur Zielliste zeigte, war beim Drilldown die falsche
            Richtung: er sprang zwei Ebenen und verlor den Zeitraum dazu.
          */}
          {scope ? (
            <button type="button" className="sys-back" onClick={() => selectScope('')}>
              <ArrowLeft size={14} />
              {t('Alle Dienste')}
            </button>
          ) : (
            <Link className="sys-back" href="/reverse-proxy">
              <ArrowLeft size={14} />
              {t('Reverse-Proxy')}
            </Link>
          )}
          <h1 className="page-title">
            {scope ? t('Statistik: {scope}', { scope }) : t('Reverse-Proxy-Statistik')}
          </h1>
          <p className="page-subtitle">
            {scope
              ? t('Nur dieser Dienst. Die Zahlen kommen aus HAProxys eigener Statistik, die Zugriffe aus seinem Log.')
              : t('Was über HAProxy läuft: Anfragen, Statuscodes, übertragene Menge, Antwortzeiten und wer zugreift.')}
          </p>
        </div>
        {/* Der Zeitraum steht im Seitenkopf und nicht über den Diagrammen: er
            gilt für alles darunter. Siehe docs/ui.md. */}
        <div className="page-actions">
          {/*
            Der zweite Weg zu einem Dienst, neben dem Klick in der Liste unten.
            Er steht hier, weil er beim Drilldown der einzige bleibt: dort gibt
            es die Liste nicht mehr, und ohne ihn müsste man erst zurück, um
            den nächsten Dienst anzusehen.
          */}
          {(stats?.services.length ?? 0) > 0 && (
            /*
              Breit genug für lange Dienstnamen (dreißig Zeichen und mehr): die
              Auswahl soll nicht kürzen müssen. Die Anzahl der Anfragen steht dabei NICHT im
              Hinweis: sie machte die Zeile ein Drittel breiter für eine Zahl,
              die zwei Zeilen tiefer in der Dienstliste ohnehin steht.
            */
            <div style={{ minWidth: 300 }}>
              <Select
                value={scope}
                onChange={selectScope}
                options={[
                  { value: '', label: t('Alle Dienste') },
                  ...(stats?.services ?? []).map((service) => ({
                    value: service.scope,
                    label: service.scope,
                  })),
                ]}
              />
            </div>
          )}
          <div style={{ minWidth: 180 }}>
            <Select
              value={hours}
              onChange={setHours}
              options={RANGES.map((range) => ({ value: range.value, label: t(range.label) }))}
            />
          </div>
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
        </div>
      </div>

      {tabs}

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {/* Neu eingehängt je Dienst: sonst meldete der Wechsel eine „neue Runde". */}
      <LiveTraffic key={scope} scope={scope || undefined} onRound={onRound} />

      {loading ? (
        <SkeletonRows />
      ) : (
        <>
          {/*
            Der eine Fall, der wie ein Fehler aussieht und keiner ist.

            `show stat` liefert Zählerstände, kein Fenster. Nach dem Start von
            HAPM gibt es genau eine Probe, und aus einer Probe lässt sich
            keine Differenz bilden: die Momentanwerte stehen schon da, alles
            andere erst nach der zweiten Runde. Ohne diesen Satz stehen fünf
            Diagramme auf „keine Messwerte", und das liest sich wie „kaputt".
          */}
          {(stats?.samples ?? 0) < 2 && (
            <div className="alert alert-info sys-block">
              <Timer size={16} style={{ flexShrink: 0 }} />
              <span>
                <strong>{t('Die Zeitreihe fängt gerade erst an.')}</strong>{' '}
                {t('HAProxy liefert Zählerstände seit dem Start seines Prozesses, kein Fenster. Ein Balken ist immer die Differenz zweier Proben. Die gleichzeitigen Sitzungen stehen deshalb schon da, Anfragen, Statuscodes und übertragene Menge ab der zweiten Runde. Erfasst wird jede Minute.')}
              </span>
            </div>
          )}

          {/* ── Kennzahlen ── Summen über den gewählten Zeitraum. Die Zeile
              darüber nennt ihn, sonst liest man sie neben den Live-Werten als
              dieselbe Art Zahl. */}
          <div className="live-kpis-head">
            <strong>{t(RANGES.find((range) => range.value === hours)?.label ?? RANGES[1].label)}</strong>
          </div>
          <div className="kpi-grid sys-block">
            <Kpi
              icon={<Activity size={16} />}
              label={t('Anfragen')}
              value={requests === null ? '–' : fmt.count(requests)}
            />
            <Kpi
              icon={<BarChart3 size={16} />}
              label={t('Erfolgsquote')}
              value={formatShare(locale, successRate, 1)}
            />
            <Kpi
              icon={<AlertTriangle size={16} />}
              label={t('Serverfehler (5xx)')}
              value={
                totals.http5xx === null || totals.http5xx === undefined
                  ? '–'
                  : `${fmt.count(totals.http5xx)}${errorRate === null ? '' : ` · ${formatShare(locale, errorRate, 1)}`}`
              }
            />
            <Kpi
              icon={<ArrowDownUp size={16} />}
              label={t('Ausgehend')}
              value={
                totals.bytesOutKb === null || totals.bytesOutKb === undefined
                  ? '–'
                  : fmt.kb(totals.bytesOutKb)
              }
            />
            <Kpi
              icon={<Timer size={16} />}
              label={t('Ø Antwortzeit')}
              value={
                totals.responseMs === null || totals.responseMs === undefined
                  ? '–'
                  : fmt.ms(totals.responseMs)
              }
            />
            <Kpi
              icon={<Users size={16} />}
              label={t('IP-Adressen')}
              value={traffic ? fmt.count(traffic.totals.uniqueIps) : '–'}
            />
            <Kpi
              icon={<Globe size={16} />}
              label={t('Länder')}
              value={traffic ? fmt.count(traffic.countries.length) : '–'}
            />
            <Kpi
              icon={<ShieldBan size={16} />}
              label={t('Abgewiesen')}
              value={
                totals.denied === null || totals.denied === undefined
                  ? '–'
                  : fmt.count(totals.denied)
              }
            />
          </div>

          {/* ── Die Zeitreihe ── */}
          <div className="viz-grid">
            {/*
              Linien, dieselbe Form wie unter „Systeme → Durchschnittslast".

              Zwei Zwischenstände stehen hinter dieser einen Zeile, und beide
              waren begründet und trotzdem falsch:

              Zuerst Balken, mit dem Argument aus `MetricChart` — ein Punkt ist
              die Summe über ein Fenster, und eine Linie dazwischen behauptet
              einen Zwischenwert, den es nicht gibt. Recharts teilt die
              Zeichenfläche aber unter den vorhandenen Punkten auf: bei einer
              frischen Zeitreihe wurden daraus Farbflächen über die halbe Kachel.

              Dann ein Stapel, wegen der Zusammensetzung auf einen Blick. Ein
              gestapeltes Band ist in `MetricChart` aber **deckend**
              (`fillOpacity: 1`), und das aus gutem Grund: bei halber Deckkraft
              scheint das Raster durch jedes Band. Neben vier Diagrammen mit
              feinen Linien stand damit eine massive Farbfläche.

              Also Linien, wie überall sonst auf dieser Seite, wo mehrere Reihen
              nebeneinanderliegen. Der Preis ist ehrlich: die Gesamtzahl ist
              nicht mehr die Höhe des Bandes. Sie steht als Kennzahl oben.

              Unter den Linien liegt trotzdem eine Fläche (`area`, OHNE
              `stacked`), wie bei jedem Diagramm dieser Seite. Das ist kein
              Rückfall in den Stapel: ungestapelt zeichnet `TimeSeriesChart` je
              Reihe einen eigenen Verlauf, der nach unten ausläuft, bei drei und
              mehr Reihen mit 18 % Deckkraft oben. Die Flächen überlagern sich
              durchscheinend, keine trägt eine andere, und die Linie bleibt das,
              was man liest. Deckend und massiv ist nur der Stapel.
            */}
            <ChartCard
              title={t('Anfragen nach Statusklasse')}
              subtitle={t(
                'Summe je {minutes} Minuten, je Klasse eine Linie. Das Gesamtaufkommen steht als Kennzahl oben.',
                { minutes: stats?.bucketMinutes ?? 5 }
              )}
            >
              <MetricChart
                data={points}
                series={STATUS_SERIES[locale]}
                format={fmt.countShort}
                rangeMs={rangeMs}
                area
              />
            </ChartCard>

            <ChartCard
              title={t('Übertragene Menge')}
              subtitle={t(
                'Aus Sicht des Proxys: ausgehend ist, was an die Besucher ging. Zwei Richtungen, deshalb zwei Linien und kein Stapel: ihre Summe bedeutet nichts.'
              )}
            >
              <MetricChart
                data={points}
                series={TRAFFIC_SERIES[locale]}
                format={fmt.kb}
                rangeMs={rangeMs}
                area
              />
            </ChartCard>

            <ChartCard
              title={t('Antwortzeiten')}
              subtitle={
                scope
                  ? t('Gleitende Mittel über die letzten 1024 Antworten, wie HAProxy sie führt, keine Summen.')
                  : t(
                      'Aus den Backends: ein Frontend hat kein Ziel und misst deshalb keine Antwortzeit. Nach Anfragen gewichtet, damit ein Dienst mit drei Aufrufen die Kurve nicht so weit zieht wie einer mit zehntausend.'
                    )
              }
            >
              <MetricChart
                data={points}
                series={TIMING_SERIES[locale]}
                format={fmt.ms}
                rangeMs={rangeMs}
                area
              />
            </ChartCard>

            <ChartCard
              title={t('Gleichzeitige Sitzungen')}
              subtitle={t('Momentanwert zum Zeitpunkt jeder Probe, nicht der Höchstwert dazwischen.')}
            >
              <MetricChart
                data={points}
                series={SESSION_SERIES[locale]}
                format={fmt.count}
                rangeMs={rangeMs}
                area
              />
            </ChartCard>

            <ChartCard
              title={t('Fehler, Abweisungen, Wiederholungen')}
              subtitle={t(
                'Abgewiesen heißt: von einer Regel gestoppt, etwa der Sperre auf Admin-Adressen. Wiederholt heißt: HAProxy hat es an einem anderen Ziel erneut versucht. Das kennt nur ein Backend. Fehler und Abweisungen sind die Eingangs- und die Zielseite zusammengezählt.'
              )}
            >
              {/* Drei unabhängige Größen, also drei Linien mit je eigener
                  Fläche: gestapelt läse man eine Gesamtzahl „Probleme", die
                  keine Bedeutung hat. */}
              <MetricChart
                data={points}
                series={PROBLEM_SERIES[locale]}
                format={fmt.countShort}
                rangeMs={rangeMs}
                area
              />
            </ChartCard>

            <ChartCard
              title={t('Zugriffe je Stunde')}
              subtitle={
                traffic?.totals.from
                  ? t('Aus dem Access-Log, {from} bis {to}.', {
                      from: formatDateTime(locale, traffic.totals.from),
                      to: traffic.totals.to ? formatDateTime(locale, traffic.totals.to) : '–',
                    })
                  : t('Aus dem Access-Log.')
              }
            >
              {trafficLoading ? (
                <div className="viz-empty">
                  <Loader2 size={16} className="spin" style={{ marginRight: 8 }} />
                  {t('Das Log wird ausgewertet …')}
                </div>
              ) : (
                <MetricChart
                  data={hourPoints}
                  series={REQUEST_SERIES[locale]}
                  format={fmt.countShort}
                  rangeMs={24 * 3_600_000}
                  area
                />
              )}
            </ChartCard>
          </div>

          {/* ── Wer zugreift ── */}
          <TrafficSection
            traffic={traffic}
            loading={trafficLoading}
            error={trafficError}
            onReload={() => loadTraffic()}
            scope={scope}
          />

          {/* ── Die Dienste ── */}
          {!scope && (
            <ServiceTable
              services={stats?.services ?? []}
              onSelect={selectScope}
              hours={Number(hours)}
            />
          )}
        </>
      )}
    </>
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * Bausteine
 * ══════════════════════════════════════════════════════════════════════ */

function Kpi({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="kpi">
      <span className="kpi-icon">{icon}</span>
      <div className="kpi-body">
        <span className="kpi-value">{value}</span>
        <span className="kpi-label">{label}</span>
      </div>
    </div>
  );
}

/** Eine Rangliste mit Balken (`BarList` aus `ui/charts/`). */
function Ranking({
  rows,
  onSelect,
}: {
  rows: { key: string; label: React.ReactNode; title?: string; count: number }[];
  onSelect?: (key: string) => void;
}) {
  const { t } = useT();
  return (
    <BarList
      items={rows.map((row) => ({ key: row.key, label: row.label, title: row.title, value: row.count }))}
      onSelect={onSelect}
      emptyText={t('Keine Daten')}
    />
  );
}

/**
 * Der Access-Log-Block.
 *
 * Eigener Kopf mit eigenem Knopf und eigenem Zeitstempel, weil er eine eigene
 * Quelle und eine eigene Geschwindigkeit hat. Und weil er genau dann nichts
 * zeigen kann, wenn kein Log vorliegt — dann steht das dort und keine Null.
 */
function TrafficSection({
  traffic,
  loading,
  error,
  onReload,
  scope,
}: {
  traffic: TrafficResponse | null;
  loading: boolean;
  error: string;
  onReload: () => void;
  scope: string;
}) {
  const { t, plural, locale } = useT();
  const withoutLog = traffic?.proxies.filter((proxy) => proxy.source === 'none') ?? [];
  const failed = traffic?.proxies.filter((proxy) => proxy.error) ?? [];

  return (
    <div className="sys-block">
      <div className="card-header" style={{ marginBottom: 12 }}>
        <div>
          <h2 className="card-title">{t('Zugriffe')}</h2>
          <p className="card-subtitle">
            {t('Aus dem Access-Log von HAProxy.')}{' '}
            {traffic
              ? t('{parsed} von {lines} gelesenen Zeilen ausgewertet, zuletzt {time}.', {
                  parsed: formatCount(locale, traffic.totals.parsed),
                  lines: formatCount(locale, traffic.totals.lines),
                  time: formatTime(locale, traffic.collectedAt, true),
                })
              : t('Wird alle zwei Minuten neu ausgewertet, solange die Seite offen ist.')}
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={onReload} disabled={loading}>
          {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
          {t('Neu auswerten')}
        </button>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {failed.map((proxy) => (
        <div className="alert alert-warning sys-block" key={proxy.serverId}>
          {proxy.error}
        </div>
      ))}

      {!loading && traffic && withoutLog.length > 0 && failed.length === 0 && (
        <div className="alert alert-info sys-block">
          {t(
            'Es wurde kein HAProxy-Log gefunden. HAPM schreibt das Log des HAProxy-Containers mit. Liegt dort nichts, hat HAProxy noch keine Anfrage protokolliert. Die Zahlen oben (aus HAProxys eigener Statistik) stimmen trotzdem.'
          )}
        </div>
      )}

      {loading ? (
        <SkeletonRows />
      ) : !traffic || traffic.totals.parsed === 0 ? (
        <div className="empty-state">
          <FileText size={40} />
          <h3>{t('Keine auswertbaren Zeilen')}</h3>
          <p>
            {scope
              ? t('Für diesen Dienst stand im gelesenen Fenster des Logs keine Anfrage.')
              : t('Im gelesenen Fenster des Logs stand keine Anfrage, oder das Format ist keines, das sich lesen lässt.')}
          </p>
        </div>
      ) : (
        <>
          <div className="metrics-row">
            <div className="card">
              <div className="card-header">
                <div>
                  <h3 className="card-title">{t('Länder')}</h3>
                  <p className="card-subtitle">
                    {!traffic.geoipAvailable
                      ? t('Es ist keine Länder-Tabelle hinterlegt.')
                      : t('Aus {share} der Anfragen. Die Auswertung nimmt die häufigsten Adressen, nicht alle.', {
                          share: formatShare(locale, traffic.countryCoverage, 1),
                        })}
                  </p>
                </div>
              </div>
              <Ranking
                rows={traffic.countries.slice(0, 12).map((entry) => ({
                  key: entry.code,
                  count: entry.count,
                  title: countryName(entry.code, locale),
                  label: (
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CountryFlag code={entry.code} /> {countryName(entry.code, locale)}
                    </span>
                  ),
                }))}
              />
            </div>

            <div className="card">
              <div className="card-header">
                <div>
                  <h3 className="card-title">{t('Adressen')}</h3>
                  <p className="card-subtitle">
                    {plural(traffic.totals.uniqueIps, {
                      one: '{count} Adresse im Fenster.',
                      other: '{count} verschiedene im Fenster.',
                    })}
                  </p>
                </div>
              </div>
              <Ranking
                rows={traffic.ips.slice(0, 12).map((entry) => ({
                  key: entry.key,
                  count: entry.count,
                  label: <span className="ranking-mono">{entry.key}</span>,
                }))}
              />
            </div>
          </div>

          <div className="metrics-row">
            <div className="card">
              <div className="card-header">
                <div>
                  <h3 className="card-title">{t('Statuscodes')}</h3>
                  <p className="card-subtitle">{t('Der genaue Code, nicht die Klasse.')}</p>
                </div>
              </div>
              <Ranking
                rows={traffic.statusCodes.slice(0, 12).map((entry) => ({
                  key: entry.key,
                  count: entry.count,
                  label: <span className="ranking-mono">{entry.key}</span>,
                }))}
              />
            </div>

            <div className="card">
              <div className="card-header">
                <div>
                  <h3 className="card-title">{t('Methoden')}</h3>
                  <p className="card-subtitle">{t('Womit angefragt wurde.')}</p>
                </div>
              </div>
              <Ranking
                rows={traffic.methods.slice(0, 12).map((entry) => ({
                  key: entry.key,
                  count: entry.count,
                  label: <span className="ranking-mono">{entry.key}</span>,
                }))}
              />
            </div>
          </div>

          {/*
            Pfade und die Log-Zahlen dieses einen Dienstes gibt es NUR im
            Drilldown, und das ist keine Platzfrage.

            Über alle Dienste zusammen ist eine Pfad-Rangliste keine Auskunft:
            `/` steht dann für dreißig verschiedene Websites, und die Zeile
            darunter für eine einzelne API. Erst innerhalb eines Dienstes gehören
            die Pfade zueinander und lassen sich vergleichen. Dieselbe Rechnung
            bei den Zahlen aus dem Log — welcher Dienst wie viel hatte, sagt in
            der Übersicht schon die Dienstliste aus der Zeitreihe, und zwei
            Listen derselben Sache aus zwei Quellen nebeneinander sind vor allem
            eine Frage danach, welche denn nun stimmt.
          */}
          {scope && (
            <div className="metrics-row">
              <div className="card">
                <div className="card-header">
                  <div>
                    <h3 className="card-title">{t('Pfade')}</h3>
                    <p className="card-subtitle">
                      {t('Ohne Abfrageteil, sonst wäre jede Suche ein eigener Pfad.')}
                    </p>
                  </div>
                </div>
                <Ranking
                  rows={traffic.paths.slice(0, 12).map((entry) => ({
                    key: entry.key,
                    count: entry.count,
                    title: entry.key,
                    label: <span className="ranking-mono">{entry.key}</span>,
                  }))}
                />
              </div>

              <div className="card">
                <div className="card-header">
                  <div>
                    <h3 className="card-title">{t('Dieser Dienst im Log')}</h3>
                    <p className="card-subtitle">
                      {t(
                        'Eine andere Zählung als die Zeitreihe oben: hier zählt jede Zeile im gelesenen Fenster, dort HAProxys eigener Zähler über den gewählten Zeitraum. Zwei verschiedene Zahlen sind hier normal und kein Widerspruch.'
                      )}
                    </p>
                  </div>
                </div>
                {traffic.backends.length === 0 ? (
                  <div
                    style={{
                      padding: '32px 0',
                      textAlign: 'center',
                      color: 'var(--text-tertiary)',
                      fontSize: '0.875rem',
                    }}
                  >
                    {t('Keine Daten')}
                  </div>
                ) : (
                  <dl className="detail-grid">
                    <div>
                      <dt>{t('Anfragen')}</dt>
                      <dd>{formatCount(locale, traffic.backends[0].requests)}</dd>
                    </div>
                    <div>
                      <dt>{t('Übertragen')}</dt>
                      <dd>{formatBytes(locale, traffic.backends[0].bytes)}</dd>
                    </div>
                    <div>
                      <dt>{t('Erfolgreich (2xx)')}</dt>
                      <dd>{formatCount(locale, traffic.backends[0].http2xx)}</dd>
                    </div>
                    <div>
                      <dt>{t('Weitergeleitet (3xx)')}</dt>
                      <dd>{formatCount(locale, traffic.backends[0].http3xx)}</dd>
                    </div>
                    <div>
                      <dt>{t('Anfragefehler (4xx)')}</dt>
                      <dd>{formatCount(locale, traffic.backends[0].http4xx)}</dd>
                    </div>
                    <div>
                      <dt>{t('Serverfehler (5xx)')}</dt>
                      <dd>{formatCount(locale, traffic.backends[0].http5xx)}</dd>
                    </div>
                  </dl>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Die Dienste des Zeitraums.
 *
 * Aus der Zeitreihe und nicht aus der laufenden Konfiguration: ein Dienst, der
 * gestern gelöscht wurde, hatte gestern Verkehr, und man soll ihn ansehen
 * können. Ein Klick setzt `scope` und lädt beide Hälften neu.
 */
function ServiceTable({
  services,
  onSelect,
  hours,
}: {
  services: StatsResponse['services'];
  onSelect: (scope: string) => void;
  hours: number;
}) {
  const { t, plural } = useT();
  if (services.length === 0) {
    return (
      <div className="empty-state">
        <BarChart3 size={40} />
        <h3>{t('Noch keine Messwerte')}</h3>
        <p>
          {t(
            'Die Zeitreihe wird jede Minute erfasst. Nach dem Start von HAPM steht der erste Punkt nach zwei Runden: eine einzelne Probe ist ein Zählerstand, kein Zeitraum.'
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="card sys-block">
      <div className="card-header">
        <div>
          <h3 className="card-title">{t('Dienste')}</h3>
          <p className="card-subtitle">
            {plural(hours, {
              one: 'Anfragen der letzten Stunde, je Backend. Ein Klick öffnet die Auswertung dieses Dienstes.',
              other: 'Anfragen der letzten {count} Stunden, je Backend. Ein Klick öffnet die Auswertung dieses Dienstes.',
            })}
          </p>
        </div>
      </div>
      <BarList
        items={services.map((service) => ({
          key: `${service.serverId}|${service.scope}`,
          label: service.scope,
          title: service.scope,
          value: service.requests,
        }))}
        onSelect={(key) => onSelect(key.slice(key.indexOf('|') + 1))}
      />
    </div>
  );
}
