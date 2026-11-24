'use client';

import { useEffect, useState, useCallback, type FormEvent } from 'react';
import Link from 'next/link';
import { Globe, Plus, Loader2, Trash2, KeyRound, ListTree, Info, ExternalLink } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import EntityCard, { EntityGrid, EntityField } from '@/components/EntityCard';
import ProviderName, { ProviderLogo } from '@/components/dns/ProviderName';
import { validateZoneName, normalizeDomain, type DnsProviderId } from '@/lib/dns/zones';
import { DNS_PROVIDER_INFOS, dnsProviderInfo } from '@/lib/dns/provider-info';
import { SkeletonCards } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';

/**
 * Die verwalteten Domains.
 *
 * Eine Karte je Zone, kein Tabellenblatt: es sind ein Dutzend Domains mit
 * Namen und zwei Attributen, und genau dafür gibt es `EntityCard`. Die Einträge
 * einer Zone sind die Detailseite — hier steht nur ihre Anzahl, und die kommt
 * live vom Anbieter der Zone.
 */

interface ZoneRow {
  $id: string;
  provider: DnsProviderId;
  name: string;
  zoneId: string;
  status: 'ok' | 'error';
  lastCheckedAt: string | null;
  lastError: string | null;
  /** `null` heißt unbekannt — die Zone war gerade nicht lesbar. Nicht null Einträge. */
  records: number | null;
}

