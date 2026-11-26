'use client';

import { useEffect, useState, useCallback, type FormEvent } from 'react';
import ErrorNote from '@/components/ErrorNote';
import { Globe, Plus, Loader2, Trash2, KeyRound, Info, ExternalLink } from 'lucide-react';
import PageHeading from '@/components/PageHeading';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import EntityCard, { EntityGrid, EntityField } from '@/components/EntityCard';
import ProviderName, { ProviderLogo } from '@/components/dns/ProviderName';
import CredentialFields from '@/components/dns/CredentialFields';
import { validateZoneName, normalizeDomain, type DnsProviderId } from '@/lib/dns/zones';
import { DNS_PROVIDER_INFOS, accessFromInput, dnsProviderInfo, type DnsProviderInfo } from '@/lib/dns/provider-info';
import { PROVIDER_RULES } from '@/lib/dns/records';
import { SkeletonCards } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { formatRelative } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Die angebundenen Domains: der Zugang zum DNS-Anbieter, nicht ihre Einträge.
 *
 * HAPM schreibt nur, was es selbst braucht (den CNAME eines Ziels, den
 * Adress-Eintrag aus dem Assistenten). Alles andere verwaltet man beim
 * Anbieter, deshalb gibt es hier keine Liste der Einträge.
 *
 * Eine Karte je Zone: ein Dutzend Domains mit wenigen Angaben, genau dafür
 * gibt es `EntityCard`. Ob der Zugang funktioniert, prüft die Route bei jedem
 * Aufruf beim Anbieter.
 *
 * Der Zugang ist bei Cloudflare und Hetzner ein Token, bei einem eigenen
 * Nameserver (RFC 2136) und Infoblox sind es mehrere Angaben
 * (`DnsProviderInfo.form`). Beide Dialoge zeigen dann die Felder des Anbieters
 * (`CredentialFields`) statt des einen Token-Felds.
 */

/** Ob jedes Pflichtfeld etwas trägt. Was darin stehen darf, prüft `accessFromInput`. */
function filled(info: DnsProviderInfo, given: Record<string, string>): boolean {
  return info.fields.every((field) => !field.required || (given[field.name] ?? '').trim() !== '');
}

interface ZoneRow {
  $id: string;
  provider: DnsProviderId;
  name: string;
  zoneId: string;
  status: 'ok' | 'error';
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Ob die Nameserver auf den Anbieter zeigen. `null` heißt unbekannt. */
  delegated: boolean | null;
}

