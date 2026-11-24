'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ListChecks } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { SETUP_STEPS } from '@/lib/setup/rules';
// Nur der Typ: die Datei dahinter erreicht `lib/db`.
import type { SetupView } from '@/lib/setup';

/**
 * Der Hinweis über der Übersicht, dass die Einrichtung noch offen ist.
 *
 * Das Konto besteht nach dem ersten Schritt des Assistenten, alles danach darf
 * scheitern oder liegen bleiben. Damit „später" nicht „nie" heißt, steht die
 * Fläche hier, bis die Einrichtung abgeschlossen oder ausdrücklich
 * übersprungen ist. Unter „Allgemein" lässt sie sich wieder öffnen.
 */

const STEP_NAMES: Record<string, string> = {
  exposure: 'Erreichbarkeit',
  dns: 'DNS-Anbieter',
  address: 'Adresse der Oberfläche',
  run: 'Einrichten',
};

export default function SetupReminder() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
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
    setBusy(true);
    try {
      const res = await apiFetch('/api/setup/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'skipped' }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.error || 'Das ließ sich nicht speichern.');
      setSetup(body.data.setup as SetupView);
      notify({
        variant: 'success',
        message: 'Die Einrichtung ist übersprungen. Unter „Allgemein" lässt sie sich erneut öffnen.',
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        message: err instanceof Error ? err.message : 'Das ließ sich nicht speichern.',
      });
    } finally {
      setBusy(false);
    }
  }

  const position = SETUP_STEPS.indexOf(setup.step as (typeof SETUP_STEPS)[number]) + 1;

  return (
    <div className="alert alert-info sys-block hapm-flag">
      <ListChecks size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>Einrichtung abschließen</strong>
        <span>
          Es fehlt noch Schritt {position} von {SETUP_STEPS.length}: {STEP_NAMES[setup.step] ?? setup.step}.
        </span>
      </div>
      <div className="hapm-flag-actions">
        <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={skip}>
          Überspringen
        </button>
        <Link className="btn btn-primary btn-sm" href="/setup">
          Einrichtung fortsetzen
          <ArrowRight size={14} strokeWidth={1.5} />
        </Link>
      </div>
    </div>
  );
}
