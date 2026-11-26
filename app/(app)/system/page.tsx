'use client';

import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRightLeft, AtSign, Globe, Home, Loader2, Network, Save, ShieldCheck, ShieldHalf, Trash2 } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { useConfirm } from '@/components/ConfirmDialog';
import { SkeletonDetail } from '@/components/Skeleton';
import AreaTabs, { useArea, type Area } from '@/components/AreaTabs';
import CertificateSourceCard from '@/components/system/CertificateSourceCard';
import AddressMoveWizard from '@/components/system/AddressMoveWizard';
import { CrowdsecSwitchCard } from '@/components/crowdsec/CrowdsecSwitch';
import { MOVE_STAGE_LABELS, moveOutcome } from '@/lib/address-move/rules';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Nur der Typ: die Datei dahinter erreicht `lib/db`.
import type { SettingsView } from '@/lib/settings';
import type { AddressMoveView } from '@/lib/address-move';
import type { Exposure } from '@/lib/types';

/** Dieselben zwei Möglichkeiten wie im Assistenten, mit der Folge für künftige Zertifikate. */
const EXPOSURE_CHOICES: { value: Exposure; title: string; text: string }[] = [
  {
    value: 'internal',
    title: msgid('Nur im eigenen Netz'),
    text: msgid("Let's Encrypt erreicht den Server nicht. Neue Zertifikate gehen über den DNS-Anbieter, über einen eigenen ACME-Server, der HAPM über Port 80 erreicht, oder werden hochgeladen."),
  },
  {
    value: 'public',
    title: msgid('Aus dem Internet erreichbar'),
    text: msgid("Neue Zertifikate prüft Let's Encrypt über Port 80. Der DNS-Anbieter wird nur für Wildcards gebraucht."),
  },
];

/**
 * Die Reiter: die Adresse von HAPM, alles, was bestimmt, wie Zertifikate
 * entstehen (Art der Installation, Herkunft, Kontakt beim ACME-Server), und,
 * wo CrowdSec im Stack ist, der Schalter dafür. Er steht hier und nicht nur
 * auf der Seite CrowdSec, weil die abgeschaltet aus der Seitenleiste fällt.
 * Der gewählte Reiter steht als `?bereich=` in der Adresse.
 */
type GeneralArea = 'adresse' | 'zertifikate' | 'crowdsec';

const AREAS: Area<GeneralArea>[] = [
  { key: 'adresse', label: msgid('Adresse'), icon: Globe },
  { key: 'zertifikate', label: msgid('Zertifikate'), icon: ShieldCheck },
];

const CROWDSEC_AREA: Area<GeneralArea> = { key: 'crowdsec', label: 'CrowdSec', icon: ShieldHalf };

interface SaveResult {
  settings: SettingsView;
  acme: { ok: boolean; detail: string } | null;
}

export default function GeneralSettingsPage() {
  return (
    <Suspense fallback={<SkeletonDetail />}>
      <GeneralSettings />
    </Suspense>
  );
}

