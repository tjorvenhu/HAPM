'use client';

import { Fragment, Suspense, useEffect, useState, useCallback } from 'react';
import ErrorNote from '@/components/ErrorNote';
import Link from 'next/link';
import {
  ShieldCheck, Loader2, RefreshCw, X, Network, Save, Lock, Plus, Info,
  KeyRound, Trash2, ShieldAlert, Globe, FileCog,
} from 'lucide-react';
import PageHeading from '@/components/PageHeading';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { useConfirm } from '@/components/ConfirmDialog';
import Select from '@/components/Select';
import {
  DNS_PROVIDERS,
  findDnsProvider,
  hasCredentialForm,
  validateDnsCredentials,
  type DnsProvider,
} from '@/lib/haproxy/dns-credentials';
import CredentialFields from '@/components/dns/CredentialFields';
import DnsWaitSetting from '@/components/reverse-proxy/DnsWaitSetting';
import { usePolling } from '@/components/usePolling';
import { openRun } from '@/components/runs/runs';
import { HTTPS_MARKER, type GlobalSettings } from '@/lib/haproxy/config';
import { SkeletonRows } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import AreaTabs, { useArea, type Area as AreaEntry } from '@/components/AreaTabs';
import GeoipPanel from '@/components/reverse-proxy/GeoipPanel';
import BaseConfigPanel from '@/components/reverse-proxy/BaseConfigPanel';
import ProtectionSection, {
  protectionDraft,
  protectionPayload,
  type ProtectionContext,
  type ProtectionDraft,
} from '@/components/reverse-proxy/ProtectionSection';
import { useT } from '@/lib/i18n/react';
import { msgid } from '@/lib/i18n';

/**
 * Die globalen Einstellungen eines Reverse-Proxys.
 *
 * Was für ALLE Dienste einer Maschine gilt und deshalb in keinen Dienst-Dialog
 * gehört: der Block unter `# Globale HTTPS-Settings` im Frontend, die
 * Admin-Adressliste und der Zugriffsschutz (gesperrte Adressen und Länder,
 * Ratenbegrenzung).
 *
 * Warum überhaupt hier: es sind genau die Zeilen, die man einmal setzt und
 * danach nie wieder ansieht — und die fehlen, wenn ein Proxy neu aufgesetzt
 * wurde. Auf dieser Seite steht, was gerade gilt, gelesen bei jedem Aufruf
 * direkt aus der Datei auf der Maschine.
 *
 * Geschrieben wird über denselben Weg wie ein Dienst: prüfen, Backup,
 * einsetzen, reloaden — abgekoppelt, sichtbar in der Pille unten rechts.
 *
 * Daneben der Abgleich mit der Grundkonfiguration (`BaseConfigPanel`): was
 * eine ältere Installation an neuen Vorgaben nicht hat, und die Länder-Tabelle.
 *
 * Fünf Reiter statt einer langen Seite. Der gewählte steht in der Adresse
 * (`?bereich=`), damit ein Link anderswo direkt dorthin führt.
 */

type Area = 'https' | 'zugriff' | 'dns' | 'laender' | 'grundkonfiguration';

const AREAS: AreaEntry<Area>[] = [
  { key: 'https', label: msgid('HTTPS'), icon: ShieldCheck },
  { key: 'zugriff', label: msgid('Zugriff'), icon: Lock },
  { key: 'dns', label: msgid('DNS-Zugangsdaten'), icon: KeyRound },
  { key: 'laender', label: msgid('Länder-Tabelle'), icon: Globe },
  { key: 'grundkonfiguration', label: msgid('Grundkonfiguration'), icon: FileCog },
];

interface SettingsRow {
  $id: string;
  name: string;
  host: string;
  settings: GlobalSettings | null;
  /** Die acme.sh-DNS-Hooks, die auf der Maschine eingerichtet sind. Sie sagen,
   *  ob Zugangsdaten hinterlegt sind — der Token selbst kommt nie zurück. */
  dnsHooks: string[];
  editable: boolean;
  error: string | null;
}

