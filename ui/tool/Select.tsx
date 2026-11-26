'use client';

import { useState, useRef, useEffect, useLayoutEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '@/lib/i18n/react';
import { ChevronDown } from 'lucide-react';
import { usePresence } from '../shell/usePresence';

/**
 * Dropdown primitive over the .custom-select classes.
 *
 * CSS alone is not enough: with the classes but no component, one page uses
 * them and every other one falls back to a raw <select>. A primitive that has
 * to be hand-assembled per page does not survive contact with the second page.
 *
 * The list floats in `document.body` (portal, `position: fixed`) and not
 * below the trigger in the DOM: inside a dialog the body scrolls
 * (`overflow-y: auto`), and an absolutely placed list was cut off at its
 * bottom edge, so one had to scroll inside the dialog to reach it. Where there
 * is not enough room below, it opens upwards.
 */

/** Gap between trigger and list, and minimum distance to the window edge. */
const GAP = 6;
/** Height the list wants at most (the 240 px from the stylesheet), plus the search field. */
const LIST_MAX = 240;
const SEARCH_EXTRA = 52;

/** Where the floating list goes: below or above the trigger, as wide as it. */
function placement(trigger: HTMLElement, searchable: boolean): CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const wanted = LIST_MAX + (searchable ? SEARCH_EXTRA : 0);
  const below = window.innerHeight - rect.bottom - GAP * 2;
  const above = rect.top - GAP * 2;
  const up = below < Math.min(wanted, 180) && above > below;
  const room = Math.max(120, Math.min(wanted, up ? above : below));
  return {
    position: 'fixed',
    left: rect.left,
    width: rect.width,
    maxHeight: room,
    ...(up ? { bottom: window.innerHeight - rect.top + GAP, top: 'auto' } : { top: rect.bottom + GAP }),
    transformOrigin: up ? 'bottom center' : 'top center',
  };
}

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
  /** A filter field at the top of the list, for long lists (countries).
   *  Matches label and value, case-insensitive. */
  searchable?: boolean;
  searchPlaceholder?: string;
}

export default function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  emptyText,
  disabled = false,
  id,
  searchable = false,
  searchPlaceholder,
}: SelectProps<T>) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Die Liste bleibt beim Schließen noch so lange im Baum, wie sie ausblendet.
  const { mounted, closing } = usePresence(open);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  // Folgt dem Auslöser, wenn der Dialog oder die Seite scrollt oder das Fenster
  // seine Größe ändert. `capture`: auch das Scrollen eines inneren Kastens.
  useLayoutEffect(() => {
    if (!mounted) return;
    const place = () => {
      if (triggerRef.current) setPosition(placement(triggerRef.current, searchable));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [mounted, searchable]);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
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

  // Leer beim nächsten Öffnen: ein stehengebliebener Filter zeigte sonst eine
  // Liste, in der scheinbar Einträge fehlen.
  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter(
        (o) => o.label.toLowerCase().includes(needle) || o.value.toLowerCase().includes(needle)
      )
    : options;

  return (
    <div className="custom-select" ref={ref}>
      <button
        ref={triggerRef}
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
          <span className="placeholder">{placeholder ?? t('Bitte auswählen…')}</span>
        )}
        <ChevronDown size={16} className="chevron" />
      </button>

      {mounted && position && createPortal(
        <div
          ref={listRef}
          className={closing ? 'custom-select-dropdown is-floating is-closing' : 'custom-select-dropdown is-floating'}
          style={position}
          role="listbox"
          inert={closing}
        >
          {searchable && (
            <input
              className="form-input custom-select-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder ?? t('Suchen')}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const first = visible.find((o) => !o.disabled);
                if (first) {
                  onChange(first.value);
                  setOpen(false);
                }
              }}
            />
          )}
          {visible.length === 0 ? (
            <div className="custom-select-empty">
              {needle ? t('Kein Treffer') : (emptyText ?? t('Keine Einträge vorhanden'))}
            </div>
          ) : (
            visible.map((option) => (
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
        </div>,
        document.body
      )}
    </div>
  );
}
