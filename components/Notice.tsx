'use client';

import { useEffect, useRef } from 'react';
import { useToast } from './Toast';

/**
 * Das Ergebnis einer Handlung — seit den Toasts keine Fläche mehr, sondern eine
 * Meldung unten rechts.
 *
 * Die Komponente rendert nichts. Sie bleibt, weil acht Seiten ihren Ausgang in
 * `useState<NoticeState>` halten und `<Notice notice={notice} />` an ihre Stelle
 * setzen: hier eine Zeile zu ändern, hat alle acht umgestellt, ohne dass in
 * jeder Seite dieselbe Änderung noch einmal gemacht (und einmal vergessen)
 * werden musste.
 *
 * Vorher stand sie als `alert` über dem Inhalt und schob beim Erscheinen die
 * ganze Liste nach unten — wer gerade auf eine Karte zielte, klickte daneben.
 * Und sie blieb stehen, bis jemand etwas anderes tat; nach zehn Minuten stand
 * dort immer noch „gespeichert".
 *
 * Ausgelöst wird an der IDENTITÄT des Objekts, nicht an seinem Text: zweimal
 * hintereinander „Gespeichert" sind zwei Handlungen und sollen zwei Meldungen
 * sein. Deshalb halten die Aufrufer es in `useState` — ein bei jedem Rendern neu
 * gebautes Literal ergäbe eine Meldung je Rendervorgang.
 */
export type NoticeState = { type: 'success' | 'warning' | 'info'; text: string } | null;

export default function Notice({ notice }: { notice: NoticeState; style?: never }) {
  const { notify } = useToast();
  const shown = useRef<NoticeState>(null);

  useEffect(() => {
    if (!notice || shown.current === notice) return;
    shown.current = notice;
    notify({ message: notice.text, variant: notice.type });
  }, [notice, notify]);

  return null;
}
