'use client';

import { useId } from 'react';
import { RotateCcw } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { isHexColor } from '@/ui/static/page';

/**
 * Eine Farbe: Farbwahl des Browsers und daneben dieselbe Farbe als `#rrggbb`.
 *
 * `value` ist, was im Feld steht, auch mitten im Tippen. Ob es eine Farbe ist,
 * entscheidet die Prüfung des ganzen Formulars (`parsePageDesign`), nicht dieses
 * Feld: sonst gäbe es zwei Meinungen darüber, was sich speichern lässt.
 * `null` heißt Vorgabe.
 */
interface ColorFieldProps {
  label: string;
  hint?: string;
  value: string | null;
  /** Die Farbe der Seite, solange nichts gesetzt ist. */
  fallback: string;
  onChange: (value: string | null) => void;
}

export default function ColorField({ label, hint, value, fallback, onChange }: ColorFieldProps) {
  const id = useId();
  const invalid = value !== null && !isHexColor(value);

  return (
    <div className="form-group">
      <div className="form-label-row">
        <label className="form-label" htmlFor={id}>
          {label}
        </label>
        {hint && <InfoHint text={hint} />}
      </div>
      <div className="hapm-color">
        <input
          type="color"
          className="hapm-color-swatch"
          aria-label={`${label} wählen`}
          // Die Farbwahl kennt nur gültige Werte. Steht im Feld gerade keiner,
          // zeigt sie die Vorgabe.
          value={value !== null && isHexColor(value) ? value.toLowerCase() : fallback}
          onChange={(event) => onChange(event.target.value)}
        />
        <input
          id={id}
          className="form-input mono"
          value={value ?? ''}
          placeholder={fallback}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value.trim() === '' ? null : event.target.value.trim())}
        />
        <button
          type="button"
          className="btn btn-ghost btn-icon"
          data-tooltip="Zurück auf die Vorgabe"
          aria-label={`${label}: zurück auf die Vorgabe`}
          disabled={value === null}
          onClick={() => onChange(null)}
        >
          <RotateCcw size={16} />
        </button>
      </div>
      {invalid && <span className="form-hint">Eine Farbe hat die Form #rrggbb, zum Beispiel {fallback}.</span>}
    </div>
  );
}
