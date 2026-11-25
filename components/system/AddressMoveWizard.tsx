'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, Check, Circle, ExternalLink, Globe, Loader2, Play, RefreshCw, Search, X,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { SetupStepper } from '@/app/setup/SetupStepper';
import { useT } from '@/lib/i18n/react';
import { msgid } from '@/lib/i18n';
import { normalizeSetupDomain, validateSetupDomain } from '@/lib/setup/rules';
import { MOVE_STAGE_LABELS, moveOutcome } from '@/lib/address-move/rules';
// Nur Typen: die Datei dahinter erreicht `lib/db` und `lib/ssh`.
import type { AddressMoveCheck, AddressMoveView } from '@/lib/address-move';
import type { AddressMoveStage } from '@/lib/types';
// Schrittleiste und Abschluss sehen aus wie in der Einrichtung.
import '@/app/setup/setup.css';

/**
 * Die Adresse von HAPM ändern, als Assistent in einem Fenster: Adresse,
 * Prüfung, Umzug, dann der Weg zur neuen Adresse. Aufbau und Abschluss wie
 * in der Einrichtung (`app/setup`), der Ablauf in `lib/address-move/`.
 *
 * Während des Umzugs darf das Fenster zu: der Umzug läuft auf dem Server
 * weiter, und `/system` öffnet es wieder, solange er läuft.
 *
 * Wer den Assistenten unter der alten Adresse offen hat, verliert sie mit dem
 * letzten Schritt (das alte Ziel geht weg). Bricht das Pollen danach ab, ist
 * das kein Fehler, sondern genau dieser Schritt: dann steht der Abschluss da,
 * mit dem Hinweis, dass die alte Adresse nicht mehr antwortet.
 */

type Step = 'address' | 'check' | 'move';

const STEP_LABELS = [msgid('Adresse'), msgid('Prüfung'), msgid('Umzug')];
const STEP_INDEX: Record<Step, number> = { address: 0, check: 1, move: 2 };

const PROVIDER_LABELS: Record<string, string> = { cloudflare: 'Cloudflare', hetzner: 'Hetzner' };

/** Eine Abfrage, die länger hängt, gilt als gescheitert. */
const POLL_TIMEOUT_MS = 6000;
/** So viele Fehlschläge in Folge, dann sagt das Fenster, dass die Verbindung hakt. */
const STALL_AFTER = 4;
/** Nach so vielen gibt es den Weg zur neuen Adresse auch ohne bekannten Stand: etwa eine Minute. */
const GIVE_WAY_AFTER = 8;

function stageDone(view: AddressMoveView, key: AddressMoveStage['key']): boolean {
  return (view.move?.stages ?? []).some((stage) => stage.key === key && stage.status === 'ok');
}

/** Die Striche um die Kachel des Abschlusses, wie in der Einrichtung. */
const RAYS = [
  { angle: -60, delay: 0 },
  { angle: -34, delay: 50 },
  { angle: -10, delay: 100 },
  { angle: 150, delay: 30 },
  { angle: 170, delay: 80 },
  { angle: 192, delay: 130 },
];

