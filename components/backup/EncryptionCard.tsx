'use client';

import { useState, type FormEvent } from 'react';
import { AlertTriangle, Copy, KeyRound, Loader2, LockKeyhole, RefreshCw, ShieldOff } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { suggestPassword } from '@/components/suggestPassword';
import { useT } from '@/lib/i18n/react';
import { PASSPHRASE_MAX, PASSPHRASE_MIN, checkPassphrase } from '@/lib/backup/passphrase';

/**
 * Was gerade eingegeben wird. `idle`: nichts, der Schalter zeigt den
 * gespeicherten Stand. `set`: ein Sicherungsschlüssel wird gesetzt (zum ersten
 * Mal oder ein neuer). `remove`: die Verschlüsselung wird abgeschaltet.
 */
type Mode = 'idle' | 'set' | 'remove';

interface Props {
  encrypted: boolean;
  /** Gespeichert, aber mit dem Schlüssel, mit dem HAPM läuft, nicht mehr zu lesen. */
  unreadable: boolean;
  /** Nach dem Speichern: die Seite lädt ihren Stand neu. */
  onSaved: () => Promise<void>;
  /** Ob hier etwas getippt ist, das noch nicht gespeichert ist: der Reiter trägt dann einen Punkt. */
  onDirty: (dirty: boolean) => void;
}

/**
 * Die Karte „Verschlüsselung" auf der Seite „Sicherung".
 *
 * Der Schalter speichert nicht selbst: wer ihn umlegt, bekommt darunter, was
 * dafür nötig ist (Sicherungsschlüssel, Passwort des Kontos), und speichert
 * mit dem Knopf. Der Sicherungsschlüssel verlässt den Server danach nicht
 * mehr, die Seite erfährt nur, ob einer gesetzt ist. Deshalb steht er beim
 * Eingeben im Klartext da, mit „Kopieren": das ist der eine Moment, in dem man
 * ihn woanders ablegen kann.
 */
