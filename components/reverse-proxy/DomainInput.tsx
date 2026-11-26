'use client';

import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Globe } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useMountedLoad } from '@/components/useMountedLoad';
import { suggestDomains } from '@/lib/dns/zones';
import { useT } from '@/lib/i18n/react';

export interface ZoneName {
  name: string;
  provider: string;
}

/**
 * Die angebundenen Zonen, einmal je Dialog geladen. Ohne Antwort gibt es keine
 * Vorschläge, und das Feld bleibt ein gewöhnliches Feld.
 */
export function useZoneNames(): ZoneName[] {
  const { apiFetch } = useApp();
  const [zones, setZones] = useState<ZoneName[]>([]);
  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/dns/zones/names');
      const body = await res.json();
      if (body.success) setZones((body.data?.zones ?? []) as ZoneName[]);
    } catch {
      // Die Vorschläge sind eine Hilfe, kein Teil der Eingabe.
    }
  }, [apiFetch]);
  useMountedLoad(load);
  return zones;
}

/**
 * Ein Domainfeld, das die angebundenen Zonen vorschlägt (`suggestDomains`).
 *
 * Wer `app` tippt, bekommt `app.<Zone>` angeboten. Ein Vorschlag mit führendem
 * Punkt (leeres Feld) setzt die Zone und stellt die Marke davor: der Name
 * fehlt noch. Die Liste sieht aus wie die der Auswahlliste (`custom-select-*`),
 * damit es im Dialog nur eine Art aufklappender Liste gibt.
 *
 * Mit der Maus gewählt wird beim Drücken, nicht beim Loslassen: sonst verlöre
 * das Feld vorher den Fokus und die Liste wäre weg.
 */
export default function DomainInput({
  value,
  onChange,
  zones,
  placeholder,
  disabled = false,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  zones: readonly ZoneName[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const { t } = useT();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const suggestions = open ? suggestDomains(value, zones.map((zone) => zone.name)) : [];
  const shown = suggestions.length > 0;
  const current = Math.min(active, Math.max(0, suggestions.length - 1));

  function pick(entry: string) {
    onChange(entry);
    setOpen(false);
    // Zone ohne Namen davor: die Marke an den Anfang, dort wird weitergetippt.
    if (entry.startsWith('.')) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(0, 0);
        setOpen(false);
      });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!shown) {
      if (event.key === 'ArrowDown') setOpen(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter') {
      // Enter schickte sonst das Formular ab, mit der halben Domain im Feld.
      // Tab wählt nichts: wer weitergeht, hat getippt, was er meint.
      event.preventDefault();
      pick(suggestions[current]);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="custom-select hapm-domain-input">
      <input
        ref={inputRef}
        className="form-input"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
      />
      {shown && (
        <div className="custom-select-dropdown" id={listId} role="listbox" aria-label={t('Vorschläge aus Ihren DNS-Zonen')}>
          {suggestions.map((entry, index) => (
            <div
              key={entry}
              role="option"
              aria-selected={index === current}
              className={`custom-select-option${index === current ? ' active' : ''}`}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(entry);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <Globe size={14} className="icon" />
              <span className="mono">{entry.startsWith('.') ? `…${entry}` : entry}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
