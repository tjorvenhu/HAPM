'use client';

import { useEffect, useState, type FormEvent } from 'react';
import ErrorNote from '@/components/ErrorNote';
import { Plus, Loader2, X, Cable, Server, ShieldAlert, Info, Check } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import Select from '@/components/Select';
import { InfoHint } from '@/ui/primitives/InfoHint';
import IpAllowList from '@/components/IpAllowList';
import { WEIGHT_MAX, WEIGHT_MIN, readWeight, type HaproxyScope } from '@/lib/haproxy/config';
import {
  STREAM_BALANCE,
  STREAM_BALANCE_LABELS,
  STREAM_BALANCE_HINTS,
  STREAM_PORT_MAX,
  STREAM_PORT_MIN,
  validateNewStream,
  validateStreamInput,
  type CreateStreamInput,
  type HaproxyStream,
  type StreamBalance,
} from '@/lib/haproxy/streams';
import { useT } from '@/lib/i18n/react';
import type { ProxyRow } from './types';
import SavedTargetPick, { useSavedTargets } from './SavedTargetPick';

/**
 * Anlegen und Bearbeiten einer TCP-Weiterleitung.
 *
 * Ein eigener Dialog und nicht ein Zweig in `ServiceFormModal`: von dessen
 * dreißig Feldern gälten hier vier. Es gibt keine Domain, kein Zertifikat,
 * keinen DNS-Eintrag, keine Header, keine Pfad-Regeln und keine Sperre über die
 * Admin-IPs — dafür einen Port der Maschine, der danach offen ist.
 *
 * ── Der Port ist die Entscheidung ──
 *
 * Er wird geprüft, während jemand tippt, und zwar auf der Maschine. Der Grund
 * steht in `lib/haproxy/streams.ts`: `haproxy -c` bindet keine Sockets, ein
 * doppelt vergebener Port kommt also durch die Prüfung und scheitert erst beim
 * Reload. Die Antwort kann hier niemand rechnen — sie steht in `ss -Hltn` auf
 * dem Proxy.
 *
 * ── Die Absenderliste steht ganz oben und nicht unten ──
 *
 * Ein Port ohne sie ist von überall erreichbar. Bei einem HTTP-Dienst hinter
 * einem Zertifikat ist das der Normalfall; bei einer durchgereichten Datenbank
 * ist es die Sorte Entscheidung, die man trifft, ohne sie zu treffen. Deshalb
 * steht sie im Formular und trägt eine Warnfläche, solange sie leer ist.
 */

interface ServerRow {
  name: string;
  target: string;
  /** Als Text: ein Zahlenfeld liefert beim Leeren `''` und nicht `0`, und leer
   *  heißt „keine `weight`-Angabe" und nicht 1. */
  weight: string;
}

const EMPTY_SERVER: ServerRow = { name: '', target: '', weight: '' };

/**
 * Was im Portfeld stehen darf.
 *
 * `max` auf einem `type="number"` hält nur die Pfeiltasten auf; getippt wird
 * jede Zahl, und `validateStreamInput` sperrte danach den Speichern-Knopf, ohne
 * dass irgendwo stand, warum. Ein Port über 65535 existiert nicht — er wird
 * deshalb gar nicht erst angenommen, statt eine Meldung zu erzeugen.
 *
 * Der leere Wert bleibt erlaubt: wer das Feld leert, um eine andere Zahl zu
 * tippen, soll das können.
 */
function readPortField(raw: string, previous: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  if (digits === '') return '';
  return Number(digits) > STREAM_PORT_MAX ? previous : digits;
}

interface Props {
  /** Die Antwort von `/api/haproxy/services`: in HAPM genau ein Eintrag. */
  proxies: ProxyRow[];
  /** Gesetzt heißt bearbeiten. */
  edit: { proxy: ProxyRow; stream: HaproxyStream } | null;
  defaultScope: HaproxyScope;
  onClose: () => void;
  onStarted: (run: {
    id: string;
    label: string;
    serviceId: string;
    title: string;
    isNew: boolean;
  }) => void;
}

/** Was der Port-Test sagt. `null` heißt: noch nicht gefragt. */
interface PortCheck {
  free: boolean;
  reason: string | null;
}