export default function EncryptionCard({ encrypted, unreadable, onSaved, onDirty }: Props) {
  const { apiFetch } = useApp();
  const confirm = useConfirm();
  const { notify } = useToast();
  const { t } = useT();

  const [mode, setModeState] = useState<Mode>('idle');
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  function setMode(next: Mode) {
    setModeState(next);
    setPassphrase('');
    setRepeat('');
    setPassword('');
    onDirty(next !== 'idle');
  }

  const checked = checkPassphrase(passphrase);
  const passphraseError = passphrase !== '' && 'error' in checked ? checked.error : null;
  const repeatError = repeat !== '' && repeat !== passphrase;
  const ready =
    password !== '' && (mode === 'remove' || (mode === 'set' && 'passphrase' in checked && repeat === passphrase));

  async function copy() {
    try {
      await navigator.clipboard.writeText(passphrase);
      notify({ variant: 'success', message: t('Kopiert') });
    } catch {
      notify({ variant: 'error', message: t('Kopieren nicht möglich. Bitte von Hand markieren.') });
    }
  }

  async function send() {
    setSaving(true);
    try {
      const res = await apiFetch('/api/backup/encryption', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: mode === 'remove' ? null : passphrase, password }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || t('Die Verschlüsselung ließ sich nicht ändern.'));
      const wasEncrypted = encrypted;
      const removed = mode === 'remove';
      // Erst der neue Stand, dann das Formular zu: sonst spränge der Schalter kurz zurück.
      await onSaved();
      setMode('idle');
      notify({
        variant: 'success',
        message: removed
          ? t('Neue Sicherungen werden nicht mehr verschlüsselt.')
          : wasEncrypted
            ? t('Der Sicherungsschlüssel ist geändert. Er gilt ab der nächsten Sicherung.')
            : t('Neue Sicherungen werden mit dem Sicherungsschlüssel verschlüsselt.'),
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Die Verschlüsselung ließ sich nicht ändern.')),
      });
    } finally {
      setSaving(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || saving) return;
    // Beim ersten Einschalten steht die Folge schon in der Karte. Ändern und
    // Abschalten betreffen einen Stand, auf den sich jemand verlässt.
    if (mode === 'remove') {
      const confirmed = await confirm({
        title: t('Verschlüsselung abschalten?'),
        message: t(
          'Neue Sicherungen liegen dann unverschlüsselt im Ordner, mit privaten Schlüsseln. Schon geschriebene Archive bleiben verschlüsselt und brauchen weiter ihren Sicherungsschlüssel.'
        ),
        confirmLabel: t('Abschalten'),
        variant: 'danger',
      });
      if (!confirmed) return;
    } else if (encrypted) {
      const confirmed = await confirm({
        title: t('Sicherungsschlüssel ändern?'),
        message: t(
          'Der neue Sicherungsschlüssel gilt ab der nächsten Sicherung. Schon geschriebene Archive brauchen weiter den bisherigen: bewahren Sie beide auf.'
        ),
        confirmLabel: t('Ändern'),
        variant: 'warning',
      });
      if (!confirmed) return;
    }
    await send();
  }

  return (
    <div className="card sys-block">
      <div className="card-header">
        <h2 className="card-title">
          <LockKeyhole size={17} strokeWidth={1.5} />
          {t('Verschlüsselung')}
          <InfoHint
            text={t(
              'Verschlüsselt wird mit gpg (AES-256), die Datei endet dann auf .tar.gz.gpg. Sie lässt sich auch ohne HAPM mit gpg und dem Sicherungsschlüssel entschlüsseln.'
            )}
          />
        </h2>
      </div>

      <form className="card-body" onSubmit={(event) => void submit(event)}>
        {unreadable && (
          <div className="alert alert-danger">
            <AlertTriangle size={16} strokeWidth={1.5} />
            <span>
              {t(
                'Der gespeicherte Sicherungsschlüssel ist nicht mehr lesbar. Bis er neu eingetragen ist, scheitert jede Sicherung.'
              )}
            </span>
          </div>
        )}

        {/* `.hapm-auto` wie bei „Täglich sichern": der Kasten des Schalters misst sich
            dort an der Breite. Direkt in der Karte stünde seine Basis für die Höhe. */}
        <div className="hapm-auto">
          <label className="form-subsection hapm-auto-switch">
            <div className="form-subsection-head">
              <div>
                <div className="form-section-title">{t('Sicherung verschlüsseln')}</div>
                <div className="form-section-sub">
                  {encrypted
                    ? t('Neue Archive werden mit dem Sicherungsschlüssel verschlüsselt.')
                    : t('Die Archive liegen unverschlüsselt im Ordner.')}
                </div>
              </div>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={mode === 'set' || (encrypted && mode !== 'remove')}
                  disabled={saving}
                  onChange={(event) => {
                    if (event.target.checked) setMode(encrypted ? 'idle' : 'set');
                    else setMode(encrypted ? 'remove' : 'idle');
                  }}
                />
                <span className="toggle-slider" />
              </span>
            </div>
          </label>
        </div>

        {mode === 'idle' && encrypted && (
          <div className="hapm-form-actions">
            <button className="btn btn-secondary" type="button" onClick={() => setMode('set')}>
              <KeyRound size={16} strokeWidth={1.5} />
              {t('Sicherungsschlüssel ändern')}
            </button>
          </div>
        )}

        {mode === 'set' && (
          <>
            <div className="alert alert-warning">
              <AlertTriangle size={16} strokeWidth={1.5} />
              <span>
                {t(
                  'Ohne den Sicherungsschlüssel lässt sich eine verschlüsselte Sicherung nicht zurückspielen. Er steht in keinem Archiv und wird hier nicht wieder angezeigt. Bewahren Sie ihn getrennt vom Server auf.'
                )}
              </span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="backup-passphrase">
                {encrypted ? t('Neuer Sicherungsschlüssel') : t('Sicherungsschlüssel')}
              </label>
              <div className="form-list-row">
                <input
                  id="backup-passphrase"
                  className="form-input mono"
                  required
                  maxLength={PASSPHRASE_MAX}
                  autoComplete="off"
                  spellCheck={false}
                  value={passphrase}
                  disabled={saving}
                  onChange={(event) => setPassphrase(event.target.value)}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  data-tooltip={t('Vorschlag erzeugen')}
                  data-tooltip-pos="left"
                  aria-label={t('Vorschlag erzeugen')}
                  disabled={saving}
                  onClick={() => {
                    setPassphrase(suggestPassword());
                    setRepeat('');
                  }}
                >
                  <RefreshCw size={16} strokeWidth={1.5} />
                </button>
                <button type="button" className="btn btn-secondary" disabled={passphrase === ''} onClick={() => void copy()}>
                  <Copy size={16} strokeWidth={1.5} />
                  {t('Kopieren')}
                </button>
              </div>
              <p className="form-hint">
                {passphraseError ? t(passphraseError) : t('Mindestens {min} Zeichen. Jetzt kopieren und ablegen.', { min: PASSPHRASE_MIN })}
              </p>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="backup-passphrase-repeat">
                {t('Sicherungsschlüssel wiederholen')}
              </label>
              <input
                id="backup-passphrase-repeat"
                className="form-input mono"
                required
                maxLength={PASSPHRASE_MAX}
                autoComplete="off"
                spellCheck={false}
                value={repeat}
                disabled={saving}
                onChange={(event) => setRepeat(event.target.value)}
              />
              {repeatError && <p className="form-hint">{t('Die beiden Eingaben stimmen nicht überein.')}</p>}
            </div>
          </>
        )}

        {mode === 'remove' && (
          <div className="alert alert-warning">
            <AlertTriangle size={16} strokeWidth={1.5} />
            <span>
              {t(
                'Neue Sicherungen liegen dann unverschlüsselt im Ordner, mit privaten Schlüsseln. Schon geschriebene Archive bleiben verschlüsselt und brauchen weiter ihren Sicherungsschlüssel.'
              )}
            </span>
          </div>
        )}

        {mode !== 'idle' && (
          <>
            <div className="form-group">
              <label className="form-label" htmlFor="backup-encryption-password">
                {t('Ihr Passwort')}
              </label>
              <input
                id="backup-encryption-password"
                className="form-input"
                type="password"
                required
                value={password}
                disabled={saving}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </div>

            <div className="hapm-form-actions">
              <button className={mode === 'remove' ? 'btn btn-danger' : 'btn btn-primary'} type="submit" disabled={!ready || saving}>
                {saving ? (
                  <Loader2 size={16} strokeWidth={1.5} className="spin" />
                ) : mode === 'remove' ? (
                  <ShieldOff size={16} strokeWidth={1.5} />
                ) : (
                  <LockKeyhole size={16} strokeWidth={1.5} />
                )}
                {mode === 'remove'
                  ? t('Verschlüsselung abschalten')
                  : encrypted
                    ? t('Sicherungsschlüssel ändern')
                    : t('Verschlüsselung einschalten')}
              </button>
              <button className="btn btn-secondary" type="button" disabled={saving} onClick={() => setMode('idle')}>
                {t('Abbrechen')}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
