'use client';

import { useMemo, useRef, useState, useCallback } from 'react';
import ErrorNote from '@/components/ErrorNote';
import Link from 'next/link';
import PageHeading from '@/components/PageHeading';
import {
  Upload, Eye, Loader2, FileInput, ChevronDown, ChevronRight,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { useConfirm } from '@/components/ConfirmDialog';
import { usePolling } from '@/components/usePolling';
import Select from '@/components/Select';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { scopeLabel } from '@/lib/haproxy/config';
import {
  IMPORT_MAX_BYTES,
  LE_CERTS_PER_DOMAIN_WEEK,
  LE_FAILURES_PER_HOUR,
  LE_ORDERS_PER_3H,
  certificateLoad,
  importTextError,
  newScopeError,
  type AssessedEntry,
  type ImportKind,
  type ImportPreview,
  type ImportState,
} from '@/lib/haproxy/import';
import type { RunStatus } from '@/lib/types';
import { startRun } from '@/components/runs/runs';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Eine bestehende HAProxy-Konfiguration übernehmen.
 *
 * Zwei Schritte auf einer Seite: Text hinein, Vorschau ansehen und auswählen.
 * Den Lauf zeigt danach das Fenster der Läufe (`components/runs/`). Die
 * Vorschau rechnet der Server (`/api/haproxy/import/preview`), weil die
 * Konflikte an der Datei auf der Maschine hängen. Beim Ausführen
 * schickt die Seite nur die Schlüssel der gewählten Einträge; der Server liest
 * den Text noch einmal und glaubt der Vorschau nicht.
 *
 * Warum der Parser nichts rät und was er bewusst nicht übernimmt, steht in
 * `lib/haproxy/import.ts` und in docs/reverse-proxy.md.
 */

const KIND_LABELS: Record<ImportKind, string> = {
  proxy: msgid('Reverse-Proxy'),
  balance: msgid('Lastverteilung'),
  redirect: msgid('HTTP-Weiterleitung'),
  tcp: msgid('TCP-Weiterleitung'),
};

const STATE_LABELS: Record<ImportState, string> = {
  ready: msgid('Übernehmbar'),
  conflict: msgid('Konflikt'),
  blocked: msgid('Hier nicht möglich'),
  unsupported: msgid('Nicht übernehmbar'),
};

const STATE_CLASS: Record<ImportState, string> = {
  ready: 'badge-success',
  conflict: 'badge-warning',
  blocked: 'badge-warning',
  unsupported: 'badge-danger',
};

/** Der Wert der Auswahl „neue Gruppe". Kein gültiger Gruppenname, kann also
 *  mit keiner vorhandenen zusammenfallen. */
const NEW_SCOPE = '+neu';

/** So viele Abfragen des Laufs dürfen in Folge scheitern, bevor die Seite ihn aufgibt. */
const MAX_UNREAD_POLLS = 5;

interface RunView {
  status: RunStatus;
}

export default function ReverseProxyImportPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  const { t, plural, rich } = useT();

  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  /** Nur die Prüfung vor dem Absenden. Was der Server oder die Datei antwortet, ist eine Meldung. */
  const [inputError, setInputError] = useState('');

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  /** Der Text, zu dem die Vorschau gehört. Ausgeführt wird genau er, nicht
   *  der, der inzwischen im Feld steht. */
  const [previewText, setPreviewText] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scopeChoice, setScopeChoice] = useState(NEW_SCOPE);
  const [newScope, setNewScope] = useState('');
  const [dnsHook, setDnsHook] = useState('');
  const [showSkipped, setShowSkipped] = useState(false);

  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  /** Die Vorschau, aus der der letzte Lauf gestartet wurde. Nach ihm ist sie
   *  überholt: was angelegt wurde, wäre jetzt ein Konflikt. */
  const [importedFrom, setImportedFrom] = useState<ImportPreview | null>(null);

  async function loadFile(file: File) {
    setInputError('');
    const refuse = (message: string) => notify({ variant: 'error', title: file.name, message });
    if (file.size > IMPORT_MAX_BYTES) {
      refuse(t('Die Datei ist größer als {size} MB.', { size: IMPORT_MAX_BYTES / 1_000_000 }));
      return;
    }
    let content: string;
    try {
      content = await file.text();
    } catch {
      refuse(t('Die Datei konnte nicht gelesen werden.'));
      return;
    }
    const invalid = importTextError(content);
    if (invalid) {
      refuse(t(invalid));
      return;
    }
    setText(content);
    setFileName(file.name);
  }

  async function computePreview(hook = dnsHook) {
    const invalid = importTextError(text);
    if (invalid) {
      setInputError(t(invalid));
      return;
    }
    setPreviewing(true);
    setInputError('');
    try {
      const res = await apiFetch('/api/haproxy/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, dnsHook: hook || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || t('Die Vorschau ließ sich nicht berechnen.'));
      const next = data.data as ImportPreview;
      setPreview(next);
      setPreviewText(text);
      setSelected(new Set(next.entries.filter((e) => e.state === 'ready').map((e) => e.key)));
      setNewScope((current) => current || next.suggestedScope);
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Vorschau fehlgeschlagen'),
        message: errorText(err, t('HAPM hat nicht geantwortet. Bitte versuchen Sie es erneut.')),
      });
    } finally {
      setPreviewing(false);
    }
  }

  const ready = useMemo(() => preview?.entries.filter((e) => e.state === 'ready') ?? [], [preview]);
  const chosen = useMemo(() => ready.filter((e) => selected.has(e.key)), [ready, selected]);
  const load = useMemo(() => certificateLoad(chosen), [chosen]);
  const creatingScope = scopeChoice === NEW_SCOPE;
  const scopeName = creatingScope ? newScope.trim() : scopeChoice;
  const scopeError = preview && creatingScope ? newScopeError(newScope, preview.scopes) : null;
  const needsDns =
    !!preview &&
    preview.entries.some(
      (e) => e.domains.length > 0 && (preview.exposure === 'internal' || e.domains.some((d) => d.startsWith('*.')))
    );
  const running = runId !== null && (run === null || run.status === 'running');

  function toggle(key: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  /** Abfragen in Folge ohne Antwort. Nach `MAX_UNREAD_POLLS` gibt die Seite den
   *  Lauf auf, sonst bliebe das ganze Formular gesperrt, weil eine Antwort ausbleibt. */
  const unreadPolls = useRef(0);

  const pollRun = useCallback(async () => {
    if (!runId) return;
    const data = await apiFetch(`/api/haproxy/runs/${runId}`)
      .then((r) => r.json())
      .catch(() => null);
    if (!data?.success) {
      unreadPolls.current += 1;
      if (unreadPolls.current < MAX_UNREAD_POLLS) return;
      unreadPolls.current = 0;
      setRunId(null);
      setRun(null);
      notify({
        variant: 'error',
        title: t('Import'),
        message: t('Der Stand des Vorgangs ließ sich nicht abfragen. Die Schritte stehen in den Logs.'),
      });
      return;
    }
    unreadPolls.current = 0;
    setRun({ status: data.data.status });
  }, [apiFetch, runId, notify, t]);

  usePolling(() => (run?.status === 'running' || (runId && !run) ? pollRun() : undefined), 3000);

  async function startImport() {
    if (!preview || chosen.length === 0 || scopeError) return;
    const certificates = load.certificates;
    const scope = { scope: scopeLabel(scopeName) };
    const ok = await confirm({
      title: t('Konfiguration importieren'),
      message: [
        creatingScope
          ? plural(
              chosen.length,
              {
                one: 'Ein Eintrag wird in der Gruppe „{scope}“ angelegt, die dafür neu entsteht.',
                other: '{count} Einträge werden nacheinander in der Gruppe „{scope}“ angelegt, die dafür neu entsteht.',
              },
              scope
            )
          : plural(
              chosen.length,
              {
                one: 'Ein Eintrag wird in der Gruppe „{scope}“ angelegt.',
                other: '{count} Einträge werden nacheinander in der Gruppe „{scope}“ angelegt.',
              },
              scope
            ),
        t('Jeder geht durch dieselbe Prüfung wie im Dialog und lädt HAProxy einzeln neu.'),
        certificates > 0
          ? plural(certificates, {
              one: 'Beantragt wird höchstens ein Zertifikat, das kann einige Minuten dauern.',
              other: 'Beantragt werden bis zu {count} Zertifikate, jedes kann einige Minuten dauern.',
            })
          : t('Zertifikate werden keine beantragt.'),
      ].join(' '),
      confirmLabel: t('Importieren'),
      variant: 'warning',
    });
    if (!ok) return;

    setStarting(true);
    try {
      const res = await apiFetch('/api/haproxy/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: previewText,
          keys: chosen.map((e) => e.key),
          scope: scopeName,
          newScope: creatingScope,
          dnsHook: dnsHook || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || t('Der Import ließ sich nicht starten.'));
      setRun(null);
      unreadPolls.current = 0;
      setRunId(data.data.runId);
      setImportedFrom(preview);
      startRun({ kind: 'haproxy', id: data.data.runId as string, label: t('Import') });
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Import nicht gestartet'),
        message: errorText(err, t('HAPM hat nicht geantwortet. Bitte versuchen Sie es erneut.')),
      });
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <PageHeading
            icon={<FileInput size={20} />}
            title={t('Konfiguration importieren')}
            back={{ label: t('Ziele'), href: '/reverse-proxy' }}
          />
          <p className="page-subtitle">{t('Einträge aus einer bestehenden haproxy.cfg übernehmen.')}</p>
        </div>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <h2 className="card-title">
            {t('Konfiguration')}
            <InfoHint
              text={t(
                'Eine haproxy.cfg als Text, höchstens 1 MB. Sie wird nur gelesen und nirgends gespeichert. Übernommen wird erst, was Sie in der Vorschau auswählen und importieren.'
              )}
            />
          </h2>
        </div>
        <div className="card-body">
          {inputError && <div className="alert alert-danger"><ErrorNote text={inputError} /></div>}
          <div className="hapm-inline-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => fileInput.current?.click()}
              disabled={running || previewing}
            >
              <Upload size={16} />
              {t('Datei wählen')}
            </button>
            {fileName && <span className="form-hint">{fileName}</span>}
            <input
              ref={fileInput}
              type="file"
              accept=".cfg,.conf,.txt,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
                e.target.value = '';
              }}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="importText">{t('Oder den Text einfügen')}</label>
            <textarea
              id="importText"
              className="form-textarea"
              rows={12}
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem' }}
              placeholder={'frontend https_in\n    bind :443 ssl crt /etc/haproxy/certs/\n    acl host_shop hdr(host) -i shop.example.org\n    use_backend shop if host_shop\n\nbackend shop\n    server web1 10.0.0.11:8080 check'}
              value={text}
              disabled={running}
              onChange={(e) => {
                setText(e.target.value);
                setFileName(null);
              }}
            />
          </div>
          <div className="hapm-inline-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void computePreview()}
              disabled={previewing || running || text.trim() === ''}
            >
              {previewing ? <Loader2 size={16} className="spin" /> : <Eye size={16} />}
              {t('Vorschau berechnen')}
            </button>
            {preview && previewText !== text && (
              <span className="form-hint">{t('Der Text hat sich geändert. Die Vorschau gilt noch für den vorigen.')}</span>
            )}
          </div>
        </div>
      </div>

      {preview && (
        <>
          <div className="alert alert-info sys-block">
            {t(
              'Globale Abschnitte (global, defaults), TLS-Einstellungen und die bind-Zeilen der Frontends werden nicht übernommen: HAPM bringt eigene mit. Übernommen werden Domains, Ziele und TCP-Ports, und nur, wo sie sich in HAPM genauso verhalten wie bisher.'
            )}
          </div>

          {!preview.acmeReady && (
            <div className="alert alert-danger sys-block">
              {rich(
                'acme.sh fehlt. Ohne lässt sich kein Zertifikat ausstellen, und kein Eintrag mit Domain ist übernehmbar. Der Zustand steht in der {overview}.',
                { overview: <Link href="/dashboard">{t('Übersicht')}</Link> }
              )}
            </div>
          )}

          <div className={`alert ${load.exceeds || load.near ? 'alert-warning' : 'alert-info'} sys-block`}>
            <span>
              {t(
                'Bestehende Zertifikate werden nicht übernommen, sondern neu ausgestellt: jeder Eintrag mit Domain bekommt sein Zertifikat wie beim Anlegen im Dialog.'
              )}{' '}
              {preview.exposure === 'internal'
                ? t('Diese Installation ist intern, jedes Zertifikat geht über DNS-01.')
                : t(
                    'Ausgestellt wird über HTTP-01, Wildcards über DNS-01. Die Domains müssen dafür schon auf diesen Server zeigen, sonst scheitert der Antrag. DNS-Einträge legt der Import nicht an.'
                  )}{' '}
              {plural(load.certificates, {
                one: 'Mit der Auswahl wird höchstens ein Zertifikat beantragt.',
                other: 'Mit der Auswahl werden bis zu {count} Zertifikate beantragt.',
              })}
              {load.busiest && (load.exceeds || load.near) && (
                <>
                  {' '}
                  {plural(
                    load.busiest.count,
                    { one: 'Eines davon entfällt auf {domain}.', other: '{count} davon entfallen auf {domain}.' },
                    { domain: load.busiest.domain }
                  )}{' '}
                  {load.exceeds
                    ? t("Das ist mehr, als Let's Encrypt annimmt. Importieren Sie in Etappen.")
                    : t("Das ist mehr als die Hälfte dessen, was Let's Encrypt in einer Woche annimmt.")}
                </>
              )}{' '}
              <InfoHint
                text={t(
                  "Let's Encrypt stellt je registrierter Domain höchstens {certs} Zertifikate in 7 Tagen aus, nimmt je Konto höchstens {orders} neue Bestellungen in 3 Stunden an und lässt je Name {failures} gescheiterte Prüfungen in einer Stunde zu (Stand August 2026). Deckt ein vorhandenes Zertifikat einen Eintrag schon ab, wird für ihn keins beantragt.",
                  { certs: LE_CERTS_PER_DOMAIN_WEEK, orders: LE_ORDERS_PER_3H, failures: LE_FAILURES_PER_HOUR }
                )}
              />
            </span>
          </div>

          <div className="card sys-block">
            <div className="card-header">
              <h2 className="card-title">{t('Ziel-Gruppe')}</h2>
            </div>
            <div className="card-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="importScope">{t('Gruppe')}</label>
                  <Select
                    id="importScope"
                    value={scopeChoice}
                    disabled={running}
                    onChange={setScopeChoice}
                    options={[
                      { value: NEW_SCOPE, label: t('Neue Gruppe') },
                      ...preview.scopes.map((s) => ({ value: s.name, label: s.label })),
                    ]}
                  />
                </div>
                {creatingScope && (
                  <div className="form-group">
                    <label className="form-label" htmlFor="importNewScope">{t('Name der neuen Gruppe')}</label>
                    <input
                      id="importNewScope"
                      className="form-input"
                      value={newScope}
                      disabled={running}
                      onChange={(e) => setNewScope(e.target.value)}
                      autoComplete="off"
                    />
                    {scopeError && <span className="form-hint">{t(scopeError)}</span>}
                  </div>
                )}
              </div>
              {needsDns && preview.dnsHooks.length > 1 && (
                <div className="form-group">
                  <label className="form-label" htmlFor="importHook">
                    {t('DNS-Zugangsdaten für DNS-01')}
                    <InfoHint
                      text={t(
                        'Mehrere DNS-Anbieter sind eingerichtet. Welcher die Zonen der importierten Domains führt, lässt sich nicht raten. Die Auswahl gilt für alle Einträge, die über DNS-01 ausgestellt werden.'
                      )}
                    />
                  </label>
                  <Select
                    id="importHook"
                    value={dnsHook || null}
                    disabled={running || previewing}
                    placeholder={t('Bitte wählen')}
                    onChange={(hook) => {
                      setDnsHook(hook);
                      void computePreview(hook);
                    }}
                    options={preview.dnsHooks.map((hook) => ({ value: hook, label: hook }))}
                  />
                </div>
              )}
            </div>
          </div>

          <div className="sys-block">
            <div className="section-header">
              <h2 className="section-title">
                {t('Vorschau')}
                <span className="section-count">
                  {t('{ready} von {total} übernehmbar', { ready: ready.length, total: preview.entries.length })}
                </span>
              </h2>
              <span className="section-hint">{t('Die Kennung vergibt der Server beim Anlegen')}</span>
            </div>

            {preview.entries.length === 0 ? (
              <div className="empty-state">
                <FileInput size={40} />
                <h3>{t('Nichts gefunden')}</h3>
                <p>{t('In dem Text steht kein Frontend mit Domains und kein TCP-Port, den HAPM übernehmen könnte.')}</p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>
                        <label className="toggle-switch" data-tooltip={t('Alle übernehmbaren')}>
                          <input
                            type="checkbox"
                            checked={ready.length > 0 && chosen.length === ready.length}
                            disabled={running || ready.length === 0}
                            onChange={(e) =>
                              setSelected(new Set(e.target.checked ? ready.map((r) => r.key) : []))
                            }
                            aria-label={t('Alle übernehmbaren auswählen')}
                          />
                          <span className="toggle-slider" />
                        </label>
                      </th>
                      <th>{t('Art')}</th>
                      <th>{t('Domains bzw. Port')}</th>
                      <th>{t('Ziele')}</th>
                      <th>{t('Zusätze')}</th>
                      <th>{t('Zustand')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.entries.map((entry) => (
                      <EntryRow
                        key={entry.key}
                        entry={entry}
                        checked={selected.has(entry.key)}
                        disabled={running}
                        onToggle={(on) => toggle(entry.key, on)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="hapm-inline-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void startImport()}
                disabled={
                  starting ||
                  running ||
                  chosen.length === 0 ||
                  !!scopeError ||
                  previewText !== text ||
                  importedFrom === preview
                }
              >
                {starting ? <Loader2 size={16} className="spin" /> : <FileInput size={16} />}
                {plural(chosen.length, { one: 'Einen Eintrag importieren', other: '{count} Einträge importieren' })}
              </button>
              {previewText !== text ? (
                <span className="form-hint">{t('Erst die Vorschau für den geänderten Text berechnen.')}</span>
              ) : (
                importedFrom === preview &&
                !running && (
                  <span className="form-hint">
                    {t('Schon importiert. Vor dem nächsten Import die Vorschau neu berechnen.')}
                  </span>
                )
              )}
            </div>
          </div>

          {preview.skipped.length > 0 && (
            <div className="sys-block">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setShowSkipped((open) => !open)}
                aria-expanded={showSkipped}
              >
                {showSkipped ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                {t('Nicht übernommen ({count})', { count: preview.skipped.length })}
              </button>
              {showSkipped && (
                <div className="table-wrap" style={{ marginTop: 8 }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('Zeile')}</th>
                        <th>{t('Inhalt')}</th>
                        <th>{t('Grund')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.skipped.map((item, index) => (
                        <tr key={`${item.line}-${index}`}>
                          <td style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>{item.line}</td>
                          <td style={{ fontSize: '0.8125rem' }}>
                            <code>{item.text}</code>
                          </td>
                          <td style={{ fontSize: '0.8125rem' }}>{t(item.reason)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

function EntryRow({
  entry,
  checked,
  disabled,
  onToggle,
}: {
  entry: AssessedEntry;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  const { t } = useT();
  const muted = { fontSize: '0.75rem', color: 'var(--text-tertiary)' };
  const selectable = entry.state === 'ready';
  return (
    <tr>
      <td>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={selectable && checked}
            disabled={disabled || !selectable}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={t('{name} übernehmen', { name: entry.domains[0] ?? t('Port {port}', { port: entry.port ?? '?' }) })}
          />
          <span className="toggle-slider" />
        </label>
      </td>
      <td style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>{t(KIND_LABELS[entry.kind])}</td>
      <td style={{ fontSize: '0.8125rem' }}>
        {entry.domains.length > 0
          ? entry.domains.map((domain) => <div key={domain}>{domain}</div>)
          : <div>{t('Port {port}', { port: entry.port ?? '?' })}</div>}
        {entry.id && <div style={muted}>{t('Kennung {id}', { id: entry.id })}</div>}
        <div style={muted}>{t('Zeile {line}, {source}', { line: entry.line, source: entry.source })}</div>
      </td>
      <td style={{ fontSize: '0.8125rem' }}>
        {entry.targets.length > 0
          ? entry.targets.map((target) => <div key={target}>{target}</div>)
          : <span style={muted}>{t('keine')}</span>}
      </td>
      <td style={{ fontSize: '0.8125rem' }}>
        {entry.extras.length > 0
          ? entry.extras.map((extra) => <div key={extra}>{extra}</div>)
          : <span style={muted}>{t('keine')}</span>}
      </td>
      <td style={{ fontSize: '0.8125rem', minWidth: '14rem' }}>
        <span className={`badge-status ${STATE_CLASS[entry.state]}`}>{t(STATE_LABELS[entry.state])}</span>
        {(entry.state === 'unsupported' ? entry.problems : entry.reason ? [entry.reason] : []).map((reason) => (
          <div key={reason} style={{ marginTop: 4 }}>
            {t(reason)}
          </div>
        ))}
        {entry.state !== 'unsupported' &&
          entry.notes.map((note) => (
            <div key={note} style={{ ...muted, marginTop: 4 }}>
              {t(note)}
            </div>
          ))}
      </td>
    </tr>
  );
}
