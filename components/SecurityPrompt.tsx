'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldCheck, X } from 'lucide-react';
import { useApp } from './AppShell';
import { useMountedLoad } from './useMountedLoad';
import TwoFactorSetup from './TwoFactorSetup';
import { useToast } from './Toast';
import { useT } from '@/lib/i18n/react';

/**
 * „Konto absichern“: einmal, beim ersten Aufruf unter der Adresse von HAPM.
 *
 * Nicht in der Einrichtung, wo es einmal stand: dort läuft die Oberfläche
 * unter IP und Port, ein Passwortmanager speicherte die Anmeldung für diese
 * Adresse, und ein Passkey hängt an der Domain. Hier ist die Adresse die
 * richtige, und beides lässt sich sinnvoll anbieten.
 *
 * Erscheint nur ohne zweiten Faktor und ohne Passkey, und bis jemand es
 * wegklickt (`/api/account/security`). Unter „Konto“ geht beides jederzeit.
 */

interface SecurityState {
  origin: string | null;
  totpEnabled: boolean;
  passkeyCount: number;
  passkeysAvailable: boolean;
  passkeysMissing: string[];
  dismissed: boolean;
}

export default function SecurityPrompt() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const { t } = useT();
  const router = useRouter();
  const [state, setState] = useState<SecurityState | null>(null);
  const [open, setOpen] = useState(false);
  const [twoFactor, setTwoFactor] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/account/security');
      const data = await res.json();
      if (!data.success) return;
      const next = data.data as SecurityState;
      setState(next);
      setOpen(
        !next.dismissed &&
          !next.totpEnabled &&
          next.passkeyCount === 0 &&
          next.origin !== null &&
          window.location.origin === next.origin
      );
    } catch {
      // Ohne Antwort kein Fenster: es ist ein Angebot und keine Bedingung.
    }
  }, [apiFetch]);

  useMountedLoad(load);

  async function dismiss() {
    setOpen(false);
    try {
      await apiFetch('/api/account/security', { method: 'POST' });
    } catch {
      // Kommt es beim nächsten Mal wieder, ist das kein Schaden.
    }
  }

  if (twoFactor) {
    return (
      <TwoFactorSetup
        onCancel={() => setTwoFactor(false)}
        onComplete={() => {
          setTwoFactor(false);
          notify({ variant: 'success', message: t('Der zweite Faktor ist eingerichtet.') });
        }}
      />
    );
  }

  if (!open || !state) return null;

  const passkeyReason = state.passkeysAvailable
    ? null
    : t('Dafür braucht HAPM ein SMTP-Konto. Es wird unter Benachrichtigungen eingerichtet.');

  return (
    <div className="modal-overlay">
      <div className="modal security-prompt" role="dialog" aria-modal="true" aria-labelledby="security-prompt-title">
        <div className="modal-header">
          <h2 className="modal-title" id="security-prompt-title">
            {t('Konto absichern')}
          </h2>
          <button className="modal-close" type="button" onClick={() => void dismiss()} aria-label={t('Schließen')}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p className="security-prompt-lead">
            {t('HAPM läuft jetzt unter seiner Adresse. Hier kann Ihr Passwortmanager die Anmeldung speichern. Sichern Sie das Konto zusätzlich ab:')}
          </p>
          <div className="hapm-choices">
            <button
              type="button"
              className="hapm-choice"
              disabled={!state.passkeysAvailable}
              data-tooltip={passkeyReason ?? undefined}
              onClick={() => {
                // Das Anlegen steht auf der Kontoseite, mit Name und Liste;
                // dorthin, und der Dialog geht dort gleich auf.
                setOpen(false);
                void dismiss();
                router.push('/konto?bereich=passkeys&passkey=neu');
              }}
            >
              <KeyRound size={18} strokeWidth={1.5} />
              <span className="hapm-choice-text">
                <strong>{t('Passkey anlegen')}</strong>
                <span>{passkeyReason ?? t('Anmelden mit Fingerabdruck, Gesicht oder Gerätesperre.')}</span>
              </span>
            </button>
            <button
              type="button"
              className="hapm-choice"
              onClick={() => {
                setOpen(false);
                void dismiss();
                setTwoFactor(true);
              }}
            >
              <ShieldCheck size={18} strokeWidth={1.5} />
              <span className="hapm-choice-text">
                <strong>{t('Zweiten Faktor einrichten')}</strong>
                <span>{t('Ein Code aus einer Authenticator-App zusätzlich zum Passwort.')}</span>
              </span>
            </button>
          </div>
        </div>
        <div className="modal-footer security-prompt-footer">
          <span className="form-hint">{t('Beides geht jederzeit unter Konto.')}</span>
          <button className="btn btn-secondary" type="button" onClick={() => void dismiss()}>
            {t('Nicht jetzt')}
          </button>
        </div>
      </div>
    </div>
  );
}
