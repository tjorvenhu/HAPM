'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ListChecks } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { useConfirm } from '@/components/ConfirmDialog';
import { SETUP_STEPS, type SetupStep } from '@/lib/setup/rules';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Nur der Typ: die Datei dahinter erreicht `lib/db`.
import type { SetupView } from '@/lib/setup';

/**
 * Der Hinweis über der Übersicht, dass die Einrichtung noch offen ist.
 *
 * Das Konto besteht nach dem ersten Schritt des Assistenten, alles danach darf
 * scheitern oder liegen bleiben. Damit „später" nicht „nie" heißt, steht die
 * Fläche hier, bis die Einrichtung abgeschlossen oder ausdrücklich
 * übersprungen ist. Beides ist endgültig: was danach fehlt, wird unter
 * „Allgemein" und im Reverse-Proxy eingerichtet.
 */

const STEP_NAMES: Record<Exclude<SetupStep, 'account' | 'done'>, string> = {
  exposure: msgid('Erreichbarkeit'),
  dns: msgid('DNS-Anbieter'),
  certificates: msgid('Zertifikate'),
  mail: msgid('SMTP-Konto'),
  address: msgid('Adresse der Oberfläche'),
  run: msgid('Einrichten'),
};

export default function SetupReminder() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const { t } = useT();
  const confirm = useConfirm();
  const [setup, setSetup] = useState<SetupView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    apiFetch('/api/setup')
      .then((res) => res.json())
      .then((body) => {
        if (live && body.success && body.data?.setup) setSetup(body.data.setup as SetupView);
      })
      // Still: ein Fehler beim Laden dieses Hinweises gehört nicht als Fläche über die Übersicht.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [apiFetch]);

  if (!setup || setup.status !== 'open' || setup.step === 'done') return null;

  async function skip() {
    // Übersprungen ist endgültig: die Einrichtung lässt sich danach nicht wieder öffnen.
    const confirmed = await confirm({
      title: t('Einrichtung überspringen?'),
      message: t(
        'Danach lässt sie sich nicht wieder öffnen. Adresse und Art der Installation stellen Sie unter „Allgemein“ ein, Ziele unter „Reverse-Proxy“.'
      ),
      confirmLabel: t('Überspringen'),
      variant: 'warning',
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const res = await apiFetch('/api/setup/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'skipped' }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.error || t('Das ließ sich nicht speichern.'));
      setSetup(body.data.setup as SetupView);
      notify({
        variant: 'success',
        message: t('Die Einrichtung ist übersprungen. Adresse und Art der Installation stehen unter „Allgemein“.'),
      });
    } catch (err: unknown) {
      notify({ variant: 'error', message: errorText(err, t('Das ließ sich nicht speichern.')) });
    } finally {
      setBusy(false);
    }
  }

  const position = SETUP_STEPS.indexOf(setup.step as (typeof SETUP_STEPS)[number]) + 1;

  return (
    <div className="alert alert-info sys-block hapm-flag">
      <ListChecks size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>{t('Einrichtung abschließen')}</strong>
        <span>
          {t('Es fehlt noch Schritt {step} von {total}: {name}.', {
            step: position,
            total: SETUP_STEPS.length,
            name: setup.step in STEP_NAMES ? t(STEP_NAMES[setup.step as keyof typeof STEP_NAMES]) : setup.step,
          })}
        </span>
      </div>
      <div className="hapm-flag-actions">
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={skip}>
          {t('Überspringen')}
        </button>
        <Link className="btn btn-primary btn-sm" href="/setup">
          {t('Einrichtung fortsetzen')}
          <ArrowRight size={14} strokeWidth={1.5} />
        </Link>
      </div>
    </div>
  );
}
