'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Loader2,
  Power,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Users,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { startRun, subscribeRunFinished } from '@/components/runs/runs';
import { useCrowdsecSwitch } from './CrowdsecSwitch';
import BrandLogo from '@/components/BrandLogo';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { MISSING, formatDateTime, formatNumber, formatRelative, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useNow } from '@/components/useNow';
import type { CrowdsecOverview, CrsMode } from './types';

const CRS_LABELS: Record<CrsMode, string> = {
  off: msgid('Aus'),
  block: msgid('An'),
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
    const unhealthy = info.health === 'unhealthy';
    return (
      <span className={`badge-status ${unhealthy ? 'badge-warning' : 'badge-success'}`}>
        <span className="dot" />
        {t(unhealthy ? 'Läuft, antwortet nicht' : 'Läuft')}
      </span>
    );
  }
  return (
    <span className="badge-status badge-danger">
      <span className="dot" />
      {t(info.status === 'restarting' ? 'Startet neu' : 'Gestoppt')}
    </span>
  );
}

/**
 * Der erste Reiter. Links schmal, was kurz ist (Status, Zahlen, System), rechts
 * breit, was mit den Zielen wächst: die geschützten Ziele mit dem Schalter für
 * alle im Kopf der Karte. Der Schalter schreibt `haproxy.cfg` über denselben Vorgang
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

  // Das Ende des Laufs meldet die gemeinsame Mechanik (`startRun`), auch wenn
  // dieser Reiter inzwischen verlassen ist. Hier wird danach nur neu gelesen.
  useEffect(() => {
    if (!pendingRun) return;
    return subscribeRunFinished((run) => {
      if (run.kind !== 'haproxy' || run.id !== pendingRun) return;
      setPendingRun(null);
      onChanged();
    });
  }, [pendingRun, onChanged]);

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
    startRun({
      kind: 'haproxy',
      id: result.data.runId,
      label: t('CrowdSec für alle Ziele'),
      context: on ? t('Einschalten') : t('Ausschalten'),
    });
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
    if (status.missing === 'disabled') return <DisabledState onChanged={onChanged} />;
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
  const all = protection.global === true;
  const checked = protection.services.length;
  const switchLocked = protection.global === null || !!pendingRun || !protection.readable;
  const eventsOf = (id: string) => `/reverse-proxy/crowdsec?bereich=ereignisse&ziel=${encodeURIComponent(id)}`;

  // Was CrowdSec gerade tut, in einem Wort und einem Satz.
  const state: { cls: string; label: string; line: string } = down
    ? { cls: 'badge-danger', label: t('Läuft nicht'), line: t('Anfragen gehen ungeprüft durch.') }
    : !protection.readable
      ? { cls: 'badge-warning', label: t('Unbekannt'), line: t('Die HAProxy-Konfiguration ist nicht lesbar.') }
      : all
        ? {
            cls: 'badge-success',
            label: t('Aktiv'),
            line: plural(protection.total, { one: 'Prüft das eine Ziel.', other: 'Prüft alle {count} Ziele.' }),
          }
        : checked > 0
          ? {
              cls: 'badge-success',
              label: t('Aktiv'),
              line: t('Prüft {count} von {total} Zielen.', {
                count: formatNumber(locale, checked),
                total: formatNumber(locale, protection.total),
              }),
            }
          : protection.inUse
            ? { cls: 'badge-success', label: t('Aktiv'), line: t('Eingebunden über einen eigenen Block in haproxy.cfg.') }
            : { cls: 'badge-neutral', label: t('Prüft nichts'), line: t('Läuft, aber kein Ziel ist eingeschaltet.') };

  const count = (value: number | null) => (value === null ? MISSING : formatNumber(locale, value));

  return (
    <div className="hapm-fit">
      {down && (
        <div className="alert alert-warning sys-block hapm-flag">
          <AlertTriangle size={16} />
          <div className="hapm-flag-body">
            <strong>{t('CrowdSec läuft nicht vollständig.')}</strong>
            <span>
              {t(
                'Solange CrowdSec oder der Bouncer fehlt, gehen alle Anfragen ungeprüft durch. Mehr sagt der Reiter „CrowdSec“ unter Logs.'
              )}
            </span>
          </div>
        </div>
      )}

      <div className="hapm-side-main sys-block">
        <div className="hapm-side">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                {t('Status')}
                <InfoHint
                  text={t(
                    'CrowdSec prüft jede Anfrage an ein geschütztes Ziel auf bekannte Angriffe und lehnt sie mit 403 ab (WAF). Es liest das Log von HAProxy und sperrt Adressen, die scannen oder raten. Dazu sperrt es Adressen, die anderen CrowdSec-Installationen aufgefallen sind (Gemeinschaftsliste).'
                  )}
                />
              </h2>
              <span className={`badge-status ${state.cls}`}>
                <span className="dot" />
                {state.label}
              </span>
            </div>
            <p className="cs-state-line">{state.line}</p>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">{t('Statistik')}</h2>
              <Link className="btn btn-ghost btn-sm" href="/reverse-proxy/statistiken?ansicht=crowdsec">
                {t('Verlauf')}
                <ArrowRight size={14} />
              </Link>
            </div>
            <div className="dash-kv cs-kv">
              <div className="dash-kv-row">
                <span className="dash-kv-label">
                  <ShieldAlert size={14} /> {t('WAF-Treffer (24 h)')}
                </span>
                <span className="dash-kv-value">{count(summary.waf24h)}</span>
              </div>
              <div className="dash-kv-row">
                <span className="dash-kv-label">
                  <ScrollText size={14} /> {t('Ereignisse (24 h)')}
                </span>
                <span className="dash-kv-value">{count(summary.alerts24h)}</span>
              </div>
              <div className="dash-kv-row">
                <span className="dash-kv-label">
                  <Ban size={14} /> {t('Aktive Sperren')}
                </span>
                <span className="dash-kv-value">{count(summary.activeDecisions)}</span>
              </div>
              <div className="dash-kv-row">
                <span className="dash-kv-label">
                  <Users size={14} /> {t('Gemeinschaftsliste')}
                  <InfoHint
                    text={t(
                      'Adressen, die bei vielen CrowdSec-Installationen aufgefallen sind. CrowdSec bezieht sie von seiner Zentrale und sperrt sie vorab. Eine neue Installation bekommt die Liste erst nach einiger Zeit: 0 ist am Anfang normal.'
                    )}
                  />
                </span>
                <span className="dash-kv-value">{count(summary.communityBlocklist)}</span>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2 className="card-title">{t('System')}</h2>
            </div>
            <div className="dash-kv cs-kv">
              <div className="dash-kv-row">
                <span className="dash-kv-label">
                  <BrandLogo brand="crowdsec" size={14} /> CrowdSec
                </span>
                <span className="dash-kv-value cs-kv-badge">
                  {status.version && <span className="hapm-muted">v{status.version}</span>}
                  <ContainerBadge info={status.crowdsec} label="hapm-crowdsec" />
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
                <span className="dash-kv-value mono cs-kv-wrap">{data.client}</span>
              </div>
              {status.crowdsec?.startedAt && (
                <div className="dash-kv-row">
                  <span className="dash-kv-label">{t('Läuft seit')}</span>
                  <span className="dash-kv-value">{formatDateTime(locale, status.crowdsec.startedAt)}</span>
                </div>
              )}
            </div>
            {status.error && <div className="alert alert-warning">{status.error}</div>}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                {t('Geschützte Ziele')}
                {protection.readable && <span className="section-count">{formatNumber(locale, checked)}</span>}
              </h2>
              <p className="card-subtitle">{t('Die Ziele, deren Anfragen CrowdSec prüft.')}</p>
            </div>
            <div className="cs-all-switch">
              {pendingRun && <Loader2 size={14} className="spin" />}
              <span className="cs-all-switch-label">{t('Alle Ziele prüfen')}</span>
              <InfoHint
                text={t(
                  'Steht im HTTPS-Frontend von HAProxy und gilt damit auch für Ziele, die später dazukommen. Ohne den Schalter prüft CrowdSec nur Ziele, bei denen es im Dialog des Ziels eingeschaltet ist.'
                )}
              />
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={all}
                  disabled={switchLocked}
                  onChange={(e) => askGlobal(e.target.checked)}
                  aria-label={t('Alle Ziele prüfen')}
                />
                <span className="toggle-slider" />
              </label>
            </div>
          </div>

          {!protection.readable ? (
            <div className="alert alert-danger">{t('Die HAProxy-Konfiguration ist nicht lesbar.')}</div>
          ) : protection.global === null ? (
            <div className="alert alert-warning">
              <AlertTriangle size={16} />
              <span>{t('Der Block „# CrowdSec“ in haproxy.cfg ist von Hand geändert. Der Schalter ist deshalb gesperrt.')}</span>
            </div>
          ) : pendingRun ? (
            <div className="alert alert-info">
              <Loader2 size={16} className="spin" />
              <span>{t('Wird übernommen. HAProxy wird neu geladen.')}</span>
            </div>
          ) : all && checked > 0 ? (
            /* Woher der Schutz kommt, steht einmal über der Liste und nicht in jeder Zeile. */
            <div className="alert alert-success">
              <ShieldCheck size={16} />
              <span>{t('„Alle Ziele prüfen“ ist an: CrowdSec prüft jedes Ziel, auch jedes neue.')}</span>
            </div>
          ) : null}

          {checked > 0 ? (
            <div className="table-wrap">
              <table className="table cs-targets">
                <thead>
                  <tr>
                    <th>{t('Ziel')}</th>
                    <th aria-label={t('Aktionen')} />
                  </tr>
                </thead>
                <tbody>
                  {protection.services.map((service) => (
                    <tr key={service.id}>
                      <td data-label="primary">
                        <span className="cs-target">
                          <ShieldCheck size={16} className="cs-target-icon" />
                          <span className="cs-target-name">
                            <strong>{service.domains[0] ?? service.id}</strong>
                            {service.domains.length > 1 && (
                              <span className="detail-sub">{service.domains.slice(1).join(', ')}</span>
                            )}
                          </span>
                        </span>
                      </td>
                      <td data-label="actions">
                        <div className="actions hapm-actions-end">
                          {/* Nur wo es etwas sagt: ohne den Schalter für alle hat jedes Ziel der Liste einen eigenen. */}
                          {all && service.own && (
                            <span
                              className="badge-status badge-neutral"
                              data-tooltip={t('Am Ziel selbst eingeschaltet. Bleibt geprüft, auch wenn der Schalter für alle aus ist.')}
                            >
                              {t('Eigener Schalter')}
                            </span>
                          )}
                          <Link
                            className="btn btn-ghost btn-sm cs-target-link"
                            href={eventsOf(service.id)}
                            aria-label={t('Ereignisse von {target}', { target: service.domains[0] ?? service.id })}
                          >
                            <ScrollText size={14} />
                            <span>{t('Ereignisse')}</span>
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : protection.readable && protection.total === 0 ? (
            <div className="empty-state">
              <ShieldOff size={36} />
              <h3>{t('Noch kein Ziel')}</h3>
              <p>{t('Sobald es Ziele gibt, stehen hier die, die CrowdSec prüft.')}</p>
              <Link className="btn btn-secondary" href="/reverse-proxy">
                {t('Zu den Zielen')}
              </Link>
            </div>
          ) : protection.readable && !protection.inUse ? (
            <div className="empty-state">
              <ShieldOff size={36} />
              <h3>{t('Kein Ziel wird geschützt')}</h3>
              <p>{t('Oben „Alle Ziele prüfen“ einschalten, oder CrowdSec im Dialog eines Ziels.')}</p>
            </div>
          ) : null}

          {!all && checked > 0 && checked < protection.total && (
            <p className="form-hint">
              {plural(protection.total - checked, {
                one: '{count} weiteres Ziel prüft CrowdSec nicht.',
                other: '{count} weitere Ziele prüft CrowdSec nicht.',
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}


/** In der Oberfläche abgeschaltet: hier und unter System, Allgemein wieder einschalten. */
function DisabledState({ onChanged }: { onChanged: () => void }) {
  const { t } = useT();
  const power = useCrowdsecSwitch(onChanged);
  return (
    <div className="empty-state sys-block">
      <BrandLogo brand="crowdsec" size={40} />
      <h3>{t('CrowdSec ist abgeschaltet')}</h3>
      <p>
        {t(
          'Kein Ziel wird geprüft, und beide Container stehen. Sperren, Freigaben und Regeln sind gespeichert und gelten wieder, sobald CrowdSec läuft.'
        )}
      </p>
      <button className="btn btn-primary" onClick={() => power.ask(true)} disabled={power.busy}>
        {power.busy ? <Loader2 size={16} className="spin" /> : <Power size={16} />}
        {t('CrowdSec einschalten')}
      </button>
    </div>
  );
}
