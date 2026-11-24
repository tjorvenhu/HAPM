'use client';

import SharedTwoFactorSetup from '@/ui/auth/TwoFactorSetup';
import { useApp } from './AppShell';
import { useT } from '@/lib/i18n/react';

interface TwoFactorSetupProps {
  onComplete: () => void;
  onCancel: () => void;
}

/**
 * Die Einrichtung des zweiten Faktors. Form und Ablauf stehen in
 * `ui/auth/TwoFactorSetup.tsx`, hier steht nur die Anbindung an
 * `/api/account/2fa/*`. Der zweite Faktor ist freiwillig: die Fläche öffnet
 * sich von der Kontoseite aus und lässt sich abbrechen.
 */
export default function TwoFactorSetup({ onComplete, onCancel }: TwoFactorSetupProps) {
  const { apiFetch } = useApp();
  const { t } = useT();

  async function start() {
    const res = await apiFetch('/api/account/2fa/setup', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('Die Einrichtung ließ sich nicht starten.'));
    return { qrCodeDataUrl: data.data.qrCodeDataUrl as string, manualCode: data.data.manualCode as string };
  }

  async function verify(code: string) {
    const res = await apiFetch('/api/account/2fa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('Der Code ließ sich nicht prüfen.'));
  }

  return <SharedTwoFactorSetup start={start} verify={verify} onComplete={onComplete} onCancel={onCancel} />;
}
