'use client';

import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { useT } from '@/lib/i18n/react';

/**
 * Die Schritte des Assistenten als Punkte mit Namen, verbunden durch eine
 * Linie, die bis zum aktuellen Schritt gefüllt ist. Erledigte Punkte tragen
 * einen Haken, der aktuelle pulsiert leise.
 *
 * Die Namen kommen von der Seite (`labels`) und nicht aus einer eigenen
 * Liste: kommt ein Schritt dazu, steht er hier, ohne dass diese Datei es weiß.
 * Auf schmalen Bildschirmen bleiben nur die Punkte und der Name des aktuellen.
 */
export function SetupStepper({ labels, current }: { labels: string[]; current: number }) {
  const { t } = useT();
  const total = labels.length;
  const fill = total > 1 ? current / (total - 1) : 1;

  return (
    <div className="hapm-stepper">
      <span className="hapm-stepper-count">
        {t('Schritt {step} von {total}', { step: current + 1, total })}
      </span>
      <ol style={{ '--fill': fill, '--count': total } as CSSProperties}>
        {labels.map((label, index) => {
          const state = index < current ? 'is-done' : index === current ? 'is-current' : 'is-next';
          return (
            <li key={label} className={STEP_CLASS[state]} aria-current={index === current ? 'step' : undefined}>
              <span className="hapm-stepper-dot">
                {index < current ? <Check size={12} strokeWidth={3} /> : index + 1}
              </span>
              <span className="hapm-stepper-label">{label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Ausgeschrieben, damit `tests/ui/css-classes.test.ts` jede Klasse findet. */
const STEP_CLASS = {
  'is-done': 'is-done',
  'is-current': 'is-current',
  'is-next': 'is-next',
} as const;
