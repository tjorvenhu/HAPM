'use client';

import { useMemo, useState } from 'react';
import ErrorNote from '@/components/ErrorNote';
import Link from 'next/link';
import { AlertTriangle, Ban, Globe, ShieldAlert, Users } from 'lucide-react';
import Select from '@/components/Select';
import CountryFlag from '@/components/CountryFlag';
import { SkeletonRows } from '@/components/Skeleton';
import MetricChart, { ChartCard } from '@/components/systems/MetricChart';
import { BarList } from '@/ui/charts/BarList';
import { seriesColor, type ChartPoint, type ChartSeries } from '@/lib/systems/series';
import { countryName } from '@/lib/country-flags';
import { MISSING, formatNumber } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useCrowdsecData } from './useCrowdsecData';
import { WINDOWS, WINDOW_LABELS, type AlertWindow } from './AlertsPanel';
import type { CrowdsecStatsResponse } from './types';

/**
 * Statistik → CrowdSec. Gerechnet aus den Ereignissen eines Zeitraums
 * (`crowdsecStats` in `lib/crowdsec/data.ts`): je Stunde, bei mehr als drei
 * Tagen je Tag, nach Art getrennt. Dazu Ranglisten und die Zahl der aktiven
 * Sperren. Eine abgelehnte Anfrage einer schon gesperrten Adresse zählt
 * CrowdSec nicht als Ereignis, die Zahlen sind also Erkennungen, keine
 * Ablehnungen.
 */
export default function CrowdsecStats() {
  const { t, locale } = useT();
  const [period, setPeriod] = useState<AlertWindow>('24h');
  const { data, error, loading } = useCrowdsecData<CrowdsecStatsResponse>(`/api/crowdsec/stats?window=${period}`, 60_000);
  const stats = data?.stats;

  const series: ChartSeries[] = useMemo(
    () => [
      { key: 'waf', name: t('WAF-Treffer'), color: seriesColor(0) },
      { key: 'scenario', name: t('Szenarien'), color: seriesColor(1) },
      { key: 'manual', name: t('Von Hand'), color: seriesColor(2) },
    ],
    [t]
  );
  const points: ChartPoint[] = useMemo(
    () => (stats?.series ?? []).map((row) => ({ t: Date.parse(row.at), waf: row.waf, scenario: row.scenario, manual: row.manual })),
    [stats]
  );
  const format = useMemo(() => (value: number) => formatNumber(locale, value), [locale]);
  const number = (value: number | null | undefined) => (value === null || value === undefined ? MISSING : formatNumber(locale, value));

  return (
    <>
      <div className="cs-form sys-block">
        <div className="form-group">
          <label className="form-label" htmlFor="csStatsWindow">{t('Zeitraum')}</label>
          <Select<AlertWindow>
            id="csStatsWindow"
            value={period}
            onChange={setPeriod}
            options={WINDOWS.map((w) => ({ value: w, label: t(WINDOW_LABELS[w]) }))}
          />
        </div>
        <div className="cs-form-end">
          <Link className="btn btn-secondary" href="/reverse-proxy/crowdsec?bereich=ereignisse">
            {t('Zu den Ereignissen')}
          </Link>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block"><ErrorNote text={error} /></div>}
      {data?.truncated && (
        <div className="alert alert-info sys-block">
          {t('Im Zeitraum gab es mehr Ereignisse, als sich auswerten lassen. Die Zahlen sind eine Untergrenze und decken nur die neuesten ab.')}
        </div>
      )}

      {!stats ? (
        loading ? <SkeletonRows /> : null
      ) : (
        <>
          <div className="kpi-grid hapm-kpis-5 sys-block">
            <div className="kpi">
              <span className="kpi-icon"><AlertTriangle size={16} /></span>
              <div className="kpi-body">
                <span className="kpi-value">{number(stats.totals.alerts)}</span>
                <span className="kpi-label">{t('Ereignisse')}</span>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi-icon"><ShieldAlert size={16} /></span>
              <div className="kpi-body">
                <span className="kpi-value">{number(stats.totals.waf)}</span>
                <span className="kpi-label">{t('WAF-Treffer')}</span>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi-icon"><Users size={16} /></span>
              <div className="kpi-body">
                <span className="kpi-value">{number(stats.totals.sources)}</span>
                <span className="kpi-label">{t('Verschiedene Adressen')}</span>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi-icon"><Ban size={16} /></span>
              <div className="kpi-body">
                <span className="kpi-value">{number(data?.activeDecisions)}</span>
                <span className="kpi-label">{t('Aktive Sperren')}</span>
              </div>
            </div>
            <div className="kpi">
              <span className="kpi-icon"><Globe size={16} /></span>
              <div className="kpi-body">
                <span className="kpi-value">{number(data?.communityBlocklist)}</span>
                <span className="kpi-label">{t('Gemeinschaftsliste')}</span>
              </div>
            </div>
          </div>

          <div className="sys-block">
            <ChartCard
              title={stats.bucketMs >= 86_400_000 ? t('Ereignisse je Tag') : t('Ereignisse je Stunde')}
              info={t(
                'WAF-Treffer sind abgelehnte Anfragen mit einem bekannten Angriff. Szenarien sind Adressen, die im Log von HAProxy aufgefallen sind, meist mit Sperre. Von Hand sind Sperren aus HAPM oder cscli.'
              )}
            >
              <MetricChart
                data={points}
                series={series}
                format={format}
                rangeMs={Date.parse(stats.to) - Date.parse(stats.from)}
                bars
                integers
              />
            </ChartCard>
          </div>

          <div className="metrics-row sys-block">
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">{t('Szenarien')}</h3>
              </div>
              <BarList
                items={stats.scenarios.map((row) => ({ key: row.key, label: <span className="ranking-mono">{row.key}</span>, value: row.count }))}
                emptyText={t('Keine Daten')}
              />
            </div>
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">{t('Ziele')}</h3>
              </div>
              <BarList
                items={stats.targets.map((row) => ({ key: row.key, label: row.key, value: row.count }))}
                emptyText={t('Keine Daten')}
              />
            </div>
          </div>

          <div className="metrics-row sys-block">
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">{t('Länder')}</h3>
              </div>
              <BarList
                items={stats.countries.map((row) => ({
                  key: row.key,
                  value: row.count,
                  title: countryName(row.key, locale),
                  label: (
                    <span className="hapm-brand">
                      <CountryFlag code={row.key} /> {countryName(row.key, locale)}
                    </span>
                  ),
                }))}
                emptyText={t('Keine Daten')}
              />
            </div>
            <div className="card">
              <div className="card-header">
                <h3 className="card-title">{t('Adressen')}</h3>
              </div>
              <BarList
                items={stats.sources.map((row) => ({ key: row.key, label: <span className="ranking-mono">{row.key}</span>, value: row.count }))}
                emptyText={t('Keine Daten')}
              />
            </div>
          </div>

          <div className="card sys-block">
            <div className="card-header">
              <h3 className="card-title">{t('Pfade')}</h3>
            </div>
            <BarList
              items={stats.paths.map((row) => ({ key: row.key, label: <span className="ranking-mono">{row.key}</span>, value: row.count }))}
              emptyText={t('Keine Daten')}
            />
          </div>
        </>
      )}
    </>
  );
}
