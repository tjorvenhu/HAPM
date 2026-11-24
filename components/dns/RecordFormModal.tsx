'use client';

import { useState, type FormEvent } from 'react';
import { Loader2, X, Info } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import Select from '@/components/Select';
import {
  EDITABLE_TYPES,
  PROVIDER_RULES,
  PROXYABLE_TYPES,
  formatTtl,
  validateRecordInput,
  type DnsRecord,
  type EditableRecordType,
  type RecordInput,
} from '@/lib/dns/records';
import { recordFqdn, recordName, type DnsProviderId } from '@/lib/dns/zones';
import { dnsProviderInfo } from '@/lib/dns/provider-info';
import { InfoHint } from '@/ui/primitives/InfoHint';

/**
 * Einen DNS-Eintrag anlegen oder ändern.
 *
 * Geprüft wird mit `validateRecordInput` — derselben Funktion, die die Route
 * aufruft. Ein Dialog mit eigener Prüfung wäre einer, der etwas durchlässt, was
 * der Anbieter danach auf Englisch ablehnt.
 *
 * Was je Anbieter anders ist, kommt aus `PROVIDER_RULES`: der Abschnitt zum
 * Proxy erscheint nur bei Cloudflare, und „keine eigene TTL" heißt dort
 * „Automatisch", bei Hetzner „Vorgabe der Zone".
 *
 * Der Zustand entsteht beim Einhängen aus `edit` und lebt nur, solange der
 * Dialog offen ist; die Seite rendert ihn gar nicht erst, wenn er zu ist.
 * Dieselbe Bauweise wie beim Dienst-Dialog des Reverse-Proxys.
 */

/** Was im Feld „Wert" steht, bevor jemand tippt. Je Art etwas anderes. */
const CONTENT_PLACEHOLDER: Record<EditableRecordType, string> = {
  A: '203.0.113.10',
  AAAA: '2001:db8::1',
  CNAME: 'ziel.example.org',
  TXT: 'v=spf1 include:_spf.example.com ~all',
  MX: 'mx.example.org',
  NS: 'ns1.example.net',
};

/** Steht im Auswahlfeld für „keine eigene TTL", ob das beim Anbieter 1 oder `null` ist. */
const TTL_DEFAULT = 'default';

const TTL_CHOICES = [
  { value: '60', label: '1 Minute' },
  { value: '300', label: '5 Minuten' },
  { value: '1800', label: '30 Minuten' },
  { value: '3600', label: '1 Stunde' },
  { value: '86400', label: '1 Tag' },
];

