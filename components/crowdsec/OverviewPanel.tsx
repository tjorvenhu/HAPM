'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Ban, Globe, Loader2, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { openRun } from '@/components/runs/runs';
import BrandLogo from '@/components/BrandLogo';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { formatDateTime, formatNumber, formatRelative, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useNow } from '@/components/useNow';
import type { CrowdsecOverview, CrsMode } from './types';

const CRS_LABELS: Record<CrsMode, string> = {
  off: msgid('Aus'),
  detect: msgid('Nur melden'),
  block: msgid('Treffer sperren'),
};

function ContainerBadge({ info, label }: { info: CrowdsecOverview['status']['crowdsec']; label: string }) {
  const { t } = useT();
  if (!info) {
    return (
      <span className="badge-status badge-danger" data-tooltip={t('Den Container {name} gibt es nicht.', { name: label })}>
        <span className="dot" />
        {t('Fehlt')}
      </span>
    );
  }
  if (info.running) {
    return (
      <span className={`badge-status ${info.health === 'unhealthy' ? 'badge-warning' : 'badge-success'}`}>
        <span className="dot" />
        {t('Läuft')}
      </span>
    );
  }
  return (
    <span className="badge-status badge-danger" data-tooltip={info.status}>
      <span className="dot" />
      {t(info.status === 'restarting' ? 'Startet neu' : 'Gestoppt')}
    </span>
  );
}

/**
 * Der erste Reiter: läuft alles, welche Ziele prüft CrowdSec, und der Schalter
 * für alle Ziele. Der Schalter schreibt `haproxy.cfg` über denselben Vorgang
 * wie die Einstellungen (`/api/haproxy/settings`, `crowdsec`).
 */