export default function DnsZonesPage() {
  const { apiFetch } = useApp();
  const confirm = useConfirm();
  const { notify } = useToast();
  const now = useNow(30_000);
  const { t, rich, locale } = useT();

  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  /** `null`, bis jemand wählt: eine Vorgabe hier wäre ein Token beim falschen Anbieter. */
  const [provider, setProvider] = useState<DnsProviderId | null>(null);
  const [name, setName] = useState('');
  const [apiToken, setApiToken] = useState('');
  /** Die Felder eines Anbieters mit mehreren Angaben, nach Namen. */
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  /** Die Zone, deren Zugang gerade ausgetauscht wird. */
  const [rotating, setRotating] = useState<ZoneRow | null>(null);
  const [newToken, setNewToken] = useState('');
  const [newValues, setNewValues] = useState<Record<string, string>>({});

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch('/api/dns/zones');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error);
        setZones(data.data as ZoneRow[]);
        setError('');
      } catch {
        setError(t('Die Domains konnten nicht geladen werden.'));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, t]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Eine Abfrage beim Anbieter je Zone und Takt. Deshalb 60 Sekunden und nicht
  // 30, dieselbe Rechnung wie bei der Reverse-Proxy-Übersicht.
  usePolling(() => load(true), 60_000);

  const nameError = name.trim() === '' ? null : validateZoneName(name);
  const chosen = provider ? dnsProviderInfo(provider) : null;
  const rotatingInfo = rotating ? dnsProviderInfo(rotating.provider) : null;

  function openModal() {
    setProvider(null);
    setName('');
    setApiToken('');
    setValues({});
    setFormError('');
    setModalOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    const invalid = validateZoneName(name);
    if (invalid) {
      setFormError(t(invalid));
      return;
    }
    // Dieselbe Prüfung wie in der Route.
    const access = accessFromInput(chosen.id, { token: apiToken, values });
    if ('error' in access) {
      setFormError(t(access.error));
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const res = await apiFetch('/api/dns/zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: chosen.id,
          name: normalizeDomain(name),
          ...(chosen.form ? { values } : { apiToken }),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Die Domain ließ sich nicht anbinden.'));
      const added = data.data as { name: string; created: boolean; delegated: boolean | null };
      setModalOpen(false);
      setApiToken('');
      setValues({});
      notify({
        variant: 'success',
        message: added.created
          ? t('{name} ist angebunden.', { name: added.name })
          : t('{name} war schon angebunden. Der Zugang wurde ersetzt.', { name: added.name }),
      });
      // Nur bei einem klaren Nein: `null` heißt, der Anbieter hat es noch nicht geprüft.
      if (added.delegated === false) {
        notify({
          variant: 'warning',
          title: t('Noch nicht delegiert'),
          message: t(
            'Die Nameserver von {name} zeigen nicht auf {provider}. Einträge wirken erst, wenn die Domain dorthin delegiert ist.',
            { name: added.name, provider: chosen.label }
          ),
        });
      }
      await load(true);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Anbinden fehlgeschlagen'),
        message: errorText(err, t('Die Domain ließ sich nicht anbinden.')),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate(e: FormEvent) {
    e.preventDefault();
    if (!rotating || !rotatingInfo) return;
    const access = accessFromInput(rotating.provider, { token: newToken, values: newValues });
    if ('error' in access) {
      notify({ variant: 'error', title: rotatingInfo.label, message: t(access.error) });
      return;
    }
    setSaving(true);
    try {
      const res = await apiFetch(`/api/dns/zones/${rotating.$id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rotatingInfo.form ? { values: newValues } : { apiToken: newToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Der Zugang ließ sich nicht austauschen.'));
      notify({ variant: 'success', message: t('Der Zugang für {name} ist ausgetauscht.', { name: rotating.name }) });
      setRotating(null);
      setNewToken('');
      setNewValues({});
      await load(true);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Der Zugang ließ sich nicht austauschen.')),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(zone: ZoneRow) {
    await confirm({
      title: t('Anbindung entfernen?'),
      message: t(
        'Bei {provider} ändert sich nichts: die Zone {zone} und ihre Einträge bleiben. HAPM legt danach für Ziele unter dieser Domain keinen DNS-Eintrag mehr an. Der gespeicherte Zugang wird entfernt.',
        { provider: dnsProviderInfo(zone.provider).label, zone: zone.name }
      ),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
      failedTitle: t('Entfernen fehlgeschlagen'),
      onConfirm: async () => {
        const res = await apiFetch(`/api/dns/zones/${zone.$id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || t('Die Anbindung ließ sich nicht entfernen.'));
        notify({ variant: 'success', message: t('{name} ist nicht mehr angebunden.', { name: zone.name }) });
        await load(true);
      },
    });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <PageHeading
            icon={<Globe size={20} />}
            title={
              <>
                {t('DNS')}
                <InfoHint
                  text={t(
                    'Mit dem Zugang legt HAPM den DNS-Eintrag eines Ziels an, und der Einrichtungsassistent den Eintrag der Oberfläche. Die übrigen Einträge verwalten Sie beim Anbieter.'
                  )}
                />
              </>
            }
            back={{ label: t('Ziele'), href: '/reverse-proxy' }}
          />
          <p className="page-subtitle">{t('Angebundene Domains und ihr Zugang zum DNS-Anbieter.')}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openModal}>
            <Plus size={16} />
            {t('Domain anbinden')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block"><ErrorNote text={error} /></div>}

      {/* Nach einem gescheiterten Abruf ist nicht bekannt, ob es Domains gibt:
          dann steht nur die Meldung da, nicht „Noch keine Domain angebunden“. */}
      {loading ? (
        <SkeletonCards />
      ) : zones.length === 0 && error ? null : zones.length === 0 ? (
        <div className="empty-state">
          <Globe size={40} />
          <h3>{t('Noch keine Domain angebunden')}</h3>
          <p>
            {t(
              'Dafür braucht es die Domain und den Zugang zu ihrer Zone: einen API-Token von Hetzner oder Cloudflare, einen TSIG-Schlüssel des eigenen Nameservers oder ein Konto bei Infoblox.'
            )}
          </p>
        </div>
      ) : (
        <EntityGrid>
          {zones.map((zone) => (
            <EntityCard
              key={zone.$id}
              icon={<Globe size={17} />}
              name={zone.name}
              badge={
                <span
                  className={`badge-status ${zone.status === 'ok' ? 'badge-success' : 'badge-danger'}`}
                >
                  {zone.status === 'ok' ? t('Verbunden') : t('Fehler')}
                </span>
              }
              actions={
                <>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip={t('Zugang austauschen')}
                    aria-label={t('Zugang austauschen')}
                    onClick={() => {
                      setRotating(zone);
                      setNewToken('');
                      setNewValues({});
                    }}
                  >
                    <KeyRound size={16} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip={t('Anbindung entfernen')}
                    aria-label={t('Anbindung entfernen')}
                    onClick={() => handleDelete(zone)}
                  >
                    <Trash2 size={16} />
                  </button>
                </>
              }
            >
              <EntityField label={t('Anbieter')}>
                <ProviderName provider={zone.provider} />
              </EntityField>
              {/* Ein eigener Nameserver und eine Appliance sind selbst die Stelle,
                  die antwortet: wohin die Domain delegiert ist, sagen sie nicht.
                  Ihre Kennung nennt dafür, wen HAPM anspricht. */}
              {PROVIDER_RULES[zone.provider].listsZones ? (
                <>
                  <EntityField label={t('Nameserver')}>
                    {zone.delegated === null
                      ? t('Unbekannt')
                      : zone.delegated
                        ? t('Zeigen auf {provider}', { provider: dnsProviderInfo(zone.provider).label })
                        : t('Zeigen nicht auf {provider}', { provider: dnsProviderInfo(zone.provider).label })}
                  </EntityField>
                  <EntityField label={t('Zone-ID')} mono>
                    {zone.zoneId}
                  </EntityField>
                </>
              ) : (
                <EntityField label={zone.provider === 'infoblox' ? t('Appliance und View') : t('Primärer Nameserver')} mono>
                  {zone.zoneId}
                </EntityField>
              )}
              <EntityField label={t('Zuletzt geprüft')}>
                {zone.lastCheckedAt ? formatRelative(locale, now, zone.lastCheckedAt) : t('noch nie')}
              </EntityField>
              {zone.lastError && <EntityField label={t('Fehler')}>{zone.lastError}</EntityField>}
            </EntityCard>
          ))}
        </EntityGrid>
      )}

      {modalOpen && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !saving && setModalOpen(false)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('Domain anbinden')}</h2>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <div className="alert alert-danger sys-block"><ErrorNote text={formError} /></div>}

                <div className="form-group">
                  <span className="form-label">{t('Anbieter')}</span>
                  <div className="hapm-choices hapm-choices-row">
                    {DNS_PROVIDER_INFOS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`hapm-choice${provider === option.id ? ' is-selected' : ''}`}
                        aria-pressed={provider === option.id}
                        disabled={saving}
                        onClick={() => {
                          setProvider(option.id);
                          setFormError('');
                        }}
                      >
                        <ProviderLogo provider={option.id} size={28} />
                        <span className="hapm-choice-text">
                          <strong>{option.label}</strong>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {chosen && (
                  <>
                    <div className="form-group">
                      <label className="form-label">{t('Domain')}</label>
                      <input
                        className="form-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="example.org"
                        autoComplete="off"
                        required
                      />
                      <span className="form-hint">
                        {rich('Ohne {scheme}. Angebunden wird die Zone, in der sie liegt.', {
                          scheme: <code>https://</code>,
                        })}
                      </span>
                      {nameError && <div className="alert alert-warning">{t(nameError)}</div>}
                    </div>

                    {chosen.form ? (
                      <>
                        <CredentialFields
                          fields={chosen.fields}
                          values={values}
                          onChange={(field, value) => setValues((before) => ({ ...before, [field]: value }))}
                          skin="form"
                          idPrefix="dnsNew"
                          disabled={saving}
                        />
                        <div className="form-note">
                          <Info size={14} />
                          <span>
                            {t('Die Zugangsdaten werden beim Anbinden sofort geprüft und verschlüsselt gespeichert.')}
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="form-group">
                          <label className="form-label">
                            {t('API-Token')}
                            <InfoHint
                              text={
                                (chosen.tokenHint ? `${t(chosen.tokenHint)} ` : '') +
                                t('Er wird verschlüsselt gespeichert und verlässt den Server nicht.')
                              }
                            />
                          </label>
                          <input
                            className="form-input"
                            type="password"
                            value={apiToken}
                            onChange={(e) => setApiToken(e.target.value)}
                            autoComplete="off"
                            required
                          />
                          {chosen.consoleUrl && (
                            <span className="form-hint">
                              <a href={chosen.consoleUrl} target="_blank" rel="noreferrer">
                                {t('Token bei {provider} anlegen', { provider: chosen.label })} <ExternalLink size={12} />
                              </a>
                            </span>
                          )}
                        </div>

                        <div className="form-note">
                          <Info size={14} />
                          <span>
                            {t('Der Token wird beim Anbinden sofort bei {provider} geprüft.', { provider: chosen.label })}
                          </span>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                >
                  {t('Abbrechen')}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    saving ||
                    !chosen ||
                    !!nameError ||
                    name.trim() === '' ||
                    (chosen.form ? !filled(chosen, values) : apiToken.trim() === '')
                  }
                >
                  {saving && <Loader2 size={16} className="spin" />}
                  {t('Anbinden')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {rotating && rotatingInfo && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !saving && setRotating(null)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">
                {rotatingInfo.form
                  ? t('Zugangsdaten für „{name}“', { name: rotating.name })
                  : t('API-Token für „{name}“', { name: rotating.name })}
              </h2>
            </div>
            <form onSubmit={handleRotate}>
              <div className="modal-body">
                {rotatingInfo.form ? (
                  <>
                    <CredentialFields
                      fields={rotatingInfo.fields}
                      values={newValues}
                      onChange={(field, value) => setNewValues((before) => ({ ...before, [field]: value }))}
                      skin="form"
                      idPrefix="dnsRotate"
                      disabled={saving}
                    />
                    <div className="form-note">
                      <Info size={14} />
                      <span>
                        {t('Die bisherigen Zugangsdaten werden ersetzt, sobald die neuen die Zone erreichen.')}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="form-group">
                    <div className="form-label-row">
                      <label className="form-label" htmlFor="dnsNewToken">
                        {t('Neuer Token von {provider}', { provider: rotatingInfo.label })}
                      </label>
                      <InfoHint
                        text={t('Der neue Token muss dieselbe Zone sehen. Sonst wird er abgelehnt, und der bisherige bleibt stehen.')}
                      />
                    </div>
                    <input
                      id="dnsNewToken"
                      className="form-input"
                      type="password"
                      value={newToken}
                      onChange={(e) => setNewToken(e.target.value)}
                      autoComplete="off"
                      required
                    />
                    <span className="form-hint">{t('Der bisherige Token wird ersetzt.')}</span>
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRotating(null)}
                  disabled={saving}
                >
                  {t('Abbrechen')}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || (rotatingInfo.form ? !filled(rotatingInfo, newValues) : newToken.trim() === '')}
                >
                  {saving && <Loader2 size={16} className="spin" />}
                  {t('Speichern')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
