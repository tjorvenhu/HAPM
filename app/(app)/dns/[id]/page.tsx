'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Plus, Trash2, Pencil, Cloud, CloudOff, ListTree } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import RecordFormModal from '@/components/dns/RecordFormModal';
import ProviderName from '@/components/dns/ProviderName';
import { formatTtl, isEditableRecord, PROVIDER_RULES, type DnsRecord } from '@/lib/dns/records';
import { dnsProviderInfo } from '@/lib/dns/provider-info';
import type { DnsProviderId } from '@/lib/dns/zones';
import { SkeletonRows } from '@/components/Skeleton';

/**
 * Die Einträge einer Zone.
 *
 * Eine Tabelle und keine Karten: hier wird verglichen und gesucht (welcher Name
 * zeigt wohin), und das ist die Trennlinie aus docs/ui.md. Eine gewachsene Zone
 * hat hundert Zeilen.
 *
 * **Was hier steht, kommt bei jedem Takt vom Anbieter der Zone.** Deshalb ist
 * der Bestand auch dann aktuell, wenn jemand parallel dort arbeitet — und
 * deshalb kann eine Zeile hier nicht bearbeitbar sein, obwohl sie dasteht: was
 * dieses Formular nicht vollständig abbildet (SRV, CAA, ein vom Anbieter
 * gepflegter Eintrag), wird angezeigt und nicht angefasst.
 *
 * Eine Zeile ist ein Wert. Hetzner führt mehrere Werte desselben Namens als
 * einen Satz, hier stehen sie einzeln (`lib/dns/hetzner-rrsets.ts`).
 */

interface ZoneHead {
  $id: string;
  provider: DnsProviderId;
  name: string;
  zoneId: string;
  status: 'ok' | 'error';
  lastError: string | null;
}

