'use client';

import type { ReactNode } from 'react';
import { ArrowRight, Loader2, type LucideIcon } from 'lucide-react';
import { useTabMotion } from '@/components/AreaTabs';
import { useT } from '@/lib/i18n/react';

/**
 * Schrittleiste und Fuß eines geführten Dialogs (Ziel anlegen, TCP-Weiterleitung).
 *
 * Die Schritte sind Reiter: man darf springen, und alles bleibt im Zustand des
 * Formulars. Gelesen werden sie als Ablauf: oben die Leiste über die ganze
 * Breite, unten „Schritt 2 von 4" und der Knopf, der den nächsten Schritt beim
 * Namen nennt. Das Aussehen steht in `ui/css/tool-vocabulary.css`
 * („Geführter Dialog"), die Regel dazu in `docs/oberflaeche.md`.
 */
export interface FormStep<K extends string> {
  key: K;
  /** Deutsche Schlüssel (`msgid`), übersetzt wird beim Zeigen. */
  label: string;
  /** Der Knopf, der zu diesem Schritt führt: „Weiter zum Ziel". */
  next: string;
  icon: LucideIcon;
  /** Was in dem Schritt eingestellt ist, als Zahl an seinem Namen. */
  count?: number;
}

export function FormSteps<K extends string>({
  steps,
  value,
  onChange,
}: {
  steps: readonly FormStep<K>[];
  value: K;
  onChange: (next: K) => void;
}) {
  const { t } = useT();
  const motion = useTabMotion(value);
  return (
    <div className={`tabs form-tabs form-steps ${motion}`} role="tablist">
      {steps.map((entry) => {
        const Icon = entry.icon;
        return (
          <button
            key={entry.key}
            type="button"
            role="tab"
            aria-selected={value === entry.key}
            className={`tab ${value === entry.key ? 'active' : ''}`}
            onClick={() => onChange(entry.key)}
            // Auf dem Handy trägt nur der gewählte Schritt seinen Namen sichtbar.
            aria-label={t(entry.label)}
          >
            <Icon size={15} />
            <span className="form-step-label">{t(entry.label)}</span>
            {(entry.count ?? 0) > 0 && <span className="section-count">{entry.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Der Fuß: links der Fortschritt, rechts Abbrechen, der Weg zum nächsten
 * Schritt und der Knopf zum Absenden.
 *
 * Absenden geht aus jedem Schritt, sobald nichts mehr fehlt (`submitReady`):
 * spätere Schritte sind oft Zusätze, durch die niemand klicken muss. Solange
 * etwas fehlt, ist der Weg zum nächsten Schritt der eine betonte Knopf.
 */
export function FormWizardFooter<K extends string>({
  steps,
  value,
  onChange,
  onClose,
  saving,
  submitReady,
  submitLabel,
  submitIcon,
}: {
  steps: readonly FormStep<K>[];
  value: K;
  onChange: (next: K) => void;
  onClose: () => void;
  saving: boolean;
  submitReady: boolean;
  /** Schon übersetzt: „Anlegen" oder „Speichern". */
  submitLabel: string;
  submitIcon?: ReactNode;
}) {
  const { t } = useT();
  const index = Math.max(0, steps.findIndex((entry) => entry.key === value));
  const next = steps[index + 1] ?? null;
  return (
    <div className="modal-footer form-wizard-foot">
      <div className="form-wizard-progress" aria-hidden="true">
        <span>{t('Schritt {step} von {total}', { step: index + 1, total: steps.length })}</span>
        <span className="form-wizard-bars">
          {steps.map((entry, at) => (
            <span key={entry.key} className={at <= index ? 'form-wizard-bar is-done' : 'form-wizard-bar'} />
          ))}
        </span>
      </div>
      <div className="form-wizard-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
          {t('Abbrechen')}
        </button>
        {next && (
          <button
            type="button"
            className={submitReady ? 'btn btn-secondary' : 'btn btn-primary'}
            onClick={() => onChange(next.key)}
            disabled={saving}
          >
            {t(next.next)}
            <ArrowRight size={16} />
          </button>
        )}
        {(submitReady || !next) && (
          <button type="submit" className="btn btn-primary" disabled={saving || !submitReady}>
            {saving ? <Loader2 size={16} className="spin" /> : submitIcon}
            {submitLabel}
          </button>
        )}
      </div>
    </div>
  );
}