function relative(iso: string | null, now: number): string {
  if (!iso) return 'nie';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'gerade eben';
  if (seconds < 3600) return `vor ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `vor ${Math.floor(seconds / 3600)} h`;
  return new Date(iso).toLocaleDateString('de-DE');
}

export default function DnsZonesPage() {
  const { apiFetch } = useApp();
  const confirm = useConfirm();
  const { notify } = useToast();
  const now = useNow(30_000);

  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  /** `null`, bis jemand wählt: eine Vorgabe hier wäre ein Token beim falschen Anbieter. */
  const [provider, setProvider] = useState<DnsProviderId | null>(null);
  const [name, setName] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  /** Die Zone, deren Token gerade ausgetauscht wird. */
  const [rotating, setRotating] = useState<ZoneRow | null>(null);
  const [newToken, setNewToken] = useState('');

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch('/api/dns/zones');
        const data = await res.json();
        if (data.success) setZones(data.data as ZoneRow[]);
        setError('');
      } catch {
        setError('Die Domains konnten nicht geladen werden.');
      } finally {
        setLoading(false);
      }
    },
    [apiFetch]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Eine Abfrage beim Anbieter je Zone und Takt. Deshalb 60 Sekunden und nicht
  // 30, dieselbe Rechnung wie bei der Reverse-Proxy-Übersicht.
  usePolling(() => load(true), 60_000);

  const nameError = name.trim() === '' ? null : validateZoneName(name);
  const chosen = provider ? dnsProviderInfo(provider) : null;

  function openModal() {
    setProvider(null);
    setName('');
    setApiToken('');
    setFormError('');
    setModalOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    const invalid = validateZoneName(name);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const res = await apiFetch('/api/dns/zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: chosen.id, name: normalizeDomain(name), apiToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Anlegen fehlgeschlagen');
      const added = data.data as { name: string; created: boolean; delegated: boolean | null };
      setModalOpen(false);
      setApiToken('');
      notify({
        variant: 'success',
        message: added.created
          ? `${added.name} ist eingerichtet.`
          : `${added.name} war schon eingerichtet. Der Zugang wurde ersetzt.`,
      });
      // Nur bei einem klaren Nein: `null` heißt, der Anbieter hat es noch nicht geprüft.
      if (added.delegated === false) {
        notify({
          variant: 'warning',
          title: 'Noch nicht delegiert',
          message:
            `Die Nameserver von ${added.name} zeigen nicht auf ${chosen.label}. ` +
            'Einträge wirken erst, wenn die Domain dorthin delegiert ist.',
        });
      }
      await load(true);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Anlegen fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate(e: FormEvent) {
    e.preventDefault();
    if (!rotating) return;
    setSaving(true);
    setFormError('');
    try {
      const res = await apiFetch(`/api/dns/zones/${rotating.$id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: newToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Speichern fehlgeschlagen');
      notify({ variant: 'success', message: `Der Token für ${rotating.name} ist ausgetauscht.` });
      setRotating(null);
      setNewToken('');
      await load(true);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(zone: ZoneRow) {
    await confirm({
      title: 'Domain aus der Verwaltung nehmen',
      message:
        `Bei ${dnsProviderInfo(zone.provider).label} passiert dabei nichts: die Zone ${zone.name} bleibt bestehen, ihre ` +
        `Einträge bleiben stehen, und alles, was darüber läuft, läuft weiter. Weg ist nur der ` +
        `Zugang von hier, auch der Haken im Reverse-Proxy-Dialog, der Einträge unter dieser ` +
        `Domain anlegt. Der API-Token wird dabei gelöscht.`,
      confirmLabel: 'Entfernen',
      variant: 'danger',
      onConfirm: async () => {
        const res = await apiFetch(`/api/dns/zones/${zone.$id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Entfernen fehlgeschlagen');
          throw new Error(data.error);
        }
        setError('');
        notify({ variant: 'success', message: `${zone.name} wird hier nicht mehr verwaltet.` });
        await load(true);
      },
    });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Domains</h1>
          <p className="page-subtitle">
            Die Domains, deren DNS hier verwaltet wird, bei Hetzner oder Cloudflare. Die Einträge
            stehen beim Anbieter und werden bei jedem Aufruf von dort gelesen. Es gibt hier keine
            Kopie, die veralten könnte.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openModal}>
            <Plus size={16} />
            Domain hinzufügen
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {loading ? (
        <SkeletonCards />
      ) : zones.length === 0 ? (
        <div className="empty-state">
          <Globe size={40} />
          <h3>Noch keine Domain</h3>
          <p>
            Zum Einrichten braucht es die Domain und einen API-Token ihres Anbieters, Hetzner oder
            Cloudflare, der die Einträge der Zone bearbeiten darf.
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
                  {zone.status === 'ok' ? 'Erreichbar' : 'Fehler'}
                </span>
              }
              actions={
                <>
                  <Link
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip="Einträge verwalten"
                    href={`/dns/${zone.$id}`}
                  >
                    <ListTree size={16} />
                  </Link>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip="API-Token austauschen"
                    onClick={() => {
                      setRotating(zone);
                      setNewToken('');
                      setFormError('');
                    }}
                  >
                    <KeyRound size={16} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip="Aus der Verwaltung nehmen"
                    onClick={() => handleDelete(zone)}
                  >
                    <Trash2 size={16} />
                  </button>
                </>
              }
            >
              <EntityField label="Anbieter">
                <ProviderName provider={zone.provider} />
              </EntityField>
              <EntityField label="Einträge">
                {/* „unbekannt" und nicht 0: eine Zone, deren Token abgelaufen
                    ist, hat keine null Einträge — sie ist gerade nicht lesbar. */}
                {zone.records === null ? 'unbekannt' : zone.records}
              </EntityField>
              <EntityField label="Zone-ID" mono>
                {zone.zoneId}
              </EntityField>
              <EntityField label="Zuletzt geprüft">{relative(zone.lastCheckedAt, now)}</EntityField>
              {zone.lastError && <EntityField label="Fehler">{zone.lastError}</EntityField>}
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
              <h2 className="modal-title">Domain hinzufügen</h2>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <div className="alert alert-danger sys-block">{formError}</div>}

                <div className="form-group">
                  <span className="form-label">Anbieter</span>
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
                      <label className="form-label">Domain</label>
                      <input
                        className="form-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="example.org"
                        autoComplete="off"
                        required
                      />
                      <span className="form-hint">
                        Ohne <code>https://</code>. Eingerichtet wird die Zone, in der sie liegt.
                      </span>
                      {nameError && <div className="alert alert-warning">{nameError}</div>}
                    </div>

                    <div className="form-group">
                      <label className="form-label">
                        API-Token
                        <InfoHint
                          text={
                            (chosen.tokenHint ? `${chosen.tokenHint} ` : '') +
                            'Er wird verschlüsselt gespeichert und verlässt den Server nicht.'
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
                            Token bei {chosen.label} anlegen <ExternalLink size={12} />
                          </a>
                        </span>
                      )}
                    </div>

                    <div className="form-note">
                      <Info size={14} />
                      <span>
                        Der Token wird sofort ausprobiert: die Kennung der Zone kommt aus der
                        Antwort von {chosen.label}. Findet er die Domain nicht, sagt die Meldung,
                        welche Zonen er stattdessen sieht.
                      </span>
                    </div>
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
                  Abbrechen
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || !chosen || !!nameError || apiToken.trim() === ''}
                >
                  {saving && <Loader2 size={16} className="spin" />}
                  Hinzufügen
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {rotating && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !saving && setRotating(null)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">API-Token für „{rotating.name}“</h2>
            </div>
            <form onSubmit={handleRotate}>
              <div className="modal-body">
                {formError && <div className="alert alert-danger sys-block">{formError}</div>}
                <div className="form-group">
                  <label className="form-label">
                    Neuer Token von {dnsProviderInfo(rotating.provider).label}
                  </label>
                  <input
                    className="form-input"
                    type="password"
                    value={newToken}
                    onChange={(e) => setNewToken(e.target.value)}
                    autoComplete="off"
                    required
                  />
                  <span className="form-hint">
                    Der bisherige Token wird ersetzt. Der neue muss dieselbe Zone sehen, sonst
                    wird er abgelehnt, und der alte bleibt stehen.
                  </span>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRotating(null)}
                  disabled={saving}
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || newToken.trim() === ''}
                >
                  {saving && <Loader2 size={16} className="spin" />}
                  Speichern
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