export default function OverviewPanel({ data, onChanged }: { data: CrowdsecOverview; onChanged: () => void }) {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, plural, locale } = useT();
  const [pendingRun, setPendingRun] = useState<string | null>(null);
  const { status, summary, protection } = data;
  const now = useNow(30_000);

  useEffect(() => {
    if (!pendingRun) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      const body = await apiFetch(`/api/haproxy/runs/${pendingRun}`)
        .then((r) => r.json())
        .catch(() => null);
      if (cancelled || !body?.success || body.data.status === 'running') return;
      const ok = body.data.status === 'success';
      setPendingRun(null);
      onChanged();
      notify({
        variant: ok ? 'success' : 'error',
        title: t('CrowdSec für alle Ziele'),
        message: ok
          ? t('Durchgelaufen, HAProxy hat die neue Konfiguration übernommen.')
          : t('Nicht durchgelaufen. Der erste fehlgeschlagene Schritt steht im Protokoll.'),
        action: { label: t('Protokoll'), onClick: () => openRun({ kind: 'haproxy', id: pendingRun }) },
      });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pendingRun, apiFetch, notify, onChanged, t]);

  async function switchGlobal(on: boolean) {
    const res = await apiFetch('/api/haproxy/settings');
    const body = await res.json();
    const row = body?.data?.rows?.[0];
    if (!body.success || !row?.settings || !row.editable) {
      throw new Error(row?.error || t('Die Einstellungen von HAProxy lassen sich gerade nicht ändern.'));
    }
    const patch = await apiFetch('/api/haproxy/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serverId: row.$id,
        httpsLines: row.settings.httpsLines ?? [],
        adminIps: row.settings.adminIps,
        crowdsec: on,
      }),
    });
    const result = await patch.json();
    if (!patch.ok || !result.success) throw new Error(result.error || t('Speichern fehlgeschlagen'));
    setPendingRun(result.data.runId);
    openRun({ kind: 'haproxy', id: result.data.runId });
  }

  function askGlobal(on: boolean) {
    void confirm({
      title: on ? t('CrowdSec für alle Ziele einschalten?') : t('CrowdSec für alle Ziele ausschalten?'),
      message: on
        ? t(
            'HAProxy fragt danach für jede Anfrage an jedes Ziel bei CrowdSec nach, auch für die Oberfläche von HAPM. Eine WAF kann harmlose Anfragen fälschlich sperren. Die eigene Adresse lässt sich unter „Freigaben“ ausnehmen.'
          )
        : t('Danach prüft CrowdSec nur noch Ziele mit eigenem Schalter.'),
      confirmLabel: on ? t('Einschalten') : t('Ausschalten'),
      variant: on ? 'default' : 'warning',
      onConfirm: async () => {
        try {
          await switchGlobal(on);
        } catch (err) {
          notify({ variant: 'error', title: t('Speichern fehlgeschlagen'), message: err instanceof Error ? err.message : String(err) });
        }
      },
    });
  }

  if (!status.inStack) {
    return status.missing === 'not-installed' ? (
      <div className="empty-state sys-block">
        <BrandLogo brand="crowdsec" size={40} />
        <h3>{t('CrowdSec ist auf diesem Server noch nicht eingerichtet')}</h3>
        <p>
          {t(
            'Die Installation stammt von vor CrowdSec: ihre docker-compose.yml kennt die beiden Container noch nicht. Nachrüsten mit dem Installationsskript, es holt die neue Datei und startet CrowdSec mit. Daten und Einstellungen bleiben.'
          )}
        </p>
        <pre className="cs-command">sh /opt/hapm/install.sh</pre>
      </div>
    ) : (
      <div className="empty-state sys-block">
        <BrandLogo brand="crowdsec" size={40} />
        <h3>{t('CrowdSec ist bei dieser Installation abgeschaltet')}</h3>
        <p>
          {t(
            'Bei der Installation wurde CrowdSec abgewählt. Einschalten: die Zeile HAPM_CROWDSEC_OFF in der Datei .env neben docker-compose.yml entfernen und docker compose up -d ausführen, oder install.sh mit --crowdsec erneut starten.'
          )}
        </p>
        <pre className="cs-command">sh /opt/hapm/install.sh --crowdsec</pre>
      </div>
    );
  }

  const down = !status.crowdsec?.running || !status.bouncer?.running;

  return (
    <>
      {down && (
        <div className="alert alert-warning sys-block hapm-flag">
          <AlertTriangle size={16} />
          <div className="hapm-flag-body">
            <strong>{t('CrowdSec läuft nicht vollständig.')}</strong>
            <span>
              {t(
                'Solange CrowdSec oder der Bouncer fehlt, gehen alle Anfragen ungeprüft durch. Mehr sagt der Reiter „CrowdSec“ unter Reverse-Proxy, Logs.'
              )}
            </span>
          </div>
        </div>
      )}

      <div className="kpi-grid sys-block">
        <div className="kpi">
          <span className="kpi-icon"><Ban size={16} /></span>
          <div className="kpi-body">
            <span className="kpi-value">{summary.activeDecisions === null ? '–' : formatNumber(locale, summary.activeDecisions)}</span>
            <span className="kpi-label">{t('Aktive Sperren')}</span>
          </div>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><ShieldAlert size={16} /></span>
          <div className="kpi-body">
            <span className="kpi-value">{summary.waf24h === null ? '–' : formatNumber(locale, summary.waf24h)}</span>
            <span className="kpi-label">{t('WAF-Treffer in 24 Stunden')}</span>
          </div>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><AlertTriangle size={16} /></span>
          <div className="kpi-body">
            <span className="kpi-value">{summary.alerts24h === null ? '–' : formatNumber(locale, summary.alerts24h)}</span>
            <span className="kpi-label">{t('Ereignisse in 24 Stunden')}</span>
          </div>
        </div>
        <div className="kpi">
          <span className="kpi-icon"><Users size={16} /></span>
          <div className="kpi-body">
            <span className="kpi-value">
              {summary.communityBlocklist === null ? '–' : formatNumber(locale, summary.communityBlocklist)}
            </span>
            <span className="kpi-label">{t('Gemeinschaftsliste')}</span>
          </div>
        </div>
      </div>

      <div className="hapm-cols sys-block">
        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">{t('Welche Ziele CrowdSec prüft')}</h2>
              <p className="card-subtitle">
                {protection.global === true
                  ? t('Alle Ziele, über den Schalter für alle.')
                  : plural(protection.services.length, {
                      one: '{count} Ziel mit eigenem Schalter.',
                      other: '{count} Ziele mit eigenem Schalter.',
                    })}
              </p>
            </div>
          </div>
          <div className="card-body">
            <div className="form-subsection-head">
              <div>
                <div className="form-label-row">
                  <div className="form-section-title">{t('Alle Ziele prüfen')}</div>
                  <InfoHint
                    text={t(
                      'Steht im HTTPS-Frontend von HAProxy und gilt damit auch für Ziele, die später dazukommen. Ohne den Schalter prüft CrowdSec nur Ziele, bei denen es im Dialog des Ziels eingeschaltet ist.'
                    )}
                  />
                </div>
                <div className="form-section-sub">
                  {!protection.readable
                    ? t('Die HAProxy-Konfiguration ist nicht lesbar.')
                    : protection.global === null
                    ? t('Der Block „# CrowdSec“ in haproxy.cfg ist von Hand geändert und wird nicht angefasst.')
                    : pendingRun
                      ? t('Wird übernommen.')
                      : t(protection.global ? 'An. Jede Anfrage geht durch CrowdSec.' : 'Aus.')}
                </div>
              </div>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={protection.global === true}
                  disabled={protection.global === null || !!pendingRun || !protection.readable}
                  onChange={(e) => askGlobal(e.target.checked)}
                  aria-label={t('Alle Ziele prüfen')}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            {pendingRun && (
              <p className="form-hint">
                <Loader2 size={14} className="spin" /> {t('HAProxy wird neu geladen.')}
              </p>
            )}
          </div>
          {protection.services.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('Ziel')}</th>
                    <th>{t('Geprüft über')}</th>
                    <th aria-label={t('Aktionen')} />
                  </tr>
                </thead>
                <tbody>
                  {protection.services.map((service) => (
                    <tr key={service.id}>
                      <td data-label="primary">
                        <strong>{service.domains[0] ?? service.id}</strong>
                        {service.domains.length > 1 && <div className="detail-sub">{service.domains.slice(1).join(', ')}</div>}
                      </td>
                      <td data-label={t('Geprüft über')}>
                        {service.own ? t('Eigener Schalter') : t('Schalter für alle')}
                      </td>
                      <td data-label="actions">
                        <div className="actions hapm-actions-end">
                          <Link
                            className="btn btn-ghost btn-sm"
                            href={`/reverse-proxy/crowdsec?bereich=ereignisse&ziel=${encodeURIComponent(service.id)}`}
                          >
                            {t('Ereignisse')}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {protection.services.length === 0 && protection.global !== true && (
            <p className="form-hint">
              {t('Noch kein Ziel. Einschalten lässt es sich hier für alle oder im Dialog eines Ziels unter „CrowdSec (WAF)“.')}
            </p>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{t('Zustand')}</h2>
          </div>
          <div className="dash-kv">
            <div className="dash-kv-row">
              <span className="dash-kv-label">
                <BrandLogo brand="crowdsec" size={14} /> CrowdSec
              </span>
              <span className="dash-kv-value">
                <ContainerBadge info={status.crowdsec} label="hapm-crowdsec" /> {status.version ? `v${status.version}` : ''}
              </span>
            </div>
            <div className="dash-kv-row">
              <span className="dash-kv-label">{t('Bouncer für HAProxy')}</span>
              <span className="dash-kv-value">
                <ContainerBadge info={status.bouncer} label="hapm-crowdsec-bouncer" />
              </span>
            </div>
            <div className="dash-kv-row">
              <span className="dash-kv-label">{t('Lokale API')}</span>
              <span className="dash-kv-value">
                {status.lapi === null ? t('Unbekannt') : status.lapi ? t('Antwortet') : t('Antwortet nicht')}
              </span>
            </div>
            <div className="dash-kv-row">
              <span className="dash-kv-label">{t('Bouncer angemeldet')}</span>
              <span className="dash-kv-value">
                {status.bouncerRegistered === null
                  ? t('Unbekannt')
                  : status.bouncerRegistered
                    ? status.bouncerLastPull
                      ? t('Ja, zuletzt {ago}', { ago: formatRelative(locale, now, status.bouncerLastPull) })
                      : t('Ja')
                    : t('Nein. HAPM holt das in den nächsten Minuten nach.')}
              </span>
            </div>
            <div className="dash-kv-row">
              <span className="dash-kv-label">{t('OWASP-Regeln')}</span>
              <span className="dash-kv-value">{t(CRS_LABELS[data.crs])}</span>
            </div>
            <div className="dash-kv-row">
              <span className="dash-kv-label">{t('Eigene Adresse')}</span>
              <span className="dash-kv-value mono">{data.client}</span>
            </div>
            {status.crowdsec?.startedAt && (
              <div className="dash-kv-row">
                <span className="dash-kv-label">{t('Läuft seit')}</span>
                <span className="dash-kv-value">{formatDateTime(locale, status.crowdsec.startedAt)}</span>
              </div>
            )}
          </div>
          {status.error && <p className="form-hint">{status.error}</p>}
        </div>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <h2 className="card-title">{t('Was CrowdSec hier tut')}</h2>
        </div>
        <div className="kind-grid">
          <div className="kind-card">
            <span className="kind-card-icon"><ShieldCheck size={17} /></span>
            <span className="kind-card-text">
              <span className="kind-card-title">{t('WAF')}</span>
              <span className="kind-card-sub">{t('Prüft jede Anfrage auf bekannte Angriffe und lehnt sie mit 403 ab.')}</span>
            </span>
          </div>
          <div className="kind-card">
            <span className="kind-card-icon"><AlertTriangle size={17} /></span>
            <span className="kind-card-text">
              <span className="kind-card-title">{t('Erkennung im Log')}</span>
              <span className="kind-card-sub">{t('Liest das Log von HAProxy und sperrt Adressen, die scannen oder raten.')}</span>
            </span>
          </div>
          <div className="kind-card">
            <span className="kind-card-icon"><Globe size={17} /></span>
            <span className="kind-card-text">
              <span className="kind-card-title">{t('Gemeinschaftsliste')}</span>
              <span className="kind-card-sub">{t('Sperrt Adressen, die anderen CrowdSec-Installationen aufgefallen sind.')}</span>
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
