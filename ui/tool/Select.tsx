'use client';

import { useState, useRef, useEffect, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/react';
import { ChevronDown } from 'lucide-react';
import { usePresence } from '../shell/usePresence';

/**
 * Dropdown primitive over the .custom-select classes.
 *
 * CSS alone is not enough: with the classes but no component, one page uses
 * them and every other one falls back to a raw <select>. A primitive that has
 * to be hand-assembled per page does not survive contact with the second page.
 */

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Secondary line, e.g. a host or a fingerprint. */
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Reason shown when disabled, as a short sentence for the user. */
  disabledReason?: string;
}

interface SelectProps<T extends string> {
  value: T | null;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  /** Shown in the dropdown when there is nothing to pick. */
  emptyText?: string;
  disabled?: boolean;
  id?: string;
}

export default function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  emptyText,
  disabled = false,
  id,
}: SelectProps<T>) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  // Die Liste bleibt beim Schließen noch so lange im Baum, wie sie ausblendet.
  const { mounted, closing } = usePresence(open);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className="custom-select" ref={ref}>
      <button
        type="button"
        id={id}
        className={`custom-select-trigger ${open ? 'open' : ''}`}
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selected ? (
          <>
            {selected.icon}
            <span className="custom-select-value" title={selected.label}>
              {selected.label}
            </span>
          </>
        ) : (
          <span className="placeholder">{placeholder ?? t('Bitte auswählen...')}</span>
        )}
        <ChevronDown size={16} className="chevron" />
      </button>

      {mounted && (
        <div
          className={closing ? 'custom-select-dropdown is-closing' : 'custom-select-dropdown'}
          role="listbox"
          inert={closing}
        >
          {options.length === 0 ? (
            <div className="custom-select-empty">
              {emptyText ?? t('Keine Einträge vorhanden')}
            </div>
          ) : (
            options.map((option) => (
              <div
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                className={`custom-select-option ${option.value === value ? 'active' : ''}`}
                style={
                  option.disabled ? { opacity: 0.45, cursor: 'not-allowed' } : undefined
                }
                data-tooltip={option.disabled ? option.disabledReason : undefined}
                onClick={() => {
                  if (option.disabled) return;
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.icon}
                <span className="custom-select-text">
                  {/*
                    Gekürzt wie der Hinweis darunter, und nicht nur der.
                    Eine nackte Beschriftung reicht hier nicht: ein Wort ohne
                    Leerzeichen (`kunden_shop_staging_intern`) bricht nicht
                    um, also würde die Liste breiter als ihr Kasten. Und weil
                    `overflow-y: auto` den Browser auch `overflow-x` auf `auto`
                    setzen lässt, bekäme die Auswahl eine waagerechte Leiste —
                    in einem Aufklappmenü die Sorte Bedienelement, die man beim
                    Zielen auf einen Eintrag versehentlich zieht.
                  */}
                  <span className="custom-select-label" title={option.label}>
                    {option.label}
                  </span>
                  {(option.hint || option.disabledReason) && (
                    <span
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-tertiary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {option.disabled ? option.disabledReason : option.hint}
                    </span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
