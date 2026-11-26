'use client';

import type { ReactNode } from 'react';
import { CircleAlert, Info } from 'lucide-react';

export type FormHintTone = 'info' | 'warning' | 'danger';

/** Ausgeschrieben, damit `tests/ui/css-classes.test.ts` jede Klasse findet. */
const TONE_CLASS: Record<FormHintTone, string> = {
  info: 'alert alert-info form-hint-bar',
  warning: 'alert alert-warning form-hint-bar',
  danger: 'alert alert-danger form-hint-bar',
};

/**
 * Die Hinweiszeile am Fuß eines Formulars: was noch fehlt oder was die Prüfung
 * vor dem Absenden beanstandet, mit Symbol, in einer Zeile.
 *
 * Eine Stelle für alle Formulare (Dialoge der Ziele, Assistent der
 * Einrichtung), damit „hier fehlt noch etwas" überall gleich aussieht und am
 * selben Ort steht: unten, wo der Blick beim Ausfüllen endet und der Knopf zum
 * Weitergehen sitzt. `warning` für das, was noch fehlt, `danger` für eine
 * Eingabe, die so nicht geht, `info` für eine Auskunft ohne Folge.
 *
 * Die Absage des Servers nach dem Absenden steht nicht hier, sie ist ein Toast
 * (docs/oberflaeche.md, „Meldungen").
 */
export default function FormHint({ tone = 'warning', children }: { tone?: FormHintTone; children: ReactNode }) {
  return (
    <div className={TONE_CLASS[tone]} role={tone === 'danger' ? 'alert' : 'status'}>
      {tone === 'info' ? <Info size={16} /> : <CircleAlert size={16} />}
      <span>{children}</span>
    </div>
  );
}