function GeneralSettings() {
  const { apiFetch, session } = useApp();
  const areas = session.features?.crowdsecPresent ? [...AREAS, CROWDSEC_AREA] : AREAS;
  const [area, selectArea] = useArea(areas, '/system');
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t } = useT();

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState('');
  /** Stand des Umzugs auf eine neue Adresse. Läuft einer, geht der Assistent beim ersten Laden auf. */
  const [moveView, setMoveView] = useState<AddressMoveView | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Nur beim ersten Laden: `closeWizard` lädt neu, und wer das Fenster eines
  // laufenden Umzugs schließt, bekäme es sonst sofort wieder.
  const openRunningMove = useRef(true);
  const [removingUrl, setRemovingUrl] = useState(false);
  const [emailDraft, setEmailDraft] = useState<string | null>(null);
  const [savingEmail, setSavingEmail] = useState(false);
  const [savingExposure, setSavingExposure] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings', { cache: 'no-store' });
      const body = await res.json();
      if (!body.success) throw new Error(body.error);
      setSettings(body.data as SettingsView);
      const moveRes = await apiFetch('/api/settings/address', { cache: 'no-store' });
      const moveBody = await moveRes.json();
      if (!moveBody.success) throw new Error(moveBody.error);
      const next = moveBody.data as AddressMoveView;
      setMoveView(next);
      if (openRunningMove.current && moveOutcome(next.move) === 'running') setWizardOpen(true);
      openRunningMove.current = false;
      setError('');
    } catch {
      setError(t('Die Einstellungen konnten nicht geladen werden.'));
    }
  }, [apiFetch, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patch(payload: Record<string, unknown>): Promise<SaveResult> {
    const res = await apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!body.success) throw new Error(body.error || t('Die Einstellung ließ sich nicht speichern.'));
    return body.data as SaveResult;
  }

  /** Die Adresse entfernen. Ändern geht über den Assistenten (`AddressMoveWizard`). */
  async function removeUrl() {
    if (!settings?.publicUrl) return;
    const confirmed = await confirm({
      title: t('Adresse von HAPM entfernen?'),
      message: t(
        'Alle hinterlegten Passkeys werden gelöscht, sie sind an die Domain gebunden. Links in schon verschickten Mails zeigen weiter auf die alte Adresse. Das Ziel, über das die bisherige Adresse läuft, lässt sich danach wieder entfernen: geschützt ist immer das Ziel der aktuellen Adresse.'
      ),
      confirmLabel: t('Adresse entfernen'),
      variant: 'danger',
    });
    if (!confirmed) return;

    setRemovingUrl(true);
    try {
      const result = await patch({ publicUrl: null });
      setSettings(result.settings);
      notify({ variant: 'success', message: t('Die Adresse ist entfernt. Mails enthalten keinen Link in die Oberfläche.') });
    } catch (err: unknown) {
      notify({ variant: 'error', message: errorText(err, t('Die Adresse ließ sich nicht speichern.')) });
    } finally {
      setRemovingUrl(false);
    }
  }

  function closeWizard() {
    setWizardOpen(false);
    void load();
  }

  async function saveEmail(event: FormEvent) {
    event.preventDefault();
    if (!settings || emailDraft === null) return;
    setSavingEmail(true);
    try {
      const result = await patch({ acmeEmail: emailDraft.trim() || null });
      setSettings(result.settings);
      setEmailDraft(null);
      if (result.acme && !result.acme.ok) {
        notify({
          variant: 'warning',
          title: t('Gespeichert, aber nicht bei acme.sh angekommen'),
          message: result.acme.detail,
        });
      } else {
        notify({ variant: 'success', message: t("Die Adresse für Let's Encrypt ist gespeichert.") });
      }
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Die Adresse ließ sich nicht speichern.')),
      });
    } finally {
      setSavingEmail(false);
    }
  }

  async function saveExposure(next: Exposure) {
    if (!settings || next === settings.exposure) return;
    const confirmed = await confirm({
      title:
        next === 'internal'
          ? t('Auf „Nur im eigenen Netz“ umstellen?')
          : t('Auf „Aus dem Internet erreichbar“ umstellen?'),
      message:
        next === 'internal'
          ? t(
              'Jedes neue Zertifikat wird danach über den DNS-Anbieter ausgestellt, außer ein eigener ACME-Server erreicht HAPM über Port 80 oder Zertifikate werden hochgeladen. Ohne einen dieser Wege lässt sich kein Ziel mehr anlegen. Bestehende Zertifikate behalten ihre Methode, auch bei der Erneuerung.'
            )
          : t(
              "Neue Zertifikate werden danach über Port 80 geprüft. Erreicht Let's Encrypt den Server nicht, scheitert jeder neue Antrag. Bestehende Zertifikate behalten ihre Methode, auch bei der Erneuerung."
            ),
      confirmLabel: t('Umstellen'),
      variant: 'warning',
    });
    if (!confirmed) return;

    setSavingExposure(true);
    try {
      const result = await patch({ exposure: next });
      setSettings(result.settings);
      notify({ variant: 'success', message: t('Die Art der Installation ist umgestellt. Sie gilt für neue Zertifikate.') });
    } catch (err: unknown) {
      notify({ variant: 'error', message: errorText(err, t('Die Einstellung ließ sich nicht speichern.')) });
    } finally {
      setSavingExposure(false);
    }
  }

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">{t('Allgemein')}</h1>
        <p className="page-subtitle">{t('Adresse, Art der Installation, Zertifikate und der Kontakt beim ACME-Server.')}</p>
      </div>
    </div>
  );

  if (!settings) {
    return (
      <>
        {header}
        {error ? <div className="alert alert-danger sys-block">{error}</div> : <SkeletonDetail />}
      </>
    );
  }

  const lastMove = moveView?.move ?? null;
  const failedStage = moveOutcome(lastMove) === 'failed' ? lastMove?.stages.find((stage) => stage.status === 'error') : undefined;
  const emailValue = emailDraft ?? settings.acmeEmail ?? '';
  const emailChanged = emailDraft !== null && emailDraft.trim() !== (settings.acmeEmail ?? '');

  return (
    <>
      {header}

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <AreaTabs areas={areas} value={area} onChange={selectArea} dirty={(key) => key === 'zertifikate' && emailChanged} />

      {area === 'crowdsec' && <CrowdsecSwitchCard />}

      {area === 'adresse' && (
      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Globe size={17} strokeWidth={1.5} />
              {t('Adresse von HAPM')}
            </h2>
            <p className="card-subtitle">{t('Sie steht in den Links der Mails, und an ihre Domain werden Passkeys gebunden.')}</p>
          </div>
          <span className={`badge-status ${settings.publicUrl ? 'badge-success' : 'badge-neutral'}`}>
            <span className="dot" />
            {settings.publicUrl ? t('Eingerichtet') : t('Nicht eingerichtet')}
          </span>
        </div>

        <div className="card-body">
          {failedStage && lastMove && (
            <div className="alert alert-danger">
              <span>
                {t('Der Umzug nach {domain} ist nicht durchgelaufen. {stage}: {detail}', {
                  domain: lastMove.domain,
                  stage: t(MOVE_STAGE_LABELS[failedStage.key]),
                  detail: failedStage.detail ? t(failedStage.detail) : t('Der Vorgang nennt keinen Grund.'),
                })}
              </span>
            </div>
          )}

          <div className="hapm-address-current">
            {settings.publicUrl ? (
              <a href={settings.publicUrl} className="mono" target="_blank" rel="noreferrer">
                {settings.publicUrl}
              </a>
            ) : (
              <span className="hapm-muted">{t('Noch keine Adresse. HAPM ist nur über IP und Port erreichbar.')}</span>
            )}
          </div>

          <div className="hapm-form-actions">
            <button className="btn btn-primary" type="button" onClick={() => setWizardOpen(true)} disabled={!moveView || removingUrl}>
              <ArrowRightLeft size={16} strokeWidth={1.5} />
              {settings.publicUrl ? t('Adresse ändern') : t('Adresse einrichten')}
            </button>
            {settings.publicUrl && (
              <button className="btn btn-secondary" type="button" onClick={removeUrl} disabled={removingUrl}>
                {removingUrl ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Trash2 size={16} strokeWidth={1.5} />}
                {t('Adresse entfernen')}
              </button>
            )}
          </div>

          <div className="alert alert-warning">
            <AlertTriangle size={16} strokeWidth={1.5} />
            <span>{t('Eine Änderung der Domain löscht alle hinterlegten Passkeys.')}</span>
          </div>
        </div>
      </div>
      )}

      {wizardOpen && moveView && (
        <AddressMoveWizard
          initial={moveView}
          onClose={closeWizard}
          onSavedWithoutMove={(url) => {
            setWizardOpen(false);
            notify({ variant: 'success', message: t('HAPM gilt als erreichbar unter {url}.', { url }) });
            void load();
          }}
        />
      )}

      {area === 'zertifikate' && (
        <>
          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  <Network size={17} strokeWidth={1.5} />
                  {t('Art der Installation')}
                </h2>
                <p className="card-subtitle">{t('Sie bestimmt, wie neue Zertifikate ausgestellt werden.')}</p>
              </div>
            </div>

            <div className="card-body">
              <div className="hapm-choices">
                {EXPOSURE_CHOICES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`hapm-choice${settings.exposure === option.value ? ' is-selected' : ''}`}
                    aria-pressed={settings.exposure === option.value}
                    disabled={savingExposure}
                    onClick={() => void saveExposure(option.value)}
                  >
                    {option.value === 'internal' ? <Home size={18} strokeWidth={1.5} /> : <Globe size={18} strokeWidth={1.5} />}
                    <span className="hapm-choice-text">
                      <strong>{t(option.title)}</strong>
                      <span>{t(option.text)}</span>
                    </span>
                  </button>
                ))}
              </div>

              <div className="alert alert-info">
                <span>{t('Bestehende Zertifikate behalten ihre Methode, auch bei der Erneuerung.')}</span>
              </div>
            </div>
          </div>

          <CertificateSourceCard settings={settings} onSaved={setSettings} />

          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  <AtSign size={17} strokeWidth={1.5} />
                  {t("E-Mail für Let's Encrypt")}
                </h2>
                <p className="card-subtitle">{t("Mit dieser Adresse meldet acme.sh das Konto bei Let's Encrypt an.")}</p>
              </div>
            </div>

            <form className="card-body" onSubmit={saveEmail}>
              <div className="form-group">
                <label className="form-label" htmlFor="acme-email">
                  {t('E-Mail-Adresse')}
                  <InfoHint
                    text={t(
                      "Let's Encrypt verschickt keine Warnungen vor dem Ablauf eines Zertifikats mehr. Wer gewarnt werden will, richtet die Benachrichtigungen von HAPM ein."
                    )}
                  />
                </label>
                <input
                  id="acme-email"
                  className="form-input"
                  type="email"
                  placeholder="admin@example.org"
                  value={emailValue}
                  disabled={savingEmail}
                  onChange={(event) => setEmailDraft(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <div className="hapm-form-actions">
                <button className="btn btn-primary" type="submit" disabled={savingEmail || !emailChanged}>
                  {savingEmail ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
                  {t('Speichern')}
                </button>
              </div>
            </form>
          </div>
        </>
      )}
    </>
  );
}
