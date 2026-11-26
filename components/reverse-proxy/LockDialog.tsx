'use client';

import { useState, type FormEvent } from 'react';
import { ArrowLeft, Copy, KeyRound, Lock, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { suggestPassword } from '@/components/suggestPassword';
import { useToast } from '@/components/Toast';
import {
  LOCK_PASSWORD_MIN,
  shortVersion,
  supportsPasswordLock,
  validateLockPassword,
  type HaproxyService,
} from '@/lib/haproxy/config';
import { useT } from '@/lib/i18n/react';
import type { ProxyRow } from './types';

/**
 * Wie ein offenes Ziel gesperrt werden soll: auf die Admin-IPs oder mit
 * Passwort.
 *
 * Die Stufe hinter dem Schloss auf der Karte. Vorher sperrte der Knopf sofort
 * auf die Admin-IPs, weil es nur diese eine Art gab. Mit zweien ist es eine
 * Frage, und die steht vor der Handlung, wie bei „Was soll angelegt werden?".
 *
 * Gelöst wird weiterhin mit einem Klick und ohne diesen Dialog: beim Öffnen
 * gibt es nichts zu wählen.
 *
 * ── Das Passwort steht nur hier ──
 *
 * Auf der Maschine liegt danach ein Hash, in der Datenbank und im Audit nichts.
 * Der Dialog ist deshalb die einzige Gelegenheit, es zu kopieren, und sagt das.
 * Vorbelegt ist ein Vorschlag: zufällig und lang genug, dass die Zählung der
 * Versuche auf der Maschine nicht das Einzige ist, was vor Raten schützt.
 */

export type LockChoice = { mode: 'ip' } | { mode: 'password'; password: string };

interface Props {
  proxy: ProxyRow;
  service: HaproxyService;
  onPick: (choice: LockChoice) => void;
  onClose: () => void;
}

export default function LockDialog({ proxy, service, onPick, onClose }: Props) {
  const { t } = useT();
  const { notify } = useToast();
  const [step, setStep] = useState<'kind' | 'password'>('kind');
  const [password, setPassword] = useState(suggestPassword);

  const hasAdminIps = proxy.adminIps.length > 0;
  // `null` heißt unbekannt, und dann wird nichts ausgegraut: ob die Maschine
  // es kann, sagt in dem Fall die Prüfung im Vorgang.
  const passwordPossible = supportsPasswordLock(proxy.version) !== false;
  const passwordError = validateLockPassword(password);

  // Ohne HTTPS gibt es `navigator.clipboard` nicht, und das ist bei einer
  // internen Installation der Normalfall. Dann sagt die Meldung, was bleibt.
  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(password);
      notify({ message: t('Kopiert'), variant: 'success' });
    } catch {
      notify({ message: t('Kopieren nicht möglich. Bitte von Hand markieren.'), variant: 'error' });
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (passwordError) return;
    onPick({ mode: 'password', password });
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">
            {t(step === 'kind' ? 'Wie soll gesperrt werden?' : 'Mit Passwort sperren')}
            <span className="modal-subject">{service.domains[0] ?? service.id}</span>
          </h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('Dialog schließen')}>
            <X size={18} />
          </button>
        </div>

        {step === 'kind' ? (
          <div className="modal-body">
            <div className="kind-grid">
              {/* Eine Karte, die nicht geht, bleibt stehen und nennt den Grund.
                  Fehlte sie, sähe es aus, als gäbe es die Art nicht. */}
              <button
                type="button"
                className="kind-card"
                disabled={!hasAdminIps}
                onClick={() => onPick({ mode: 'ip' })}
              >
                <span className="kind-card-icon">
                  <ShieldCheck size={18} />
                </span>
                <span className="kind-card-text">
                  <span className="kind-card-title">{t('Nur Admin-IPs')}</span>
                  <span className="kind-card-sub">
                    {hasAdminIps
                      ? t('Nur erreichbar von {addresses}. Alle anderen bekommen 403.', {
                          addresses: proxy.adminIps.join(', '),
                        })
                      : t('Es sind keine Admin-IPs gesetzt. Sie stehen unter Reverse-Proxy, Einstellungen.')}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className="kind-card"
                disabled={!passwordPossible}
                onClick={() => setStep('password')}
              >
                <span className="kind-card-icon">
                  <KeyRound size={18} />
                </span>
                <span className="kind-card-text">
                  <span className="kind-card-title">{t('Mit Passwort')}</span>
                  <span className="kind-card-sub">
                    {passwordPossible
                      ? t('Besucher sehen eine Passwortabfrage. Nach richtiger Eingabe kommen sie 30 Tage lang ohne Abfrage durch.')
                      : t('Braucht HAProxy 2.4 oder neuer. Hier läuft {version}.', {
                          version: shortVersion(proxy.version ?? ''),
                        })}
                  </span>
                </span>
              </button>
            </div>
            {service.domains.length > 1 && (
              <p className="form-hint">
                {t('Gesperrt werden alle {count} Domains des Eintrags. Einzelne Domains sperrt man im Bearbeiten-Dialog.', {
                  count: service.domains.length,
                })}
              </p>
            )}
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              <div className="form-group">
                <label className="form-label" htmlFor="lock-password">
                  {t('Passwort')}
                </label>
                <div className="form-list-row">
                  <input
                    id="lock-password"
                    className="form-input mono"
                    required
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    data-tooltip={t('Neuen Vorschlag erzeugen')}
                    data-tooltip-pos="left"
                    onClick={() => setPassword(suggestPassword())}
                    aria-label={t('Neuen Vorschlag erzeugen')}
                  >
                    <RefreshCw size={16} />
                  </button>
                  <button type="button" className="btn btn-secondary" onClick={copyPassword}>
                    <Copy size={16} />
                    {t('Kopieren')}
                  </button>
                </div>
                <p className="form-hint">
                  {password !== '' && passwordError
                    ? t(passwordError)
                    : t('Mindestens {min} Zeichen. Jetzt kopieren: gespeichert wird nur ein Hash.', { min: LOCK_PASSWORD_MIN })}
                </p>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={() => setStep('kind')}>
                <ArrowLeft size={16} />
                {t('Zurück')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={!!passwordError}>
                <Lock size={16} />
                {t('Sperren')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