export default function AddressMoveWizard({
  initial,
  onClose,
  onSavedWithoutMove,
}: {
  /** Der Stand beim Öffnen. Läuft gerade ein Umzug, beginnt der Assistent bei ihm. */
  initial: AddressMoveView;
  onClose: () => void;
  /** Nur die Adresse eingetragen, ohne Ziel und Zertifikat. */
  onSavedWithoutMove: (url: string) => void;
}) {
  const { apiFetch } = useApp();
  const confirm = useConfirm();
  const { notify } = useToast();
  const { t } = useT();

  const runningAtStart = moveOutcome(initial.move) === 'running';
  const [step, setStep] = useState<Step>(runningAtStart ? 'move' : 'address');
  const [view, setView] = useState<AddressMoveView>(initial);
  // Ein laufender oder gescheiterter Umzug bringt seine Domain mit, ein fertiger nicht.
  const [domainDraft, setDomainDraft] = useState(
    initial.move && moveOutcome(initial.move) !== 'succeeded' ? initial.move.domain : ''
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [check, setCheck] = useState<AddressMoveCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [recordAddress, setRecordAddress] = useState<string | null>(null);
  /** Das Pollen bekam keine Antwort mehr, nachdem die neue Adresse galt. */
  const [lostContact, setLostContact] = useState(false);

  const domain = normalizeSetupDomain(domainDraft);
  const currentUrl = view.currentUrl;

  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await apiFetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await res.json();
    if (!body.success) throw new Error(body.error || t('Unbekannter Fehler.'));
    return body.data as T;
  }

  /* ── Schritt 1: Adresse ── */

  function toCheck(e: FormEvent) {
    e.preventDefault();
    const invalid = validateSetupDomain(domain);
    if (invalid) {
      setError(t(invalid));
      return;
    }
    setError('');
    setCheck(null);
    setConfirmed(false);
    setStep('check');
    void runCheck();
  }

  async function saveOnly() {
    const invalid = validateSetupDomain(domain);
    if (invalid) {
      setError(t(invalid));
      return;
    }
    const ok = await confirm({
      title: t('Nur die Adresse eintragen?'),
      message: t(
        'HAPM legt dann weder Zertifikat noch Ziel an und lässt das alte Ziel stehen. Das passt, wenn HAPM hinter einem anderen Reverse-Proxy steht. Alle hinterlegten Passkeys werden gelöscht.'
      ),
      confirmLabel: t('Nur eintragen'),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await request('/api/settings', { method: 'PATCH', body: JSON.stringify({ publicUrl: `https://${domain}` }) });
      onSavedWithoutMove(`https://${domain}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Die Adresse ließ sich nicht speichern.'));
    } finally {
      setBusy(false);
    }
  }

  /* ── Schritt 2: Prüfung ── */

  const runCheck = useCallback(async () => {
    setChecking(true);
    setError('');
    try {
      const res = await apiFetch(`/api/settings/address?domain=${encodeURIComponent(domain)}`);
      const body = await res.json();
      if (!body.success) throw new Error(body.error || t('Die Prüfung ist fehlgeschlagen.'));
      setCheck(body.data as AddressMoveCheck);
    } catch (err) {
      setCheck(null);
      setError(err instanceof Error ? err.message : t('Die Prüfung ist fehlgeschlagen.'));
    } finally {
      setChecking(false);
    }
  }, [apiFetch, domain, t]);

  async function setRecord() {
    if (!check) return;
    const address = (recordAddress ?? view.serverAddresses[0] ?? '').trim();
    const ok = await confirm({
      title: t('DNS-Eintrag anlegen?'),
      message: t('HAPM legt in der Zone {zone} den Eintrag {domain} → {address} an.', {
        zone: check.zone?.name ?? '',
        domain: check.domain,
        address,
      }),
      confirmLabel: t('Eintrag anlegen'),
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const data = await request<{ outcome: string; type: string; zone: string }>('/api/settings/address/dns-record', {
        method: 'PUT',
        body: JSON.stringify({ domain: check.domain, address }),
      });
      notify({
        variant: 'success',
        title: t('DNS-Eintrag angelegt'),
        message: t('Der Eintrag {type} {domain} → {address} steht in der Zone {zone}. Bis ihn jeder sieht, kann es einen Moment dauern.', {
          type: data.type,
          domain: check.domain,
          address,
          zone: data.zone,
        }),
      });
      await runCheck();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Der Eintrag ließ sich nicht anlegen.'));
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError('');
    try {
      const next = await request<AddressMoveView>('/api/settings/address', {
        method: 'POST',
        body: JSON.stringify({ domain, confirmed }),
      });
      setView(next);
      setLostContact(false);
      setStep('move');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Der Umzug ließ sich nicht starten.'));
    } finally {
      setBusy(false);
    }
  }

  /* ── Schritt 3: Umzug ── */

  const outcome = step === 'move' ? moveOutcome(view.move) : 'idle';
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /*
   * Das Pollen läuft über die alte Adresse, und die geht durch jedes Neuladen
   * von HAProxy (Zertifikat, neues Ziel). Eine Anfrage, die dabei hängen
   * bleibt, darf die Anzeige nicht anhalten: jede bekommt ein Zeitlimit, und
   * eine neue geht erst los, wenn die alte fertig ist. Mehrere Fehlschläge in
   * Folge heißen „Verbindung hakt“, nicht „Umzug gescheitert“: der Umzug läuft
   * auf dem Server weiter.
   */
  const failures = useRef(0);
  const inFlight = useRef(false);
  const [stalled, setStalled] = useState(false);
  const [longStall, setLongStall] = useState(false);

  useEffect(() => {
    if (step !== 'move' || outcome !== 'running' || lostContact) return;
    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      const controller = new AbortController();
      const limit = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
      try {
        const res = await apiFetch('/api/settings/address', { cache: 'no-store', signal: controller.signal });
        const body = await res.json();
        if (!body.success) throw new Error(body.error);
        failures.current = 0;
        setStalled(false);
        setLongStall(false);
        setView(body.data as AddressMoveView);
      } catch {
        failures.current += 1;
        // Nach dem Umstellen der Adresse ist das der erwartete Abschluss: das
        // alte Ziel ist weg, und mit ihm diese Seite.
        if (stageDone(viewRef.current, 'publicUrl')) setLostContact(true);
        else if (failures.current >= STALL_AFTER) {
          setStalled(true);
          if (failures.current >= GIVE_WAY_AFTER) setLongStall(true);
        }
      } finally {
        clearTimeout(limit);
        inFlight.current = false;
      }
    };
    const timer = setInterval(() => void tick(), 2000);
    return () => clearInterval(timer);
  }, [apiFetch, step, outcome, lostContact]);

  const moved = view.move?.domain ?? domain;
  const newUrl = `https://${moved}`;
  // Fertig für den Benutzer, sobald die neue Adresse gilt: das Entfernen des
  // alten Ziels läuft im Abschluss weiter und zeigt dort seinen Stand.
  const done = step === 'move' && (outcome === 'succeeded' || lostContact || stageDone(view, 'publicUrl'));

  /* ── Darstellung ── */

  const gateOpen = check !== null && (check.gate === 'go' || (check.gate === 'confirm' && confirmed));

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal hapm-move">
        <div className="modal-header">
          <h2 className="modal-title">
            {done ? t('Umzug abgeschlossen') : initial.currentUrl ? t('Adresse von HAPM ändern') : t('Adresse von HAPM einrichten')}
          </h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('Dialog schließen')} disabled={busy}>
            <X size={18} />
          </button>
        </div>

        {done ? (
          <Done
            url={newUrl}
            stages={view.move?.stages ?? []}
            lostContact={lostContact}
            passkeysGone={Boolean(view.move?.previousUrl)}
          />
        ) : (
          <>
            <div className="modal-body">
              <SetupStepper labels={STEP_LABELS.map((label) => t(label))} current={STEP_INDEX[step]} />

              {step === 'address' && (
                <form id="hapm-move-address" className="hapm-move-step hapm-step-enter" onSubmit={toCheck}>
                  <div className="hapm-move-lead">
                    <h3>{t('Unter welcher Domain soll HAPM erreichbar sein?')}</h3>
                    <p>
                      {currentUrl
                        ? t('Bisher: {url}. HAPM stellt das Zertifikat aus, legt das Ziel an und entfernt danach das alte.', {
                            url: currentUrl,
                          })
                        : t('HAPM stellt das Zertifikat aus und legt das Ziel an.')}
                    </p>
                  </div>
                  <input
                    className="form-input hapm-move-domain"
                    type="text"
                    inputMode="url"
                    value={domainDraft}
                    onChange={(e) => setDomainDraft(e.target.value)}
                    placeholder="hapm.example.org"
                    aria-label={t('Domain')}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    disabled={busy}
                  />
                  {currentUrl && (
                    <div className="alert alert-warning">
                      <span>{t('Alle hinterlegten Passkeys werden dabei gelöscht. Sie sind an die bisherige Domain gebunden und melden unter der neuen niemanden an.')}</span>
                    </div>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm hapm-move-aside" onClick={saveOnly} disabled={busy || !domain}>
                    {t('Nur die Adresse eintragen, ohne Zertifikat und Ziel')}
                  </button>
                </form>
              )}

              {step === 'check' && (
                <div className="hapm-move-step hapm-step-enter">
                  <div className="hapm-move-lead">
                    <h3>{t('Ist {domain} erreichbar?', { domain })}</h3>
                    <p>{t('HAPM fragt das DNS, worauf die Domain zeigt.')}</p>
                  </div>

                  {checking && !check && (
                    <div className="hapm-move-waiting">
                      <Loader2 size={16} className="spin" />
                      {t('Wird geprüft')}
                    </div>
                  )}

                  {check && (
                    <CheckResult check={check} view={view}>
                      {check?.recordOffer && (
                        <div className="hapm-setup-note">
                          <div className="hapm-setup-note-head">
                            <strong>
                              {t('HAPM kann den Eintrag bei {provider} anlegen', {
                                provider: PROVIDER_LABELS[check.zone?.provider ?? ''] ?? check.zone?.provider ?? '',
                              })}
                            </strong>
                          </div>
                          <div className="hapm-move-record">
                            <span className="hapm-move-record-name">
                              {check.domain} <span className="hapm-muted">→</span>
                            </span>
                            <input
                              className="form-input"
                              value={recordAddress ?? view.serverAddresses[0] ?? ''}
                              onChange={(e) => setRecordAddress(e.target.value)}
                              placeholder="192.0.2.10"
                              aria-label={t('Adresse, auf die der Eintrag zeigt')}
                              autoComplete="off"
                              spellCheck={false}
                              disabled={busy}
                            />
                            <InfoHint text={t('Es muss die öffentliche Adresse dieses Servers sein. Hinter einer Adressumsetzung (NAT) ist das nicht die Adresse, die der Server selbst trägt.')} />
                            <button type="button" className="btn btn-primary btn-sm" onClick={setRecord} disabled={busy}>
                              {busy ? <Loader2 size={14} className="spin" /> : <Globe size={14} />}
                              {t('Eintrag anlegen')}
                            </button>
                          </div>
                        </div>
                      )}
                    </CheckResult>
                  )}


                  {check?.gate === 'confirm' && (
                    <label className="hapm-switch-row">
                      <span className="hapm-switch-text">
                        <span>{t('Die Domain führt trotzdem zu diesem Server, etwa über eine Adressumsetzung (NAT).')}</span>
                      </span>
                      <span className="toggle-switch">
                        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                        <span className="toggle-slider" />
                      </span>
                    </label>
                  )}

                  {check && (
                    <div>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void runCheck()} disabled={checking || busy}>
                        {checking ? <Loader2 size={14} className="spin" /> : <Search size={14} />}
                        {t('Erneut prüfen')}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {step === 'move' && (
                <div className="hapm-move-step hapm-step-enter">
                  <div className="hapm-move-lead">
                    <h3>{outcome === 'failed' ? t('Der Umzug ist nicht durchgelaufen') : t('HAPM zieht nach {domain} um', { domain: moved })}</h3>
                    <p>
                      {outcome === 'failed'
                        ? t('Was einen Haken trägt, bleibt bestehen. Die bisherige Adresse gilt weiter, bis der Schritt „Adresse von HAPM umstellen“ durch ist.')
                        : t('Das dauert einige Minuten. Das Fenster darf zu, der Umzug läuft weiter.')}
                    </p>
                  </div>
                  <MoveStages stages={view.move?.stages ?? []} />
                  {stalled && (
                    <div className="alert alert-info">
                      <span>
                        {stageDone(view, 'service')
                          ? t('Diese Adresse antwortet gerade nicht, etwa weil HAProxy neu lädt. Der Umzug läuft auf dem Server weiter, und unter der neuen Adresse ist HAPM schon erreichbar.')
                          : t('Diese Adresse antwortet gerade nicht, etwa weil HAProxy neu lädt. Der Umzug läuft auf dem Server weiter, die Anzeige holt auf, sobald sie wieder antwortet.')}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {error && <div className="alert alert-danger"><span>{error}</span></div>}
            </div>

            <div className="modal-footer">
              {step === 'address' && (
                <>
                  <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
                    {t('Abbrechen')}
                  </button>
                  <button type="submit" form="hapm-move-address" className="btn btn-primary" disabled={busy || !domain}>
                    <ArrowRight size={16} />
                    {t('Weiter')}
                  </button>
                </>
              )}
              {step === 'check' && (
                <>
                  <button type="button" className="btn btn-secondary" onClick={() => { setError(''); setStep('address'); }} disabled={busy}>
                    <ArrowLeft size={16} />
                    {t('Zurück')}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={start} disabled={busy || checking || !gateOpen}>
                    {busy ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
                    {t('Umzug starten')}
                  </button>
                </>
              )}
              {step === 'move' && outcome === 'running' && (
                <>
                  <button type="button" className="btn btn-secondary" onClick={onClose}>
                    {t('Im Hintergrund weiterlaufen lassen')}
                  </button>
                  {stalled && (stageDone(view, 'service') || longStall) && (
                    <a className="btn btn-primary" href={newUrl}>
                      <ExternalLink size={16} />
                      {t('Neue Adresse öffnen')}
                    </a>
                  )}
                </>
              )}
              {step === 'move' && outcome === 'failed' && (
                <>
                  <button type="button" className="btn btn-secondary" onClick={onClose}>
                    {t('Schließen')}
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => { setCheck(null); setStep('check'); void runCheck(); }}>
                    <RefreshCw size={16} />
                    {t('Erneut versuchen')}
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CheckResult({
  check,
  view,
  children,
}: {
  check: AddressMoveCheck;
  view: AddressMoveView;
  /** Was direkt unter das Ergebnis gehört: das Angebot, den Eintrag anzulegen. */
  children?: ReactNode;
}) {
  const { t } = useT();
  const where = check.resolved?.join(', ') ?? '';
  const provider = PROVIDER_LABELS[check.zone?.provider ?? ''] ?? check.zone?.provider ?? '';

  const verdict =
    check.verdict === 'matches'
      ? { tone: 'alert-success', text: t('{domain} zeigt auf diesen Server ({where}).', { domain: check.domain, where }) }
      : check.verdict === 'elsewhere'
        ? {
            tone: 'alert-warning',
            text: t('{domain} zeigt auf {where}. Das ist keine Adresse, die dieser Server selbst trägt. Hinter einer Adressumsetzung (NAT) kann das trotzdem stimmen.', {
              domain: check.domain,
              where,
            }),
          }
        : check.verdict === 'unresolved'
          ? {
              tone: 'alert-danger',
              text: check.recordOffer
                ? t('Für {domain} gibt es noch keinen DNS-Eintrag. Ohne ihn wäre HAPM nach dem Umzug nicht mehr erreichbar.', { domain: check.domain })
                : t('Für {domain} gibt es noch keinen DNS-Eintrag. Legen Sie ihn an und prüfen Sie dann erneut. Ohne ihn wäre HAPM nach dem Umzug nicht mehr erreichbar.', {
                    domain: check.domain,
                  }),
            }
          : { tone: 'alert-warning', text: t('Die DNS-Abfrage ist gescheitert. Ob der Eintrag stimmt, ließ sich nicht prüfen.') };

  return (
    <>
      <div className={`alert ${verdict.tone}`}>
        <span>{verdict.text}</span>
      </div>
      {children}
      <div className="hapm-setup-note">
        <dl className="detail-grid">
          <dt>{t('Dieser Server')}</dt>
          <dd>{view.serverAddresses.join(', ') || t('Die Adresse ließ sich nicht ermitteln.')}</dd>
          <dt>{t('Zertifikat')}</dt>
          <dd>
            {check.certificate
              ? t('liegt schon vor: {domains}', { domains: check.certificate.join(', ') })
              : check.issuance === 'upload'
                ? t('noch nicht hochgeladen')
                : check.issuance === 'dns'
                  ? provider
                    ? t('wird über DNS bei {provider} ausgestellt', { provider })
                    : t('wird über DNS ausgestellt')
                  : t('wird über HTTP auf Port 80 ausgestellt')}
          </dd>
          <dt>{t('Ziel')}</dt>
          <dd>
            {check.domain}
            <div className="detail-sub">
              {t('leitet an {target}, die Oberfläche von HAPM', { target: `127.0.0.1:${view.listenPort}` })}
            </div>
          </dd>
          {view.currentUrl && (
            <>
              <dt>{t('Danach entfernt')}</dt>
              <dd>{t('das Ziel von {url}', { url: view.currentUrl })}</dd>
            </>
          )}
        </dl>
      </div>
    </>
  );
}

function MoveStages({ stages }: { stages: AddressMoveStage[] }) {
  const { t } = useT();
  return (
    <ul className="hapm-steps">
      {stages.map((stage, index) => {
        const state =
          stage.status === 'ok' ? 'is-ok' : stage.status === 'error' ? 'is-failed' : stage.status === 'running' ? 'is-running' : 'is-pending';
        return (
          <li key={stage.key} className={`hapm-step ${state}`} style={{ '--i': index } as CSSProperties}>
            {stage.status === 'ok' ? (
              <Check size={14} strokeWidth={1.5} />
            ) : stage.status === 'error' ? (
              <X size={14} strokeWidth={1.5} />
            ) : stage.status === 'running' ? (
              <Loader2 size={14} strokeWidth={1.5} className="spin" />
            ) : (
              <Circle size={14} strokeWidth={1.5} />
            )}
            <span className="hapm-step-text">
              <span className="hapm-step-label">{t(MOVE_STAGE_LABELS[stage.key])}</span>
              {/* Gespeichert auf Deutsch: ein Satz ohne eingesetzte Werte wird hier nachgeschlagen. */}
              {stage.detail && <span className="hapm-step-detail">{t(stage.detail)}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Done({
  url,
  stages,
  lostContact,
  passkeysGone,
}: {
  url: string;
  stages: AddressMoveStage[];
  lostContact: boolean;
  /** Es gab eine Adresse davor: ihre Passkeys hat das Umstellen gelöscht. */
  passkeysGone: boolean;
}) {
  const { t } = useT();
  return (
    <div className="modal-body hapm-move-done">
      <div className="hapm-done-head">
        <div className="hapm-done-mark" aria-hidden="true">
          {RAYS.map((ray, index) => (
            <i key={index} style={{ '--ray-angle': `${ray.angle}deg`, '--ray-delay': `${ray.delay}ms` } as CSSProperties} />
          ))}
          <span className="hapm-done-tile">
            <svg viewBox="0 0 48 48">
              <path d="M13 25.5 L21 33 L36 16" pathLength={1} />
            </svg>
          </span>
        </div>
        <h3 className="hapm-move-done-title">{t('HAPM ist umgezogen')}</h3>
        <p className="hapm-move-done-sub">{t('Unter der neuen Adresse melden Sie sich einmal neu an.')}</p>
      </div>

      <ul className="hapm-done-steps">
        {stages.map((stage, index) => {
          // Antwortet die alte Adresse nicht mehr, ist ihr Ziel weg: genau das tut der letzte Schritt.
          const ok = stage.status === 'ok' || (lostContact && stage.status === 'running');
          return (
            <li key={stage.key} style={{ '--i': index } as CSSProperties}>
              <span className={`hapm-done-check${ok ? '' : stage.status === 'error' ? ' is-failed' : ' is-running'}`}>
                {ok ? (
                  <Check size={13} strokeWidth={3} />
                ) : stage.status === 'error' ? (
                  <X size={13} strokeWidth={3} />
                ) : (
                  <Loader2 size={13} strokeWidth={3} className="spin" />
                )}
              </span>
              <span className="hapm-step-text">
                <span>{t(MOVE_STAGE_LABELS[stage.key])}</span>
                {stage.status === 'error' && stage.detail && <span className="hapm-step-detail">{t(stage.detail)}</span>}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="hapm-done-actions">
        <a className="btn btn-primary hapm-move-open" href={url}>
          <ExternalLink size={16} />
          <span>{t('HAPM unter {url} öffnen', { url })}</span>
          <ArrowRight size={16} className="hapm-done-arrow" />
        </a>
        {passkeysGone && (
          <p className="form-hint hapm-move-done-hint">
            {t('Die Passkeys der bisherigen Adresse sind gelöscht. Neue legen Sie unter Konto an.')}
          </p>
        )}
        {lostContact && (
          <p className="form-hint hapm-move-done-hint">
            {t('Die bisherige Adresse antwortet nicht mehr, ihr Ziel ist entfernt. Ob der letzte Schritt ganz durchgelaufen ist, steht unter der neuen Adresse in Allgemein.')}
          </p>
        )}
      </div>
    </div>
  );
}