/** Was auf der Seite bearbeitet wird — ein Abbild der Eingabe der Route. */
interface Draft {
  httpsLines: string[];
  adminIps: string[];
  /** `null`: der Block steht von Hand geändert da und geht nicht mit. */
  protection: ProtectionDraft | null;
}

/** So viele Abfragen eines Laufs dürfen in Folge scheitern, bevor die Seite ihn aufgibt. */
const MAX_UNREAD_POLLS = 5;

export default function ReverseProxySettingsPage() {
  // `useSearchParams` verlangt eine Suspense-Grenze, sonst scheitert der Build.
  return (
    <Suspense fallback={<SkeletonRows />}>
      <SettingsPage />
    </Suspense>
  );
}

function SettingsPage() {
  const { apiFetch } = useApp();
  // Ältere Links zeigen mit `#grundkonfiguration` auf die Karte.
  const [area, select] = useArea(AREAS, '/reverse-proxy/einstellungen', { grundkonfiguration: 'grundkonfiguration' });
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, rich } = useT();

  const [rows, setRows] = useState<SettingsRow[]>([]);
  const [protectionContext, setProtectionContext] = useState<ProtectionContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  /** Die Bearbeitung je Maschine. Erst beim Ändern belegt: eine Seite, die
   *  ihren Zustand beim Nachladen überschreibt, löscht, was jemand tippt. */
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);

  /**
   * Die getippten Zugangsdaten, bis sie auf der Maschine sind.
   *
   * Ein flacher Schlüssel `server|hook|feld` statt verschachtelter Objekte:
   * jedes Feld wird einzeln gesetzt und einzeln gelesen, und die Verschachtelung
   * wäre nur ein Umweg mit drei Stellen, an denen man einen fehlenden Zweig
   * vergisst.
   */
  const [credDraft, setCredDraft] = useState<Record<string, string>>({});
  const [savingCred, setSavingCred] = useState<string | null>(null);
  /** Für welche Maschine das Hinzufügen-Formular offen ist, und für welchen
   *  Anbieter. Genau eines auf einmal — zwei offene Formulare für dieselbe
   *  Sorte Geheimnis wären zwei Stellen, an denen man das falsche Feld füllt. */
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [addHook, setAddHook] = useState('');

  /**
   * Der laufende Vorgang samt der Eingabe, die er schreibt.
   *
   * Die Eingabe bleibt stehen, bis er durch ist. Vorher wurde sie beim Klick
   * verworfen, und bis HAProxy neu geladen hatte, stand wieder der alte Stand
   * im Formular: eine eben eingetragene Admin-IP verschwand und kam erst Sekunden
   * später zurück. `sent` ist die Eingabe beim Speichern: nur sie wird danach
   * verworfen, nicht was jemand inzwischen weiter getippt hat.
   */
  const [pendingRun, setPendingRun] = useState<{ id: string; label: string; rowId: string; sent: string } | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch('/api/haproxy/settings');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error);
        setRows(data.data.rows);
        setProtectionContext(data.data.protectionContext);
        setError('');
      } catch {
        setError(t('Die Einstellungen konnten nicht geladen werden.'));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, t]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Jeder Takt ist eine Runde Kommandos, und diese Zeilen ändern sich nicht
  // im Minutentakt. Nachgeladen wird nur, solange niemand tippt — sonst
  // überschriebe der nächste Takt die halbe Eingabe.
  usePolling(() => {
    if (Object.keys(draft).length === 0) load(true);
  }, 60_000);

  useEffect(() => {
    if (!pendingRun) return;
    let cancelled = false;
    // Ein Takt mit Nachladen dauert länger als drei Sekunden. Der nächste
    // wartet, sonst zählte und meldete er dasselbe ein zweites Mal.
    let busy = false;
    // Abfragen in Folge ohne Antwort. Nach `MAX_UNREAD_POLLS` gibt die Seite den
    // Lauf auf, sonst bliebe der Knopf für immer bei „Wird übernommen“.
    let unread = 0;

    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const data = await apiFetch(`/api/haproxy/runs/${pendingRun.id}`)
          .then((r) => r.json())
          .catch(() => null);
        if (cancelled) return;
        if (!data?.success) {
          unread += 1;
          if (unread < MAX_UNREAD_POLLS) return;
          // Die Eingabe bleibt: ob sie angekommen ist, weiß hier niemand.
          clearInterval(interval);
          setPendingRun(null);
          notify({
            variant: 'error',
            title: pendingRun.label,
            message: t('Der Stand des Vorgangs ließ sich nicht abfragen. Die Schritte stehen in den Logs.'),
          });
          return;
        }
        unread = 0;
        if (data.data.status === 'running') return;
        // Erst nachladen, dann die Eingabe verwerfen und melden: sonst steht für
        // einen Augenblick der alte Stand der Maschine da. Scheitert der Vorgang,
        // bleibt die Eingabe, damit man sie korrigieren und erneut speichern kann.
        const ok = data.data.status === 'success';
        await load(true);
        if (cancelled) return;
        if (ok) {
          setDraft((current) => {
            if (JSON.stringify(current[pendingRun.rowId]) !== pendingRun.sent) return current;
            const rest = { ...current };
            delete rest[pendingRun.rowId];
            return rest;
          });
        }
        clearInterval(interval);
        setPendingRun(null);
        notify({
          variant: ok ? 'success' : 'error',
          title: pendingRun.label,
          message: ok
            ? t('Durchgelaufen, HAProxy hat die neue Konfiguration übernommen.')
            : t('Nicht durchgelaufen. Der erste fehlgeschlagene Schritt steht im Fenster des Laufs.'),
          action: { label: t('Schritte ansehen'), onClick: () => openRun({ kind: 'haproxy', id: pendingRun.id }) },
        });
      } finally {
        busy = false;
      }
    };

    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pendingRun, apiFetch, load, notify, t]);

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([load(true), new Promise((resolve) => setTimeout(resolve, 400))]);
    } finally {
      setRefreshing(false);
    }
  }

  /** Der Stand, den das Formular zeigt: die Bearbeitung, sonst die Maschine. */
  function valueOf(row: SettingsRow): Draft | null {
    return draft[row.$id] ?? baseOf(row);
  }

  /** Ob auf diesem Reiter etwas getippt ist, das noch nicht gespeichert ist. */
  function areaDirty(row: SettingsRow, key: Area): boolean {
    const now = draft[row.$id];
    const base = baseOf(row);
    if (!now || !base) return false;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (key === 'https') return !same(now.httpsLines, base.httpsLines);
    if (key === 'zugriff') return !same(now.adminIps, base.adminIps) || !same(now.protection, base.protection);
    return false;
  }

  /** Der Stand der Maschine, so wie das Formular ihn hält. */
  function baseOf(row: SettingsRow): Draft | null {
    if (!row.settings || row.settings.httpsLines === null) return null;
    const lines = row.settings.httpsLines;
    return {
      // Eine leere Zeile am Ende, damit man tippen kann, ohne vorher auf
      // „hinzufügen" zu drücken. Gilt für beide Listen.
      httpsLines: lines.length > 0 ? [...lines] : [''],
      adminIps: row.settings.adminIps.length > 0 ? [...row.settings.adminIps] : [''],
      protection: row.settings.protection ? protectionDraft(row.settings.protection) : null,
    };
  }

  function edit(row: SettingsRow, patch: Partial<Draft>) {
    const current = valueOf(row);
    if (!current) return;
    setDraft({ ...draft, [row.$id]: { ...current, ...patch } });
  }

  /* ── DNS-Zugangsdaten ──
   *
   * Ein eigener Weg neben `save()`, und zwar bewusst: der schreibt `haproxy.cfg`
   * und läuft deshalb abgekoppelt (prüfen, Backup, einsetzen, reloaden — Minuten).
   * Der hier schreibt eine Zeile in `account.conf`, fasst HAProxy nicht an und
   * ist in einer Sekunde durch. Ihn durch denselben Apparat zu schicken hieße
   * eine Pille unten rechts für einen Vorgang, der fertig ist, bevor sie
   * erscheint. */

  /** Die Anbieter, für die auf dieser Maschine schon ein Token liegt. Abgeleitet
   *  aus den Hooks, die die Maschine meldet — es gibt keine zweite Quelle. */
  function configuredProviders(row: SettingsRow): DnsProvider[] {
    return DNS_PROVIDERS.filter((provider) => row.dnsHooks.includes(provider.hook));
  }

  function missingProviders(row: SettingsRow): DnsProvider[] {
    return DNS_PROVIDERS.filter((provider) => !row.dnsHooks.includes(provider.hook));
  }

  function startAdd(row: SettingsRow) {
    // Der erste noch freie Anbieter steht vorausgewählt: eine Auswahl, die man
    // erst aufklappen muss, um überhaupt etwas tippen zu können, ist ein Klick
    // ohne Entscheidung.
    setAddHook(missingProviders(row)[0]?.hook ?? '');
    setAddingFor(row.$id);
  }

  function cancelAdd() {
    setAddingFor(null);
    setCredDraft({});
  }

  /** Ob für diesen Anbieter überhaupt etwas getippt wurde. Ein Knopf, der immer
   *  aktiv ist und beim Klick nichts tut, ist keine Auskunft. */
  function hasCredentialInput(key: string, provider: DnsProvider | null): boolean {
    if (!provider) return false;
    return provider.fields.some((field) => (credDraft[`${key}|${field.name}`] ?? '').trim());
  }

  /** Die getippten Werte für einen Anbieter wieder aus dem Formular nehmen. */
  function clearCredentialDraft(key: string, provider: DnsProvider) {
    const rest = { ...credDraft };
    for (const field of provider.fields) delete rest[`${key}|${field.name}`];
    setCredDraft(rest);
  }

  async function saveCredentials(row: SettingsRow, provider: DnsProvider) {
    const key = `${row.$id}|${provider.hook}`;
    const values = Object.fromEntries(
      provider.fields.map((field) => [field.name, (credDraft[`${key}|${field.name}`] ?? '').trim()])
    );

    // Dieselbe Funktion, die die Route aufruft — sonst wäre der Dialog eine
    // zweite Meinung darüber, was durchgeht.
    const invalid = validateDnsCredentials({ hook: provider.hook, values, remove: false });
    if (invalid) {
      notify({ variant: 'error', title: provider.label, message: t(invalid) });
      return;
    }

    setSavingCred(key);
    try {
      const res = await apiFetch('/api/haproxy/dns-credentials', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: row.$id, hook: provider.hook, values }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Speichern fehlgeschlagen'));

      // Erst nachladen, dann melden: die Meldung sagt „eingerichtet", und die
      // Zeile darüber soll das dann auch schon zeigen.
      clearCredentialDraft(key, provider);
      setAddingFor(null);
      await load(true);

      /* Der Rückabgleich, nicht die eigene Zusage: die Route gibt zurück, welche
       * Hooks die Maschine DANACH kennt. Ein Token, der ankommt, aber unter
       * einem Namen steht, den kein Hook liest, wäre sonst ein grüner Haken ohne
       * Deckung — und aufgefallen wäre er erst beim ersten Wildcard-Antrag. */
      const active = (data.data.dnsHooks as string[]).includes(provider.hook);
      notify({
        variant: active ? 'success' : 'error',
        title: provider.label,
        message: active
          ? t('Zugangsdaten abgelegt. Wildcard-Zertifikate lassen sich ab jetzt ausstellen, auch für neue Domains derselben Zone.')
          : t('Die Datei wurde geschrieben, acme.sh erkennt daraus aber keinen Hook. Stehen die Zugangsdaten unter dem erwarteten Namen?'),
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: provider.label,
        message: errorText(err, t('HAPM hat nicht geantwortet. Bitte versuchen Sie es erneut.')),
      });
    } finally {
      setSavingCred(null);
    }
  }

  async function removeCredentials(row: SettingsRow, provider: DnsProvider) {
    const ok = await confirm({
      title: t('{provider}-Zugangsdaten entfernen?', { provider: provider.label }),
      message: t(
        'Die Zugangsdaten werden aus der acme.sh-Konfiguration gestrichen. Bestehende Zertifikate bleiben, aber ihre automatische Erneuerung über DNS scheitert ab dann, und eine neue Wildcard lässt sich nicht mehr ausstellen.'
      ),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
    });
    if (!ok) return;

    const key = `${row.$id}|${provider.hook}`;
    setSavingCred(key);
    try {
      const res = await apiFetch('/api/haproxy/dns-credentials', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: row.$id, hook: provider.hook }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Entfernen fehlgeschlagen'));

      clearCredentialDraft(key, provider);
      await load(true);
      notify({
        variant: 'success',
        title: provider.label,
        message: t('Die Zugangsdaten sind entfernt.'),
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: provider.label,
        message: errorText(err, t('HAPM hat nicht geantwortet. Bitte versuchen Sie es erneut.')),
      });
    } finally {
      setSavingCred(null);
    }
  }

  async function save(row: SettingsRow) {
    const value = draft[row.$id];
    if (!value) return;
    setSaving(row.$id);
    try {
      const res = await apiFetch('/api/haproxy/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverId: row.$id,
          httpsLines: value.httpsLines,
          adminIps: value.adminIps,
          // Fehlt das Feld, bleibt ein von Hand geänderter Block stehen.
          ...(value.protection ? { protection: protectionPayload(value.protection) } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Der Vorgang ist fehlgeschlagen.'));
      const run = { id: data.data.runId, label: t('Einstellungen speichern'), rowId: row.$id, sent: JSON.stringify(value) };
      setPendingRun(run);
      openRun({ kind: 'haproxy', id: run.id });
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('HAPM hat nicht geantwortet. Bitte versuchen Sie es erneut.')),
      });
    } finally {
      setSaving(null);
    }
  }

  const dirtyRow = rows.find((row) => draft[row.$id]) ?? null;

  return (
    <>
      <div className="page-header">
        <PageHeading
          icon={<ShieldCheck size={20} />}
          title={t('Einstellungen')}
          back={{ label: t('Ziele'), href: '/reverse-proxy' }}
          note={t('Was für alle Dienste gilt')}
        />
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
          {/* Ein Speichern für HTTPS, Admin-IPs und Zugriffsschutz: sie gehen in
              einem Vorgang in die Datei, auch wenn sie auf zwei Reitern stehen. */}
          {dirtyRow && dirtyRow.editable && (
            <button
              className="btn btn-primary"
              onClick={() => save(dirtyRow)}
              disabled={saving === dirtyRow.$id || pendingRun?.rowId === dirtyRow.$id}
            >
              {saving === dirtyRow.$id || pendingRun?.rowId === dirtyRow.$id ? (
                <Loader2 size={16} className="spin" />
              ) : (
                <Save size={16} />
              )}
              {pendingRun?.rowId === dirtyRow.$id ? t('Wird übernommen') : t('Änderungen speichern')}
            </button>
          )}
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block"><ErrorNote text={error} /></div>}

      <AreaTabs areas={AREAS} value={area} onChange={select} dirty={(key) => !pendingRun && rows.some((row) => areaDirty(row, key))} />

      {area === 'laender' && <GeoipPanel />}
      {area === 'grundkonfiguration' && <BaseConfigPanel />}

      {/* Ein laufender Vorgang steht in der Pille unten rechts, nicht hier. */}

      {(area === 'https' || area === 'zugriff' || area === 'dns') &&
        (loading ? (
          <SkeletonRows />
        ) : rows.length === 0 ? (
          // Nach einem Ladefehler ist die Liste leer, weil sie unbekannt ist: dann steht nur die Meldung oben.
          !error && (
            <div className="empty-state">
              <Network size={40} />
              <h3>{t('HAProxy antwortet nicht')}</h3>
              <p>
                {rich('Ohne HAProxy gibt es hier nichts einzustellen. Sein Zustand steht in der {overview}.', {
                  overview: <Link href="/dashboard">{t('Übersicht')}</Link>,
                })}
              </p>
            </div>
          )
        ) : (
          rows.map((row) => {
            const value = valueOf(row);
            const noMarker = !row.error && row.settings?.httpsLines == null && (
              <div className="alert alert-warning sys-block">
                <span>
                  {rich(
                    'In der Konfiguration steht keine Zeile {marker}. Ohne sie ist nicht bestimmbar, wo die globalen Einstellungen hingehören. Hier wird deshalb nichts angeboten.',
                    { marker: <code>{HTTPS_MARKER}</code> }
                  )}
                </span>
              </div>
            );

            return (
              <Fragment key={row.$id}>
                {row.error && <div className="alert alert-danger sys-block"><ErrorNote text={row.error} /></div>}

                {area === 'https' && (
                  <>
                    {noMarker}
                    {value && (
                      <div className="card sys-block">
                        <div className="card-body">
                          <section className="form-section">
                            <div className="form-section-head">
                              <span className="form-section-icon">
                                <ShieldCheck size={17} />
                              </span>
                              <div>
                                <div className="form-section-title">{t('HTTPS-Einstellungen')}</div>
                                <div className="form-section-sub">
                                  {rich(
                                    'Die Zeilen unter {marker}, eine je Feld. Sie gelten für jeden Dienst und werden so übernommen, wie sie hier stehen.',
                                    { marker: <code>{HTTPS_MARKER}</code> }
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="form-list">
                              {value.httpsLines.map((line, index) => (
                                <div className="form-list-row" key={index}>
                                  <span className="hapm-line-no">{String(index + 1).padStart(2, '0')}</span>
                                  <input
                                    className="form-input mono"
                                    value={line}
                                    onChange={(e) =>
                                      edit(row, {
                                        httpsLines: value.httpsLines.map((l, i) =>
                                          i === index ? e.target.value : l
                                        ),
                                      })
                                    }
                                    placeholder="option forwardfor"
                                    spellCheck={false}
                                    autoComplete="off"
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-icon"
                                    data-tooltip={t('Zeile entfernen')}
                                    aria-label={t('Zeile entfernen')}
                                    disabled={value.httpsLines.length === 1}
                                    onClick={() =>
                                      edit(row, {
                                        httpsLines: value.httpsLines.filter((_, i) => i !== index),
                                      })
                                    }
                                  >
                                    <X size={16} />
                                  </button>
                                </div>
                              ))}
                            </div>

                            <div>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => edit(row, { httpsLines: [...value.httpsLines, ''] })}
                              >
                                <Plus size={14} />
                                {t('Zeile hinzufügen')}
                              </button>
                            </div>

                            <div className="form-note">
                              <Info size={14} />
                              <span>
                                {rich(
                                  'Jede Zeile geht unverändert in die Konfiguration. Geprüft wird sie von HAProxy selbst ({check}). Ist etwas daran falsch, wird nichts eingesetzt und der Fehler steht im Protokoll des Vorgangs. Kommentare und Zeilen wie {backend} gehen hier nicht: sie würden den Block beenden, und alles darunter stünde danach außerhalb.',
                                  { check: <code>haproxy -c</code>, backend: <code>backend …</code> }
                                )}
                              </span>
                            </div>
                          </section>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {area === 'zugriff' && (
                  <>
                    {noMarker}
                    {value && (
                      <div className="card sys-block">
                        <div className="card-body">
                          <section className="form-section">
                            <div className="form-section-head">
                              <span className="form-section-icon">
                                <Lock size={17} />
                              </span>
                              <div>
                                <div className="form-section-title">{t('Admin-IPs')}</div>
                                <div className="form-section-sub">
                                  {rich(
                                    'Die Adressen, die einen gesperrten Eintrag noch erreichen. Sie stehen einmal in der Konfiguration ({acl}) und gelten für jeden Eintrag, bei dem das Schloss zu ist.',
                                    { acl: <code>acl admin_ips src …</code> }
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="form-list">
                              {value.adminIps.map((ip, index) => (
                                <div className="form-list-row" key={index}>
                                  <input
                                    className="form-input"
                                    value={ip}
                                    onChange={(e) =>
                                      edit(row, {
                                        adminIps: value.adminIps.map((a, i) =>
                                          i === index ? e.target.value : a
                                        ),
                                      })
                                    }
                                    placeholder={t('203.0.113.7 oder 10.0.0.0/8')}
                                    autoComplete="off"
                                  />
                                  <button
                                    type="button"
                                    className="btn btn-ghost btn-icon"
                                    data-tooltip={t('Zeile entfernen')}
                                    aria-label={t('Zeile entfernen')}
                                    disabled={value.adminIps.length === 1}
                                    onClick={() =>
                                      edit(row, {
                                        adminIps: value.adminIps.filter((_, i) => i !== index),
                                      })
                                    }
                                  >
                                    <X size={16} />
                                  </button>
                                </div>
                              ))}
                            </div>

                            <div>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => edit(row, { adminIps: [...value.adminIps, ''] })}
                              >
                                <Plus size={14} />
                                {t('Adresse hinzufügen')}
                              </button>
                            </div>

                            {row.settings && row.settings.lockedServices.length > 0 ? (
                              <div className="form-note">
                                <Lock size={14} />
                                <span>
                                  {t(
                                    'Gesperrt sind gerade: {services}. Solange das so ist, lässt sich die Liste nicht leeren.',
                                    { services: row.settings.lockedServices.join(', ') }
                                  )}
                                  <InfoHint
                                    text={t(
                                      'Eine Regel auf eine Adressliste, die es nicht mehr gibt, lässt HAProxy beim nächsten Start stehen.'
                                    )}
                                  />
                                </span>
                              </div>
                            ) : (
                              <div className="form-note">
                                <Info size={14} />
                                <span>
                                  {t('Kein Eintrag ist gesperrt. Das Schloss dafür sitzt auf der Karte des jeweiligen Ziels.')}
                                </span>
                              </div>
                            )}

                            {/* Der Text in EINEM `span`: `.alert` ist ein Flex-Kasten,
                                und ein `code` als direktes Kind wird darin zu einer
                                eigenen Spalte. */}
                            {row.settings && !row.settings.adminEditable && (
                              <div className="alert alert-warning">
                                <span>
                                  {rich(
                                    '{acl} steht mehr als einmal in der Konfiguration. HAProxy verodert die Zeilen; sie hier zu einer zusammenzuschreiben wäre eine Änderung, die niemand angefordert hat.',
                                    { acl: <code>acl admin_ips src …</code> }
                                  )}
                                </span>
                              </div>
                            )}
                          </section>
                        </div>
                      </div>
                    )}
                    {value && (
                      <div className="card sys-block">
                        <div className="card-header">
                          <div>
                            <div className="card-title">
                              <ShieldAlert size={17} />
                              {t('Zugriffsschutz')}
                            </div>
                            <div className="card-subtitle">
                              {t('Gesperrte Adressen und Länder, Ratenbegrenzung. Gilt für jeden Dienst.')}
                            </div>
                          </div>
                        </div>
                        <div className="card-body">
                          <ProtectionSection
                            value={value.protection}
                            onChange={(protection) => edit(row, { protection })}
                            context={protectionContext}
                            hasAdminIps={value.adminIps.some((ip) => ip.trim() !== '')}
                          />
                        </div>
                      </div>
                    )}
                  </>
                )}

                {area === 'dns' && !row.error && (
                  <div className="card sys-block">
                    <div className="card-body">
                      <section className="form-section">
                        <div className="form-section-head">
                          <span className="form-section-icon">
                            <KeyRound size={17} />
                          </span>
                          <div>
                            <div className="form-section-title">{t('DNS-Zugangsdaten für Wildcards')}</div>
                            <div className="form-section-sub">
                              {rich(
                                'Eine Wildcard gibt es nur über DNS-01, und eine interne Installation stellt jedes Zertifikat so aus. Die Zugangsdaten liegen in der Konfiguration von {acme} und werden dort für jede Erneuerung wiederverwendet. Anzeigen lassen sie sich danach nicht mehr.',
                                { acme: <code>acme.sh</code> }
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Eine Zeile je hinterlegtem Token, sonst nichts. Vorher
                            stand hier je Anbieter ein aufgeklappter Block mit
                            Eingabefeldern — auch für den, den niemand benutzt. Ein
                            Formular, das immer offen steht, ist keine Auskunft
                            darüber, was eingerichtet ist. */}
                        <div className="form-list">
                          {configuredProviders(row).length === 0 ? (
                            <div className="form-list-empty">{t('Keine Zugangsdaten hinterlegt.')}</div>
                          ) : (
                            configuredProviders(row).map((provider) => (
                              <div className="form-list-row" key={provider.hook}>
                                <span style={{ flex: 1, minWidth: 0 }}>{provider.label}</span>
                                <span className="badge-status badge-success">
                                  <span className="dot" />
                                  {hasCredentialForm(provider) ? t('Zugangsdaten gesetzt') : t('Token gesetzt')}
                                </span>
                                {/* Kein Bearbeiten: der Token lässt sich nicht
                                    anzeigen, ein Feld daneben hieße also „leer =
                                    unverändert" und wäre die Stelle, an der man
                                    versehentlich nichts ändert. Wechseln heißt
                                    entfernen und neu hinterlegen. */}
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-icon"
                                  data-tooltip={t('Zugangsdaten entfernen')}
                                  aria-label={t('Zugangsdaten entfernen')}
                                  disabled={savingCred === `${row.$id}|${provider.hook}`}
                                  onClick={() => removeCredentials(row, provider)}
                                >
                                  {savingCred === `${row.$id}|${provider.hook}` ? (
                                    <Loader2 size={16} className="spin" />
                                  ) : (
                                    <Trash2 size={16} />
                                  )}
                                </button>
                              </div>
                            ))
                          )}
                        </div>

                        {addingFor === row.$id ? (
                          <div className="form-subsection">
                            <div className="form-group">
                              <label className="form-label">{t('Anbieter')}</label>
                              <Select
                                value={addHook}
                                onChange={setAddHook}
                                options={missingProviders(row).map((provider) => ({
                                  value: provider.hook,
                                  label: provider.label,
                                }))}
                              />
                            </div>

                            {findDnsProvider(addHook) && (
                              <CredentialFields
                                fields={findDnsProvider(addHook)!.fields}
                                values={Object.fromEntries(
                                  findDnsProvider(addHook)!.fields.map((field) => [
                                    field.name,
                                    credDraft[`${row.$id}|${addHook}|${field.name}`] ?? '',
                                  ])
                                )}
                                onChange={(field, value) =>
                                  setCredDraft((before) => ({ ...before, [`${row.$id}|${addHook}|${field}`]: value }))
                                }
                                skin="form"
                                idPrefix={`cred-${row.$id}`}
                                disabled={savingCred !== null}
                              />
                            )}

                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={cancelAdd}
                                disabled={savingCred !== null}
                              >
                                {t('Abbrechen')}
                              </button>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={
                                  savingCred !== null ||
                                  !hasCredentialInput(`${row.$id}|${addHook}`, findDnsProvider(addHook))
                                }
                                onClick={() => {
                                  const provider = findDnsProvider(addHook);
                                  if (provider) void saveCredentials(row, provider);
                                }}
                              >
                                {savingCred ? (
                                  <Loader2 size={14} className="spin" />
                                ) : (
                                  <Save size={14} />
                                )}
                                {t('Speichern')}
                              </button>
                            </div>

                            {findDnsProvider(addHook) && (
                              <div className="form-note">
                                <Info size={14} />
                                <span>
                                  {findDnsProvider(addHook)!.note ? (
                                    <>{t(findDnsProvider(addHook)!.note!)} </>
                                  ) : null}
                                  {/* Ein Anbieter, den man selbst betreibt, hat keine Konsole. */}
                                  {findDnsProvider(addHook)!.consoleUrl && (
                                    <a
                                      href={findDnsProvider(addHook)!.consoleUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                    >
                                      {t('Token beim Anbieter anlegen')}
                                    </a>
                                  )}
                                </span>
                              </div>
                            )}
                          </div>
                        ) : (
                          /* Der Knopf verschwindet, wenn jeder Anbieter der Liste
                             schon einen Token hat: einer, der dasteht und nur noch
                             eine leere Auswahl öffnet, ist keine Auskunft. */
                          missingProviders(row).length > 0 && (
                            <div>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => startAdd(row)}
                              >
                                <Plus size={14} />
                                {t('Hinzufügen')}
                              </button>
                            </div>
                          )
                        )}

                        {configuredProviders(row).some((provider) => provider.fixedWait) && <DnsWaitSetting />}
                      </section>
                    </div>
                  </div>
                )}
              </Fragment>
            );
          })
        ))}

    </>
  );
}