export default function StreamFormModal({
  proxies,
  edit,
  defaultScope,
  onClose,
  onStarted,
}: Props) {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const { t, rich } = useT();

  /* Anders als bei einem Dienst zählt `acmeReady` hier nicht: eine
   * TCP-Weiterleitung braucht kein Zertifikat. Ohne acme.sh lässt sich ein
   * Port trotzdem durchreichen. */
  const usable = proxies.filter((p) => !p.error);
  /** Die Kennung, beim Bearbeiten. Eine neue Weiterleitung hat noch keine: sie
   *  ergibt sich aus dem Port (`tcp_5432`) und wird beim Anlegen auf dem Server
   *  vergeben. Danach bleibt sie, auch wenn sich der Port ändert. */
  const editingId = edit?.stream.id ?? null;

  const [saving, setSaving] = useState(false);
  /** Nur die Prüfung vor dem Absenden. Was die Route antwortet, ist eine Meldung. */
  const [formError, setFormError] = useState('');
  /** Es gibt genau einen HAProxy. Die Kennung geht weiter im Rumpf mit, weil
   *  die Routen und die Historie sie tragen. */
  const serverId = edit?.proxy.$id ?? usable[0]?.$id ?? '';
  const [port, setPort] = useState(edit?.stream.port ? String(edit.stream.port) : '');
  const savedTargets = useSavedTargets();
  const [servers, setServers] = useState<ServerRow[]>(
    edit && edit.stream.servers.length > 0
      ? edit.stream.servers.map((s) => ({
          name: s.name,
          target: s.target,
          weight: s.weight === null ? '' : String(s.weight),
        }))
      : [{ ...EMPTY_SERVER }]
  );
  const [balance, setBalance] = useState<StreamBalance | null>(edit?.stream.balance ?? null);
  /** Vorbelegt an: eine Verbindungsprobe ist bei TCP das Einzige, was sich
   *  überhaupt prüfen lässt, und ohne sie weiß HAProxy von einem toten Ziel
   *  nichts. */
  const [check, setCheck] = useState(edit?.stream.check ?? true);
  const [allowedSources, setAllowedSources] = useState<string[]>(
    edit?.stream.allowedSources ?? []
  );

  /** Die Gruppe der Oberfläche steht nicht zur Wahl, außer der Eintrag liegt
   *  schon darin (`refuseSurfaceScopeEntry`, dieselbe Regel wie die Route). */
  const surfaceScope = proxies.find((p) => p.$id === serverId)?.surface?.scope?.toUpperCase() ?? null;
  const scopeOptions = (proxies.find((p) => p.$id === serverId)?.scopes ?? []).filter(
    (s) =>
      s.complete &&
      (surfaceScope === null || s.name.toUpperCase() !== surfaceScope || edit?.stream.scope?.toUpperCase() === surfaceScope)
  );
  const [scope, setScope] = useState<HaproxyScope>(
    edit?.stream.scope ??
      (scopeOptions.some((s) => s.name === defaultScope) ? defaultScope : (scopeOptions[0]?.name ?? defaultScope))
  );

  /** Ab dem zweiten Ziel wird verteilt, und erst dann bedeutet eine Gewichtung
   *  etwas. Dieselbe Regel wie im Lastverteilungs-Formular. */
  const balancing = servers.length > 1;

  const input: CreateStreamInput = {
    scope,
    // Leer heißt beim Anlegen: der Server vergibt sie.
    id: editingId ?? '',
    port: Number(port.trim()),
    servers: servers
      .map((s) => ({
        name: s.name.trim(),
        target: s.target.trim(),
        // Nur, wenn es überhaupt etwas zu verteilen gibt. Sonst stünde eine
        // `weight`-Angabe in einer Zeile, in der sie nichts bedeutet.
        weight: balancing ? readWeight(s.weight) : null,
      }))
      .filter((s) => s.target),
    balance,
    check,
    // Die Liste hält eine leere Zeile bereit, damit man tippen kann, ohne
    // vorher auf „hinzufügen" zu drücken. Sie ist keine Adresse.
    allowedSources: allowedSources.map((s) => s.trim()).filter(Boolean),
  };
  // Dieselbe Funktion, die die Route aufruft.
  const inputError = editingId ? validateStreamInput(input) : validateNewStream(input);
  /** Ein leeres Formular ist nicht falsch ausgefüllt, sondern noch gar nicht:
   *  die Meldung zu `inputError` steht erst da, wenn etwas eingetragen ist. */
  const started = port !== '' || input.servers.length > 0 || input.allowedSources.length > 0;

  /* ── Der Port, geprüft auf der Maschine ──
   *
   * Entprellt, weil die Frage an einem Feld hängt, in das gerade jemand tippt:
   * ohne die halbe Sekunde wäre jede Ziffer von „15432" eine Abfrage.
   *
   * Ein Fehlschlag bleibt still. Die Prüfung ist zusätzlich — was die
   * Konfiguration selbst hergibt, prüft `addStream` ohnehin noch einmal
   * innerhalb des Locks, und ein Formular, das sich sperrt, weil die Abfrage
   * gerade scheitert, hilft niemandem.
   *
   * Die Antwort trägt den Port, nach dem gefragt wurde. Hinweis, Warnfläche
   * und die Sperre des Knopfs gälten sonst für den vorigen Port, bis die
   * nächste Antwort da ist, und nach einem Fehlschlag auf Dauer.
   */
  const [portAnswer, setPortAnswer] = useState<{ port: number; check: PortCheck } | null>(null);
  const [portChecking, setPortChecking] = useState(false);
  const portNumber = input.port;
  const portCheck = portAnswer?.port === portNumber ? portAnswer.check : null;

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      if (
        !serverId ||
        !Number.isInteger(portNumber) ||
        portNumber < STREAM_PORT_MIN ||
        portNumber > STREAM_PORT_MAX
      ) {
        setPortAnswer(null);
        // Eine Abfrage von vorhin setzt ihn nicht mehr zurück: sie ist beim
        // Leeren des Felds abgehängt worden.
        setPortChecking(false);
        return;
      }
      setPortChecking(true);
      const query = new URLSearchParams({ serverId, port: String(portNumber) });
      // Beim Bearbeiten der eigene Abschnitt: ohne ihn meldete der Test einen
      // Konflikt mit sich selbst, sobald der Port bleibt.
      if (editingId) query.set('exclude', editingId);

      apiFetch(`/api/haproxy/streams?${query.toString()}`)
        .then((res) => res.json())
        .then((data) => {
          if (live) {
            setPortAnswer(data.success ? { port: portNumber, check: data.data as PortCheck } : null);
          }
        })
        .catch(() => {
          if (live) setPortAnswer(null);
        })
        .finally(() => {
          if (live) setPortChecking(false);
        });
    }, 500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [serverId, portNumber, editingId, apiFetch]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (inputError) {
      setFormError(t(inputError));
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const res = await apiFetch(
        editingId
          ? `/api/haproxy/streams/${encodeURIComponent(editingId)}`
          : '/api/haproxy/streams',
        {
          method: editingId ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId, ...input }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      // Die Kennung einer neuen Weiterleitung steht in der Antwort.
      const startedId: string = editingId ?? data.data.serviceId;
      onStarted({
        id: data.data.runId,
        label: editingId
          ? t('TCP-Weiterleitung „{id}“ ändern', { id: startedId })
          : t('TCP-Weiterleitung „{id}“ anlegen', { id: startedId }),
        serviceId: startedId,
        title: t('Port {port}', { port: input.port }),
        isNew: !editingId,
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t(editingId ? 'Speichern fehlgeschlagen' : 'Anlegen fehlgeschlagen'),
        message: errorText(
          err,
          t(
            editingId
              ? 'Die TCP-Weiterleitung ließ sich nicht speichern.'
              : 'Die TCP-Weiterleitung ließ sich nicht anlegen.'
          )
        ),
      });
    } finally {
      // Auch nach `onStarted`: schließt die Seite den Dialog nicht, bliebe der
      // Knopf sonst für immer gesperrt.
      setSaving(false);
    }
  }

  return (
    <div
      className="modal-overlay"
      onClick={(e) => e.target === e.currentTarget && !saving && onClose()}
    >
      <div className="modal modal-form">
        <div className="modal-header">
          <h2 className="modal-title">
            {t(editingId ? 'TCP-Weiterleitung bearbeiten' : 'TCP-Weiterleitung anlegen')}
            {editingId && <span className="modal-subject">{editingId}</span>}
          </h2>
          <button
            type="button"
            className="modal-close"
            onClick={() => onClose()}
            disabled={saving}
            aria-label={t('Dialog schließen')}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {formError && <div className="alert alert-danger"><ErrorNote text={formError} /></div>}

            <div className="form-columns">
              <div className="form-col">
                <section className="form-section">
                  <div className="form-section-head">
                    <span className="form-section-icon">
                      <Cable size={17} />
                    </span>
                    <div>
                      <div className="form-label-row">
                        <div className="form-section-title">{t('Allgemein')}</div>
                        <InfoHint text={t('Kein HTTP, kein Zertifikat: was durchgeht, sieht HAProxy nicht an.')} />
                      </div>
                      <div className="form-section-sub">
                        {t('Ein Port dieses Servers, durchgereicht an ein Ziel dahinter.')}
                      </div>
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label">{t('Gruppe')}</label>
                    <Select
                      value={scope}
                      onChange={setScope}
                      options={scopeOptions.map((s) => ({ value: s.name, label: s.label }))}
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">
                      {t('Port auf diesem Server')}
                      <InfoHint
                        text={t(
                          editingId
                            ? 'Die Kennung des listen-Abschnitts bleibt, auch wenn sich der Port ändert.'
                            : 'Aus dem Port ergibt sich die Kennung des listen-Abschnitts, zum Beispiel tcp_5432.'
                        )}
                      />
                    </label>
                    <input
                      className="form-input"
                      type="number"
                      min={STREAM_PORT_MIN}
                      max={STREAM_PORT_MAX}
                      value={port}
                      onChange={(e) => setPort((prev) => readPortField(e.target.value, prev))}
                      placeholder="5432"
                      required
                    />
                    {/* Der Zustand des Ports steht direkt unter dem Feld und
                        nicht als Meldung beim Speichern: er ist die einzige
                        Frage dieses Formulars, die sich hier nicht
                        beantworten lässt. */}
                    <span className="form-hint">
                      {portChecking ? (
                        <>
                          <Loader2 size={12} className="spin" /> {t('Wird auf dem Server geprüft…')}
                        </>
                      ) : portCheck === null ? (
                        t('{min} bis {max}. HAProxy lauscht danach auf allen Adressen des Servers.', {
                          min: STREAM_PORT_MIN,
                          max: STREAM_PORT_MAX,
                        })
                      ) : portCheck.free ? (
                        <>
                          <Check size={12} /> {t('Frei.')}{' '}
                          {portCheck.reason
                            ? t(portCheck.reason)
                            : t('Weder in der Konfiguration noch auf dem Server belegt.')}
                        </>
                      ) : (
                        <>
                          {portCheck.reason
                            ? t('Belegt: {reason}', { reason: t(portCheck.reason) })
                            : t('Belegt.')}
                        </>
                      )}
                    </span>
                    {editingId && (
                      <span className="form-hint">
                        {rich('Kennung: {id}', { id: <code>{editingId}</code> })}
                      </span>
                    )}
                  </div>

                  {/* ── Was HAPM NICHT tut ──
                      Er schreibt eine Zeile in `haproxy.cfg` und lädt HAProxy
                      neu, mehr nicht. Eine Firewall, die den Port verwirft,
                      sieht davon nichts: die Prüfung geht durch, der Reload
                      geht durch, der Eintrag steht grün in der Liste — und von
                      außen kommt trotzdem niemand an. Genau die Sorte
                      Fehlersuche, die einen Nachmittag kostet, wenn es hier
                      nicht steht. */}
                  <div className="alert alert-info">
                    <ShieldAlert size={16} />
                    <span>
                      <strong>{t('Die Firewall macht dieser Vorgang nicht auf.')}</strong>{' '}
                      {t('Er ändert nur die HAProxy-Konfiguration. Damit der Port von außen erreichbar ist, muss er zusätzlich freigegeben sein: auf diesem Server selbst (nftables, ufw, firewalld) und, falls davor eine liegt, in der Firewall des Anbieters oder der Cloud. Ohne das läuft der Eintrag hier durch und die Verbindung von außen bleibt trotzdem hängen.')}
                    </span>
                  </div>

                  {/* Rot und nicht gelb: das ist keine Warnung, über die man
                      hinweggehen kann — mit diesem Port wird der Vorgang
                      abgelehnt, und der Knopf unten ist gesperrt.

                      Der Text steht in EINEM `span`. `.alert` ist ein
                      Flex-Kasten, und ein `code` als direktes Kind wird darin
                      zu einer eigenen Spalte: der Satz stand in drei Spalten
                      nebeneinander, und `overflow-wrap: anywhere` zerlegte
                      „haproxy" dabei in „haprox / y". */}
                  {portCheck && !portCheck.free && (
                    <div className="alert alert-danger">
                      <ShieldAlert size={16} />
                      <span>
                        <strong>{t('Port {port} ist belegt.', { port: input.port })}</strong>{' '}
                        {portCheck.reason ? `${t(portCheck.reason)} ` : ''}
                        {t('Ein zweiter Abschnitt auf demselben Port kommt durch die Konfigurationsprüfung und scheitert erst beim Neuladen: sie liest die Datei, sie bindet keine Sockets. Der Vorgang wird deshalb hier abgelehnt.')}
                      </span>
                    </div>
                  )}
                </section>

                {/* ── Wer darf ── */}
                <section className="form-section">
                  <div className="form-section-head">
                    <span className="form-section-icon">
                      <ShieldAlert size={17} />
                    </span>
                    <div>
                      <div className="form-label-row">
                        <div className="form-section-title">{t('Erreichbar von')}</div>
                        <InfoHint
                          text={t(
                            'Eine eigene Liste je Eintrag und nicht die Admin-IPs. Wer an eine Datenbank darf, ist eine andere Frage als wer eine Verwaltungsoberfläche sehen darf.'
                          )}
                        />
                      </div>
                      <div className="form-section-sub">{t('Leer heißt: von jeder Adresse im Internet.')}</div>
                    </div>
                  </div>

                  {/* Ohne eigene Überschrift: der Abschnitt trägt schon eine,
                      und die der Komponente spricht von einem Token. */}
                  <IpAllowList
                    value={allowedSources}
                    onChange={setAllowedSources}
                    heading={false}
                    emptyHint={t('Adresse oder CIDR-Bereich, IPv4 und IPv6. Eine Zeile pro Absender.')}
                  />

                  {input.allowedSources.length === 0 ? (
                    <div className="alert alert-warning">
                      <ShieldAlert size={16} />
                      <span>
                        {t('Der Port ist danach von überall erreichbar. Für einen Dienst, der selbst keine Anmeldung verlangt, ist das die Sorte Entscheidung, die man trifft, ohne sie zu treffen.')}
                      </span>
                    </div>
                  ) : (
                    <div className="form-note">
                      <Info size={14} />
                      <span>
                        {rich(
                          'Abgewiesen wird die Verbindung, bevor ein einziges Byte gelesen wird ({rule}). Für den Absender sieht das aus, als wäre nichts da.',
                          { rule: <code>{'tcp-request connection reject'}</code> }
                        )}
                      </span>
                    </div>
                  )}
                </section>
              </div>

              <div className="form-col">
                {/* ── Wohin ── */}
                <section className="form-section">
                  <div className="form-section-head">
                    <span className="form-section-icon">
                      <Server size={17} />
                    </span>
                    <div>
                      <div className="form-section-title">{t('Ziele')}</div>
                      <div className="form-section-sub">
                        {t('Wohin die Verbindungen gehen. Mehr als eines heißt Lastverteilung.')}
                      </div>
                    </div>
                  </div>

                  <div className="form-list">
                    <div className="form-list-head">
                      <span style={{ flex: 1 }}>{t('Adresse')}</span>
                      <span className="hapm-target-pick" />
                      {/* Erst ab dem zweiten Ziel: bei einem gibt es nichts zu
                          verteilen, und ein Feld ohne Frage füllt irgendwann
                          jemand aus. Dieselbe Regel wie im
                          Lastverteilungs-Formular. */}
                      {balancing && <span style={{ width: 76 }}>{t('Gewicht')}</span>}
                      <span style={{ width: 34 }} />
                    </div>
                    {servers.map((server, index) => (
                      <div className="form-list-row" key={index}>
                        <input
                          className="form-input"
                          value={server.target}
                          onChange={(e) =>
                            setServers(
                              servers.map((s, i) =>
                                i === index ? { ...s, target: e.target.value } : s
                              )
                            )
                          }
                          placeholder="10.10.0.50:5432"
                          autoComplete="off"
                        />
                        <SavedTargetPick
                          targets={savedTargets}
                          address={server.target}
                          onPick={(target) =>
                            setServers(servers.map((s, i) => (i === index ? { ...s, target } : s)))
                          }
                        />
                        {balancing && (
                          <input
                            className="form-input"
                            style={{ width: 76, flex: '0 0 76px' }}
                            type="number"
                            min={WEIGHT_MIN}
                            max={WEIGHT_MAX}
                            value={server.weight}
                            onChange={(e) =>
                              setServers(
                                servers.map((s, i) =>
                                  i === index ? { ...s, weight: e.target.value } : s
                                )
                              )
                            }
                            placeholder="1"
                            aria-label={t('Gewicht von Ziel {number}', { number: index + 1 })}
                          />
                        )}
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          data-tooltip={t('Zeile entfernen')}
                          aria-label={t('Zeile entfernen')}
                          disabled={servers.length === 1}
                          onClick={() => setServers(servers.filter((_, i) => i !== index))}
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
                      onClick={() => setServers([...servers, { ...EMPTY_SERVER }])}
                    >
                      <Plus size={14} />
                      {t('Ziel hinzufügen')}
                    </button>
                  </div>
                  <span className="form-hint">
                    {t('Wie HAProxy das Ziel erreicht. Der Port darf ein anderer sein als hier.')}
                  </span>
                  {balancing && (
                    <span className="form-hint">
                      {rich(
                        'Das Gewicht ist der Anteil eines Ziels im Verhältnis zu den anderen. Leer heißt, dass keine {weight}-Angabe geschrieben wird und HAProxys Vorgabe gilt. {zero} nimmt ein Ziel aus der Verteilung, ohne bestehende Verbindungen zu trennen.',
                        { weight: <code>{'weight'}</code>, zero: <strong>0</strong> }
                      )}
                    </span>
                  )}

                  <div className="form-subsection">
                    <div className="form-group">
                      <div className="form-label-row">
                        <label className="form-label">{t('Verteilverfahren')}</label>
                        {/* „URI Hash" fehlt in der Auswahl, und das ist kein Versehen:
                            es liest den angefragten Pfad, und den gibt es in mode tcp nicht. */}
                        <InfoHint
                          text={
                            balance
                              ? t(STREAM_BALANCE_HINTS[balance])
                              : t('Es wird keine balance-Zeile geschrieben. Dann gilt, was im defaults-Block der Konfiguration steht. URI Hash steht hier nicht zur Wahl: es liest den angefragten Pfad, und den gibt es ohne HTTP nicht.')
                          }
                        />
                      </div>
                      <Select
                        value={balance ?? ''}
                        onChange={(v) => setBalance(v === '' ? null : (v as StreamBalance))}
                        options={[
                          { value: '', label: t('Vorgabe der Konfiguration') },
                          ...STREAM_BALANCE.map((b) => ({
                            value: b,
                            label: t(STREAM_BALANCE_LABELS[b]),
                          })),
                        ]}
                      />
                    </div>

                    <div className="form-subsection-head">
                      <div>
                        <div className="form-section-title">{t('Verbindungsprüfung')}</div>
                        <div className="form-section-sub">
                          {t('HAProxy prüft die Ziele und nimmt ein totes aus dem Betrieb.')}
                        </div>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={check}
                          onChange={(e) => setCheck(e.target.checked)}
                          aria-label={t('Verbindungsprüfung')}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>
                    {/* Eine Folge und kein Hinweis: sie steht als Warnung da. */}
                    {!check && (
                      <div className="alert alert-warning">
                        {t('Aus heißt: über den Zustand der Ziele ist nichts bekannt, und die Karte zeigt keine Farbe. HAProxy schickt Verbindungen auch an ein Ziel, das nicht antwortet.')}
                      </div>
                    )}
                  </div>
                </section>

                <div className="form-note">
                  <Info size={14} />
                  <span>
                    {rich(
                      'Der Abschnitt landet im BACKENDS-Block der Gruppe. Geprüft wird die neue Konfiguration mit {command}, bevor sie eingesetzt wird; scheitert der Reload, kommt das Backup zurück.',
                      { command: <code>{'haproxy -c'}</code> }
                    )}
                  </span>
                </div>

                {/* Der Grund, aus dem der Knopf unten gesperrt ist. Am Fuß wie
                    in `ServiceFormModal`. */}
                {inputError && started && (
                  <div className="alert alert-warning">{t(inputError)}</div>
                )}
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onClose()}
              disabled={saving}
            >
              {t('Abbrechen')}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving || !!inputError || portCheck?.free === false}
            >
              {saving ? <Loader2 size={16} className="spin" /> : <Cable size={16} />}
              {t(editingId ? 'Speichern' : 'Anlegen')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
