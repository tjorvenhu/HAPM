'use client';

import { useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { useT } from '@/lib/i18n/react';

/**
 * Reiter einer Seite, deren Wahl in der Adresse steht (`?bereich=<schlüssel>`).
 *
 * Der erste Reiter steht ohne Parameter in der Adresse, damit der Link aus der
 * Seitenleiste und der auf den ersten Bereich derselbe ist. `replace` und nicht
 * `push`: wer durch die Reiter klickt, will mit einem Schritt zurück aus der
 * Seite heraus. `useSearchParams` verlangt eine Suspense-Grenze um die Seite,
 * sonst scheitert der Build.
 *
 * Die Wahl steht im Zustand, damit der Reiter beim Klick sofort wechselt und
 * nicht erst, wenn die Adresse nachgezogen ist. Ändert sich `bereich` in der
 * Adresse von außen (ein Link auf dieselbe Seite, die Suche), folgt der Zustand.
 */

export interface Area<K extends string> {
  key: K;
  /** Ein Schlüssel für `t()`, mit `msgid` markiert. */
  label: string;
  icon: LucideIcon;
}

export function useArea<K extends string>(
  areas: readonly Area<K>[],
  path: string,
  /** Anker älterer Links (`#…`), die auf eine Karte zeigten, die jetzt in einem Reiter steht. */
  anchors: Partial<Record<string, K>> = {}
): [K, (next: K) => void] {
  const router = useRouter();
  const searchParams = useSearchParams();
  const first = areas[0].key;

  const wanted = searchParams.get('bereich');
  const fromAddress = areas.find((entry) => entry.key === wanted)?.key ?? first;

  const [area, setArea] = useState<K>(() => {
    const anchor = typeof window !== 'undefined' ? anchors[window.location.hash.slice(1)] : undefined;
    return anchor ?? fromAddress;
  });
  const [seen, setSeen] = useState(wanted);
  if (wanted !== seen) {
    setSeen(wanted);
    setArea(fromAddress);
  }

  const select = useCallback(
    (next: K) => {
      setArea(next);
      router.replace(next === first ? path : `${path}?bereich=${next}`, { scroll: false });
    },
    [router, path, first]
  );

  return [area, select];
}

/**
 * Die Bewegung beim Wechsel eines Reiters: eine Klasse für die Leiste der
 * Reiter (`.tabs`), nach der alles darunter kurz einblendet
 * (`ui/css/tool-vocabulary.css`, „Wechsel des Reiters").
 *
 * Die Klasse wechselt bei jedem neuen Reiter zwischen zwei gleichen
 * Animationen: ein anderer Name startet die Bewegung neu, ohne dass der Inhalt
 * neu aufgebaut wird (ein `key` um den Inhalt verlöre getippte Eingaben).
 * Vor dem ersten Wechsel gibt es keine: beim Laden bewegt sich schon die Seite.
 * Jede Leiste aus Reitern nimmt das, auch die ohne `AreaTabs`.
 */
export function useTabMotion(value: string): string {
  const [state, setState] = useState<{ value: string; flip: 0 | 1 | 2 }>({ value, flip: 0 });
  if (state.value !== value) setState({ value, flip: state.flip === 1 ? 2 : 1 });
  return state.flip === 0 ? '' : state.flip === 1 ? 'tabs-switched-a' : 'tabs-switched-b';
}

export default function AreaTabs<K extends string>({
  areas,
  value,
  onChange,
  dirty,
}: {
  areas: readonly Area<K>[];
  value: K;
  onChange: (next: K) => void;
  /** Ob auf diesem Reiter etwas getippt ist, das noch nicht gespeichert ist. */
  dirty?: (key: K) => boolean;
}) {
  const { t } = useT();
  const motion = useTabMotion(value);
  return (
    <div className={`tabs ${motion}`} role="tablist">
      {areas.map((entry) => {
        const Icon = entry.icon;
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={value === entry.key}
            className={`tab ${value === entry.key ? 'active' : ''}`}
            onClick={() => onChange(entry.key)}
          >
            <Icon size={15} />
            {t(entry.label)}
            {dirty?.(entry.key) && <span className="hapm-tab-dot" aria-label={t('Ungespeicherte Änderungen')} />}
          </button>
        );
      })}
    </div>
  );
}
