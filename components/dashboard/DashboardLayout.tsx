'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, RotateCcw, X } from 'lucide-react';
import { useT } from '@/lib/i18n/react';

/**
 * Die Übersicht in Bereichen, die sich auf- und zuklappen, umsortieren und
 * ausblenden lassen.
 *
 * Mit CrowdSec kamen weitere Kennzahlen und Karten dazu, und eine Seite, auf
 * der alles untereinander steht, liest niemand mehr bis unten. Wer HAPM vor
 * allem für Zertifikate öffnet, holt sie nach oben; wer TCP-Weiterleitungen
 * nicht nutzt, klappt den Bereich zu. Gespeichert wird im Browser
 * (`localStorage`): die Anordnung ist eine Vorliebe am Arbeitsplatz und kein
 * Teil der Installation. Ein Bereich, den eine neue Fassung dazubringt,
 * erscheint an seiner Stelle der Vorgabe.
 */

const STORAGE_KEY = 'hapm-dashboard-layout-v1';

export interface DashLayout<K extends string> {
  order: K[];
  hidden: K[];
  collapsed: K[];
}

function readStored<K extends string>(defaults: readonly K[]): DashLayout<K> {
  const fallback: DashLayout<K> = { order: [...defaults], hidden: [], collapsed: [] };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<DashLayout<string>> | null;
    if (!raw || !Array.isArray(raw.order)) return fallback;
    const known = (list: unknown) => (Array.isArray(list) ? list.filter((k): k is K => defaults.includes(k as K)) : []);
    const order = known(raw.order);
    // Neue Bereiche einer neuen Fassung: hinter ihren Vorgänger in der Vorgabe.
    for (const [index, key] of defaults.entries()) {
      if (order.includes(key)) continue;
      const before = defaults.slice(0, index).reverse().find((k) => order.includes(k));
      order.splice(before ? order.indexOf(before) + 1 : 0, 0, key);
    }
    return { order, hidden: known(raw.hidden), collapsed: known(raw.collapsed) };
  } catch {
    return fallback;
  }
}

export function useDashboardLayout<K extends string>(defaults: readonly K[]) {
  const [layout, setLayoutState] = useState<DashLayout<K>>(() => readStored(defaults));

  const setLayout = useCallback((next: DashLayout<K>) => {
    setLayoutState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ohne Speicher gilt die Anordnung bis zum Neuladen.
    }
  }, []);

  const toggleCollapsed = useCallback(
    (key: K) => {
      const collapsed = layout.collapsed.includes(key)
        ? layout.collapsed.filter((k) => k !== key)
        : [...layout.collapsed, key];
      setLayout({ ...layout, collapsed });
    },
    [layout, setLayout]
  );

  const reset = useCallback(() => setLayout({ order: [...defaults], hidden: [], collapsed: [] }), [defaults, setLayout]);

  return { layout, setLayout, toggleCollapsed, reset };
}

/** Ein Bereich mit Überschrift. Zugeklappt bleibt nur die Überschrift stehen. */
export function DashSection({
  title,
  icon,
  collapsed,
  onToggle,
  tools,
  children,
}: {
  title: string;
  icon?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  tools?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="dash-section">
      <div className="dash-section-head">
        <button type="button" className="dash-section-title" onClick={onToggle} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          {icon}
          {title}
        </button>
        {tools && <span className="dash-section-tools">{tools}</span>}
      </div>
      {!collapsed && children}
    </section>
  );
}

/** Der Dialog „Übersicht anpassen": Reihenfolge und welche Bereiche zu sehen sind. */
export function LayoutDialog<K extends string>({
  layout,
  labels,
  onChange,
  onReset,
  onClose,
}: {
  layout: DashLayout<K>;
  labels: Record<K, string>;
  onChange: (next: DashLayout<K>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const { t } = useT();

  function move(index: number, by: -1 | 1) {
    const order = [...layout.order];
    const target = index + by;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    onChange({ ...layout, order });
  }

  function toggleHidden(key: K) {
    const hidden = layout.hidden.includes(key) ? layout.hidden.filter((k) => k !== key) : [...layout.hidden, key];
    onChange({ ...layout, hidden });
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title">{t('Übersicht anpassen')}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('Dialog schließen')}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          <p className="form-hint">{t('Reihenfolge und sichtbare Bereiche gelten für diesen Browser.')}</p>
          <div className="dash-layout-list">
            {layout.order.map((key, index) => (
              <div key={key} className="dash-layout-row">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={!layout.hidden.includes(key)}
                    onChange={() => toggleHidden(key)}
                    aria-label={t(labels[key])}
                  />
                  <span className="toggle-slider" />
                </label>
                <span className="dash-layout-name">{t(labels[key])}</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={t('Nach oben')}
                  data-tooltip={t('Nach oben')}
                >
                  <ArrowUp size={16} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => move(index, 1)}
                  disabled={index === layout.order.length - 1}
                  aria-label={t('Nach unten')}
                  data-tooltip={t('Nach unten')}
                >
                  <ArrowDown size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onReset}>
            <RotateCcw size={16} />
            {t('Vorgabe')}
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            {t('Fertig')}
          </button>
        </div>
      </div>
    </div>
  );
}
