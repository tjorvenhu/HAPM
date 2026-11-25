'use client';

import { Check, Circle, Loader2, X } from 'lucide-react';
import { useT } from '@/lib/i18n/react';
import type { HaproxyStep } from '@/lib/types';

/**
 * Die Schritte eines Laufs untereinander: die fertigen mit Ergebnis, dahinter
 * die noch kommenden, der erste davon läuft gerade. Im Fenster der Läufe und in
 * den aufgeklappten Zeilen der Historie.
 */
export default function RunStepList({ steps, pending = [] }: { steps: HaproxyStep[]; pending?: readonly string[] }) {
  const { t } = useT();
  if (steps.length === 0 && pending.length === 0) {
    return <p className="form-hint">{t('Zu diesem Lauf sind keine Schritte festgehalten.')}</p>;
  }
  return (
    <ul className="hapm-steps">
      {steps.map((step, index) => (
        <li key={`${index}-${step.label}`} className={`hapm-step ${step.ok ? 'is-ok' : 'is-failed'}`}>
          {step.ok ? <Check size={14} strokeWidth={1.5} /> : <X size={14} strokeWidth={1.5} />}
          <span className="hapm-step-text">
            <span className="hapm-step-label">{t(step.label)}</span>
            {step.detail && <span className="hapm-step-detail">{t(step.detail)}</span>}
          </span>
        </li>
      ))}
      {pending.map((label, index) => (
        <li key={`pending-${label}`} className={`hapm-step ${index === 0 ? 'is-running' : 'is-pending'}`}>
          {index === 0 ? (
            <Loader2 size={14} strokeWidth={1.5} className="spin" />
          ) : (
            <Circle size={14} strokeWidth={1.5} />
          )}
          <span className="hapm-step-text">
            <span className="hapm-step-label">{t(label)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
