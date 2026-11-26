'use client';

import { Suspense, useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Ban, CheckCircle2, LayoutDashboard, ListChecks, Loader2, Power, RefreshCw, ScrollText } from 'lucide-react';
import PageHeading from '@/components/PageHeading';
import { SkeletonRows } from '@/components/Skeleton';
import AreaTabs, { useArea, type Area } from '@/components/AreaTabs';
import BrandLogo from '@/components/BrandLogo';
import OverviewPanel from '@/components/crowdsec/OverviewPanel';
import DecisionsPanel from '@/components/crowdsec/DecisionsPanel';
import AllowlistPanel from '@/components/crowdsec/AllowlistPanel';
import AlertsPanel, { WINDOWS, type AlertWindow } from '@/components/crowdsec/AlertsPanel';
import RulesPanel from '@/components/crowdsec/RulesPanel';
import { useCrowdsecData } from '@/components/crowdsec/useCrowdsecData';
import { useCrowdsecSwitch } from '@/components/crowdsec/CrowdsecSwitch';
import type { CrowdsecOverview } from '@/components/crowdsec/types';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Reverse-Proxy → CrowdSec: die WAF und die Sperren.
 *
 * Fünf Reiter, die Wahl in der Adresse (`?bereich=`). Die Karte eines Ziels
 * verweist mit `?bereich=ereignisse&ziel=<id>` direkt auf dessen Ereignisse.
 * Ob CrowdSec ein Ziel prüft, steht in `haproxy.cfg` (Schalter für alle hier,
 * je Ziel im Dialog des Ziels); Sperren, Freigaben, Ereignisse und Regeln
 * kommen aus CrowdSec selbst (`lib/crowdsec/`, docs/crowdsec.md).
 */

type Key = 'uebersicht' | 'sperren' | 'freigaben' | 'ereignisse' | 'regeln';

const AREAS: Area<Key>[] = [
  { key: 'uebersicht', label: msgid('Übersicht'), icon: LayoutDashboard },
  { key: 'sperren', label: msgid('Sperrliste'), icon: Ban },
  { key: 'freigaben', label: msgid('Freigaben'), icon: CheckCircle2 },
  { key: 'ereignisse', label: msgid('Ereignisse'), icon: ScrollText },
  { key: 'regeln', label: msgid('Regeln'), icon: ListChecks },
];

export default function CrowdsecPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <CrowdsecView />
    </Suspense>
  );
}

function CrowdsecView() {
  const { t } = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [area, select] = useArea(AREAS, '/reverse-proxy/crowdsec');
  const overview = useCrowdsecData<CrowdsecOverview>('/api/crowdsec', 30_000);
  const [refreshing, setRefreshing] = useState(false);
  const power = useCrowdsecSwitch(() => void overview.reload());

  const [period, setPeriod] = useState<AlertWindow>(() => {
    const wanted = searchParams.get('zeitraum');
    return (WINDOWS as readonly string[]).includes(wanted ?? '') ? (wanted as AlertWindow) : '24h';
  });
  const [target, setTarget] = useState<string | null>(() => searchParams.get('ziel'));

  const chooseTarget = useCallback(
    (next: string | null) => {
      setTarget(next);
      const params = new URLSearchParams({ bereich: 'ereignisse' });
      if (next) params.set('ziel', next);
      router.replace(`/reverse-proxy/crowdsec?${params.toString()}`, { scroll: false });
    },
    [router]
  );

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([overview.reload(), new Promise((resolve) => setTimeout(resolve, 400))]);
    } finally {
      setRefreshing(false);
    }
  }

  const data = overview.data;
  const inStack = data?.status.inStack ?? true;

  return (
    <>
      <div className="page-header">
        <PageHeading
          icon={<BrandLogo brand="crowdsec" size={22} />}
          title="CrowdSec"
          back={{ label: t('Übersicht'), href: '/reverse-proxy' }}
          note={t('WAF, Sperren und Freigaben')}
        />
        <div className="page-actions">
          {inStack && data && (
            <button className="btn btn-ghost" onClick={() => power.ask(false)} disabled={power.busy}>
              {power.busy ? <Loader2 size={16} className="spin" /> : <Power size={16} />}
              {t('CrowdSec abschalten')}
            </button>
          )}
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
        </div>
      </div>

      {overview.error && !data && <div className="alert alert-danger sys-block">{overview.error}</div>}

      {inStack && <AreaTabs areas={AREAS} value={area} onChange={select} />}

      {!data ? (
        overview.loading ? <SkeletonRows /> : null
      ) : area === 'uebersicht' || !inStack ? (
        <OverviewPanel data={data} onChanged={() => void overview.reload()} />
      ) : area === 'sperren' ? (
        <DecisionsPanel onFreed={() => void overview.reload()} />
      ) : area === 'freigaben' ? (
        <AllowlistPanel client={data.client} />
      ) : area === 'ereignisse' ? (
        <AlertsPanel
          period={period}
          onPeriod={setPeriod}
          target={target}
          onTarget={chooseTarget}
          targets={data.protection.targets}
        />
      ) : (
        <RulesPanel />
      )}
    </>
  );
}