interface Props {
  zone: { $id: string; name: string; provider: DnsProviderId };
  /** Gesetzt heißt bearbeiten. */
  edit: DnsRecord | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

export default function RecordFormModal({ zone, edit, onClose, onSaved }: Props) {
  const { apiFetch } = useApp();
  const rules = PROVIDER_RULES[zone.provider];
  const providerLabel = dnsProviderInfo(zone.provider).label;

  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const [type, setType] = useState<EditableRecordType>(
    (edit?.type as EditableRecordType) ?? 'A'
  );
  // Geführt wird der volle Name, eingegeben der Teil davor.
  const [name, setName] = useState(edit ? recordName(edit.name, zone.name) : '');
  const [content, setContent] = useState(edit?.content ?? '');
  const [ttl, setTtl] = useState(
    !edit || edit.ttl === rules.defaultTtl || edit.ttl === null ? TTL_DEFAULT : String(edit.ttl)
  );
  const [proxied, setProxied] = useState(edit?.proxied ?? false);
  const [priority, setPriority] = useState(edit?.priority === null ? '10' : String(edit?.priority ?? '10'));
  const [comment, setComment] = useState(edit?.comment ?? '');

  const proxyable = rules.proxy && PROXYABLE_TYPES.includes(type);

  const ttlOptions = [
    {
      value: TTL_DEFAULT,
      label: rules.defaultTtl === null ? 'Vorgabe der Zone' : 'Automatisch',
    },
    ...TTL_CHOICES,
    // Eine TTL, die jemand beim Anbieter gesetzt hat und die hier nicht zur
    // Auswahl steht (acme.sh schreibt 120), bleibt wählbar. Sonst stünde das
    // Feld leer da, und Speichern änderte sie, ohne dass jemand es wollte.
    ...(edit &&
    edit.ttl !== null &&
    edit.ttl !== rules.defaultTtl &&
    !TTL_CHOICES.some((choice) => choice.value === String(edit.ttl))
      ? [{ value: String(edit.ttl), label: formatTtl(edit.ttl) }]
      : []),
  ];

  const input: RecordInput = {
    type,
    name: name.trim().toLowerCase(),
    content: content.trim(),
    ttl: ttl === TTL_DEFAULT ? rules.defaultTtl : Number(ttl),
    proxied: proxied && proxyable,
    priority: type === 'MX' ? Number(priority) : null,
    comment: comment.trim() || null,
  };
  const inputError = name.trim() === '' && content.trim() === ''
    ? null
    : validateRecordInput(input, zone.name, zone.provider);

  const fqdn = name.trim() === '' ? zone.name : recordFqdn(name, zone.name);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateRecordInput(input, zone.name, zone.provider);
    if (invalid) {
      setFormError(invalid);
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const res = await apiFetch(
        edit
          ? `/api/dns/zones/${zone.$id}/records/${edit.id}`
          : `/api/dns/zones/${zone.$id}/records`,
        {
          method: edit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Speichern fehlgeschlagen');
      await onSaved();
      onClose();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Speichern fehlgeschlagen');
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && !saving && onClose()}
    >
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">
            {edit ? 'Eintrag bearbeiten' : 'Eintrag anlegen'}
            <span className="modal-subject">{zone.name}</span>
          </h2>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            disabled={saving}
            aria-label="Dialog schließen"
          >
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {formError && <div className="alert alert-danger sys-block">{formError}</div>}

            <div className="form-pair">
              <div className="form-group">
                <label className="form-label">Typ</label>
                <Select
                  value={type}
                  onChange={(v) => setType(v as EditableRecordType)}
                  options={EDITABLE_TYPES.map((t) => ({ value: t, label: t }))}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Name</label>
                <input
                  className="form-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="app"
                  autoComplete="off"
                  required
                />
                <span className="form-hint">
                  Ergibt <code>{fqdn}</code>. <code>@</code> ist die Domain selbst,{' '}
                  <code>*</code> die Wildcard.
                </span>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Wert</label>
              <input
                className="form-input"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={CONTENT_PLACEHOLDER[type]}
                autoComplete="off"
                required
              />
            </div>

            <div className="form-pair">
              <div className="form-group">
                <label className="form-label">TTL</label>
                <Select value={ttl} onChange={setTtl} options={ttlOptions} />
                <span className="form-hint">
                  {rules.ttlPerName
                    ? 'Gilt für alle Einträge mit diesem Namen und Typ.'
                    : `„Automatisch“ lässt ${providerLabel} entscheiden. Das ist der Normalfall.`}
                </span>
              </div>
              {type === 'MX' && (
                <div className="form-group">
                  <label className="form-label">Priorität</label>
                  <input
                    className="form-input"
                    value={priority}
                    onChange={(e) => setPriority(e.target.value)}
                    inputMode="numeric"
                    autoComplete="off"
                  />
                  <span className="form-hint">Kleiner heißt: wird zuerst versucht.</span>
                </div>
              )}
            </div>

            {proxyable && (
              <div className="form-subsection">
                <div className="form-subsection-head">
                  <div>
                    <div className="form-section-title">Über Cloudflare leiten</div>
                    <div className="form-section-sub">
                      Die orange Wolke: Cloudflare terminiert TLS und verbirgt die Zieladresse.
                    </div>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={proxied}
                      onChange={(e) => setProxied(e.target.checked)}
                      aria-label="Über Cloudflare leiten"
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>
                {proxied && (
                  <div className="form-note">
                    <Info size={14} />
                    <span>
                      Für ein Ziel hinter diesem HAProxy ist das falsch: Let’s Encrypt kommt über
                      HTTP-01 nicht mehr durch, und Log und Statistik sähen als Client-IP die von Cloudflare.
                    </span>
                  </div>
                )}
              </div>
            )}

            <div className="form-group">
              <label className="form-label">
                Notiz
                <InfoHint
                  text={`Steht bei ${providerLabel} am Eintrag. Von HAPM gesetzte Einträge tragen hier „HAPM“.`}
                />
              </label>
              <input
                className="form-input"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Optional: wofür ist der Eintrag?"
                autoComplete="off"
              />
            </div>

            {inputError && <div className="alert alert-warning">{inputError}</div>}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
              Abbrechen
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || !!inputError}>
              {saving && <Loader2 size={16} className="spin" />}
              {edit ? 'Speichern' : 'Anlegen'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
