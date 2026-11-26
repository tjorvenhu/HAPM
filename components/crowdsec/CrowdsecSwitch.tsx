'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import BrandLogo from '@/components/BrandLogo';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useT } from '@/lib/i18n/react';
import { openRun } from '@/components/runs/runs';
import type { CrowdsecOverview } from './types';

/**
 * CrowdSec ganz ab- und wieder einschalten (`setCrowdsecEnabled`). Abschalten
 * fragt vorher, weil es jedes Ziel betrifft und HAProxy neu lädt; danach lädt
 * die Sitzung neu, damit Seitenleiste und Seiten CrowdSec sofort ausblenden.
 */
export function useCrowdsecSwitch(onDone?: (enabled: boolean) => void) {
  const { apiFetch, reload } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  /**
   * Warten, bis der Lauf CrowdSec aus `haproxy.cfg` genommen hat und HAPM die
   * Container anhält. Gefragt wird der Zustand und nicht der Lauf: was zählt,
   * ist, ob die Datei CrowdSec noch nennt. Antwortet HAPM zwischendurch nicht
   * (HAProxy lädt neu), wird weitergefragt.
   */
  async function waitUntilSwitched(): Promise<boolean> {
    const deadline = Date.now() + 35 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const body = await apiFetch('/api/crowdsec', { cache: 'no-store' })
        .then((res) => res.json())
        .catch(() => null);
      const data = body?.success ? (body.data as CrowdsecOverview) : null;
      if (data && !data.status.switching) return !data.protection.inUse;
    }
    return false;
  }

  async function apply(enabled: boolean) {
    setBusy(true);
    try {
      const res = await apiFetch('/api/crowdsec', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.error || t('Speichern fehlgeschlagen'));
      if (body.data.pending && body.data.runId) {
        openRun({ kind: 'haproxy', id: body.data.runId, label: t('CrowdSec für alle Ziele'), context: t('Abschalten') });
        if (!(await waitUntilSwitched())) {
          throw new Error(t('HAProxy ließ sich nicht umstellen, CrowdSec bleibt an. Was gescheitert ist, steht unter Logs, Vorgänge.'));
        }
      }
      notify({
        variant: 'success',
        message: enabled
          ? t('CrowdSec ist wieder an. Welche Ziele es prüft, schalten Sie unter CrowdSec ein.')
          : t('CrowdSec ist abgeschaltet.'),
      });
      onDone?.(enabled);
    } catch (err) {
      notify({ variant: 'error', title: t('Umschalten fehlgeschlagen'), message: err instanceof Error ? err.message : String(err) });
    } finally {
      // Erst die Sitzung neu lesen, dann freigeben: sonst zeigt der Schalter kurz den alten Stand.
      await reload().catch(() => undefined);
      setBusy(false);
    }
  }

  function ask(enabled: boolean) {
    if (enabled) {
      void apply(true);
      return;
    }
    void confirm({
      title: t('CrowdSec ganz abschalten?'),
      message: t(
        'HAPM nimmt CrowdSec aus allen Zielen und aus der globalen Einstellung, lädt HAProxy neu und hält beide Container an. Danach prüft niemand mehr Anfragen, und CrowdSec verschwindet aus Übersicht, Logs, Statistik und Benachrichtigungen. Sperren, Freigaben und Regeln bleiben gespeichert. Wieder einschalten lässt es sich unter System, Allgemein.'
      ),
      confirmLabel: t('Abschalten'),
      variant: 'danger',
      onConfirm: () => apply(false),
    });
  }

  return { ask, busy };
}

/** Der Schalter unter System, Allgemein: dort bleibt er, auch wenn CrowdSec sonst überall ausgeblendet ist. */
export function CrowdsecSwitchCard() {
  const { session } = useApp();
  const { t } = useT();
  const enabled = session.features?.crowdsec === true;
  const { ask, busy } = useCrowdsecSwitch();

  return (
    <div className="card sys-block">
      <div className="card-header">
        <div>
          <h2 className="card-title">
            <BrandLogo brand="crowdsec" size={17} />
            {t('CrowdSec')}
            <InfoHint
              text={t(
                'Abgeschaltet nimmt HAPM CrowdSec aus jedem Ziel, hält beide Container an und blendet CrowdSec in der Oberfläche aus. Sperren, Freigaben und Regeln bleiben gespeichert. Eingeschaltet laufen die Container wieder, welche Ziele geprüft werden, stellen Sie danach unter Reverse-Proxy, CrowdSec ein.'
              )}
            />
          </h2>
          <p className="card-subtitle">{t('WAF und Sperren für die Ziele hinter HAProxy.')}</p>
        </div>
        <span className="cs-kinds">
          {busy && <Loader2 size={16} className="spin" />}
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy}
              onChange={(event) => ask(event.target.checked)}
              aria-label={t('CrowdSec verwenden')}
            />
            <span className="toggle-slider" />
          </label>
        </span>
      </div>
    </div>
  );
}
