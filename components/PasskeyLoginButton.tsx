'use client';

import SharedPasskeyLoginButton from '@/ui/auth/PasskeyLoginButton';
import { passkeyBrowserError } from '@/lib/auth/passkey-rules';

interface Props {
  /** Nach der Anmeldung. Die Seite entscheidet, wohin es geht. */
  onSuccess: () => void;
  /** Die Anmeldeseite zeigt Fehler an einer Stelle. Ein leerer Text räumt sie ab. */
  onError: (message: string) => void;
}

/**
 * „Mit Passkey anmelden" auf der Anmeldeseite, unter dem Formular. Form und Ablauf
 * stehen in `ui/auth/PasskeyLoginButton.tsx`, hier steht nur die Anbindung an
 * `/api/auth/passkey/login/*`.
 *
 * Nacktes `fetch` und nicht `apiFetch`: die Seite liegt außerhalb des Rahmens,
 * und vor der Anmeldung gibt es weder Sitzung noch CSRF-Token.
 */
export default function PasskeyLoginButton({ onSuccess, onError }: Props) {
  async function requestOptions() {
    try {
      const prepared = await fetch('/api/auth/passkey/login/options', { method: 'POST' });
      const challenge = await prepared.json().catch(() => ({}));
      if (!prepared.ok || !challenge.data?.options) {
        return { error: (challenge.error as string) || 'Die Anmeldung mit Passkey ist gerade nicht möglich.' };
      }
      return { options: challenge.data.options as unknown };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : 'Die Anmeldung mit Passkey ist fehlgeschlagen.' };
    }
  }

  async function verify(response: unknown) {
    try {
      const res = await fetch('/api/auth/passkey/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: (data.error as string) || 'Die Anmeldung mit diesem Passkey war nicht möglich.' };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : 'Die Anmeldung mit Passkey ist fehlgeschlagen.' };
    }
  }

  return (
    <SharedPasskeyLoginButton
      requestOptions={requestOptions}
      verify={verify}
      describeBrowserError={(name) => passkeyBrowserError(name, 'login')}
      onSuccess={onSuccess}
      onError={onError}
    />
  );
}