export default function DnsZonePage() {
  const { apiFetch } = useApp();
  const confirm = useConfirm();
  const { notify } = useToast();
  const id = String(useParams().id ?? '');

  const [zone, setZone] = useState<ZoneHead | null>(null);
  const [records, setRecords] = useState<DnsRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  /** `null` heißt zu, `'new'` heißt anlegen, ein Eintrag heißt bearbeiten. */
  const [editing, setEditing] = useState<DnsRecord | 'new' | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch(`/api/dns/zones/${id}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Zone nicht lesbar');
        setZone(data.data.zone as ZoneHead);
        setRecords(data.data.records as DnsRecord[]);
        setError(data.data.zone.lastError ?? '');
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Zone nicht lesbar');
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, id]
  );

  useEffect(() => {
    if (id) load();
  }, [id, load]);

  // Eine Abfrage beim Anbieter je Takt. 60 Sekunden, weil sich eine Zone nicht
  // im Sekundentakt ändert — aber ohne Takt stünde eine Änderung von dort hier
  // bis zum nächsten F5 nicht drin, und genau das soll es nicht geben.
  usePolling(() => load(true), 60_000);

  const providerLabel = zone ? dnsProviderInfo(zone.provider).label : '';
  // Die Spalte gibt es nur, wo es die Frage gibt: bei Hetzner stünde in jeder
  // Zeile dieselbe Antwort.
  const withProxy = zone ? PROVIDER_RULES[zone.provider].proxy : false;

  const term = search.trim().toLowerCase();
  const visible = term
    ? records.filter(
        (r) =>
          r.name.toLowerCase().includes(term) ||
          r.content.toLowerCase().includes(term) ||
          r.type.toLowerCase() === term
      )
    : records;

  async function handleDelete(record: DnsRecord) {
    await confirm({
      title: 'Eintrag entfernen',
      message:
        `${record.type} ${record.name} → ${record.content} wird bei ${providerLabel} gelöscht. ` +
        `Was darüber aufgelöst wird, ist danach nicht mehr erreichbar, bei einem A- oder ` +
        `CNAME-Eintrag also die Adresse selbst.`,
      confirmLabel: 'Entfernen',
      variant: 'danger',
      onConfirm: async () => {
        const res = await apiFetch(`/api/dns/zones/${id}/records/${record.id}`, {
          method: 'DELETE',
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Entfernen fehlgeschlagen');
          throw new Error(data.error);
        }
        setError('');
        notify({ variant: 'success', message: `${record.type} ${record.name} ist entfernt.` });
        await load(true);
      },
    });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <Link className="btn btn-ghost btn-sm" href="/dns">
            <ArrowLeft size={16} />
            Domains
          </Link>
          <h1 className="page-title">{zone?.name ?? 'Zone'}</h1>
          <p className="page-subtitle">
            {zone ? (
              <>
                Die DNS-Einträge dieser Zone, gelesen bei <ProviderName provider={zone.provider} />.
                Änderungen wirken dort sofort.
              </>
            ) : (
              'Die DNS-Einträge dieser Zone.'
            )}
          </p>
        </div>
        <div className="page-actions">
          <input
            className="form-input"
            style={{ maxWidth: 220 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, Ziel oder Typ"
            autoComplete="off"
            aria-label="Einträge durchsuchen"
          />
          <button className="btn btn-primary" onClick={() => setEditing('new')} disabled={!zone}>
            <Plus size={16} />
            Eintrag anlegen
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {loading ? (
        <SkeletonRows />
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <ListTree size={40} />
          <h3>{records.length === 0 ? 'Keine Einträge' : 'Nichts gefunden'}</h3>
          <p>
            {records.length === 0
              ? 'In dieser Zone steht kein Eintrag, jedenfalls keiner, den der Token sehen darf.'
              : 'Für diese Suche gibt es keinen Eintrag.'}
          </p>
        </div>
      ) : (
        // Keine Mindestbreite und deshalb kein Querscrollen: Name und Wert
        // teilen sich, was die festen Spalten übrig lassen, und schneiden ab.
        // Ein TXT-Eintrag ist zweihundert Zeichen lang — ihn die Tabelle
        // breitziehen zu lassen, hieße bei jedem Blick auf die TTL zu scrollen.
        <div className="table-wrap">
          <table className="table sys-table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>Typ</th>
                <th style={{ width: '28%' }}>Name</th>
                <th>Wert</th>
                <th style={{ width: 80 }}>TTL</th>
                {withProxy && <th style={{ width: 110 }}>Proxy</th>}
                <th style={{ width: 90 }} />
              </tr>
            </thead>
            <tbody>
              {visible.map((record) => {
                const editable = isEditableRecord(record);
                // Die Priorität gehört zum Wert und bekommt keine eigene Spalte:
                // sie hat nur der MX-Eintrag, und eine Spalte, die bei
                // neunundzwanzig von dreißig Zeilen leer bleibt, kostet Breite
                // ohne etwas zu sagen.
                const value =
                  record.priority === null
                    ? record.content
                    : `${record.priority} ${record.content}`;
                return (
                  <tr key={record.id}>
                    <td>
                      <span className="badge-status badge-neutral">{record.type}</span>
                    </td>
                    {/* `sys-td-name` (max-width: 0) ist die Bedingung dafür,
                        dass eine Zelle in einer festen Tabelle abschneiden darf
                        statt umzubrechen. Der volle Wert steht im `title` und
                        nicht in `data-tooltip`: der Tooltip säße im
                        overflow-Container und würde selbst abgeschnitten. */}
                    <td className="sys-td-name">
                      <span className="sys-trunc mono" title={record.name}>
                        {record.name}
                      </span>
                    </td>
                    <td className="sys-td-name">
                      <span className="sys-trunc mono" title={value}>
                        {value}
                      </span>
                    </td>
                    <td>{formatTtl(record.ttl)}</td>
                    {withProxy && (
                      <td>
                        {/* Farblos statt grün: „geht direkt" ist kein Zustand, der
                            Aufmerksamkeit verdient, sondern der Normalfall hier. */}
                        <span
                          className="badge-status badge-neutral"
                          data-tooltip={
                            record.proxied
                              ? 'Läuft über die Cloudflare-Server'
                              : 'Zeigt direkt auf das Ziel'
                          }
                        >
                          {record.proxied ? <Cloud size={13} /> : <CloudOff size={13} />}
                          {record.proxied ? 'Cloudflare' : 'direkt'}
                        </span>
                      </td>
                    )}
                    <td>
                      {/* Nach links, und das ist nicht Geschmack: ein zentrierter
                          Tooltip an der letzten Spalte ragt über den rechten
                          Rand von `.table-wrap`. Er wird dort nicht nur
                          abgeschnitten — er zählt als Inhalt und erzeugt genau
                          den Scrollbalken, den die Tabelle sonst nicht hat. */}
                      <div className="actions">
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          data-tooltip-pos="left"
                          data-tooltip={
                            editable
                              ? 'Bearbeiten'
                              : `Ein ${record.type}-Eintrag wird hier angezeigt und nicht angefasst`
                          }
                          disabled={!editable}
                          onClick={() => setEditing(record)}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="btn btn-ghost btn-icon btn-sm"
                          data-tooltip-pos="left"
                          data-tooltip={editable ? 'Entfernen' : 'Nicht änderbar'}
                          disabled={!editable}
                          onClick={() => handleDelete(record)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && zone && (
        <RecordFormModal
          zone={zone}
          edit={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            notify({ variant: 'success', message: 'Der Eintrag ist gespeichert.' });
            await load(true);
          }}
        />
      )}
    </>
  );
}
